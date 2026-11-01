# Background Removal — Plan

## Goal

Remove the scenery behind the Pokémon in a card's artwork, so the coloring card
shows only the Pokémon's outlines on white. Painted backgrounds (sky, grass, holo
patterns, speed lines) currently become dense, noisy line art that is hard
for kids to color and buries the Pokémon.

Optional, per card or globally:

- **Off**: current behavior (whole artwork as line art).
- **Remove**: only the Pokémon's outlines; the rest of the art window stays white.
- **Fade**: Pokémon with normal lines, background with fewer and thinner lines
  (higher speck threshold, lower detail), so there is still some scenery to color.

Like the rest of the app, it has to run fully in the browser on GitHub Pages
(no backend), and it has to work offline after the first load.

## Where it fits

```
 normalize ──▶ find art window ──▶ art crop ──▶ [foreground mask] ──▶ line art ──▶ template
                                     (render.ts)   (new: segment.ts)     (lineart.ts)
```

- The mask is computed on the **art crop** (`artImage()` in `render.ts`, ART_FRAME
  size), not on the whole card. In "original" layout mode it is not used.
- The mask is applied as **alpha** on the art crop. `toGray` / `toChannel` already
  composite transparent pixels onto white, so `lineArt()` needs no change for
  "Remove": the background becomes flat white and produces no edges, and the
  Pokémon's silhouette becomes one clean outline.
- "Fade" runs `lineArt()` twice (Pokémon settings, background settings) and
  combines the two masks by the foreground mask.
- The mask depends only on the image, not on the line settings, so it is computed
  **once per card and cached** (with the `card` object in `main.ts`). Moving the
  sliders must not rerun segmentation.

## Approach: ML segmentation in the browser

Classic methods were considered and rejected as the main approach:

| Method | Problem on card art |
|---|---|
| Flood fill / color key from the crop border | backgrounds are painted gradients and textures, not flat colors |
| GrabCut (with the art window border as "background") | slow in JS, poor on low-contrast or stylized art, needs tuning per era |
| Saliency from edges/colors | picks up the busy background as much as the Pokémon |

A salient-object / background-removal network handles this well, including
illustrated art. It runs with **onnxruntime-web** (WebGPU, falling back to WASM).

### Model candidates

| Model | Size (ONNX) | License | Notes |
|---|---|---|---|
| U²-Net-p (`u2netp`) | ~4.5 MB | Apache-2.0 | small and fast, soft edges, weaker on cartoon art |
| IS-Net general-use (DIS) | ~170 MB fp32 / ~45 MB fp16 / ~ 44 MB int8 | Apache-2.0 | good on illustrations, sharp masks |
| IS-Net anime (`isnet-anime`) | ~170 MB fp32 | Apache-2.0 | trained on anime characters, likely the best fit for card art |
| BiRefNet (lite) | ~ 180 MB+ | MIT | best quality, heavy for the browser |
| BRIA RMBG-1.4 / 2.0 | ~45 MB int8 | **CC BY-NC** / custom | good, but non-commercial license; avoid |
| `@imgly/background-removal` | wraps IS-Net | **AGPL** | convenient, but license would force AGPL on the app |

**Plan:** prototype with `isnet-anime` and IS-Net general (quantized to fp16/int8)
and `u2netp` as the lightweight option; pick by a test set (see below). Use
onnxruntime-web directly rather than a wrapper library, to keep license and
bundle under control.

### Model hosting and loading

- Model files are not bundled in the JS. Load on demand, the first time a user
  turns background removal on, with a progress bar ("Downloading model, 45 MB").
- Host options: a GitHub release asset or the Hugging Face hub (both send CORS
  headers). GitHub Pages itself has a 100 MB per-file limit, so a quantized model
  can also live in the repo under `public/models/` if it's small enough.
- Cache the model with the **Cache API** so later visits load instantly and work
  offline.
- Run inference in a **Web Worker** so the UI stays responsive; the worker owns the
  ONNX session and processes cards one at a time.
- onnxruntime-web's WASM files are served from the build (Vite `?url` imports or
  copied to `public/`), not a CDN.

## Pipeline details (`src/segment.ts`)

1. **Input**: the art crop (ImageData, ART_FRAME size).
2. **Preprocess**: resize to the model's input (1024² for IS-Net, 320² for U²-Net),
   normalize (mean/std as the model expects), HWC → CHW `Float32Array`.
3. **Inference** in the worker → probability map (0..1).
4. **Postprocess** (plain TS, unit-testable without the model):
   - resize the map back to the crop size (bilinear)
   - threshold (default 0.5) to a binary mask
   - keep the largest connected components (drop small background blobs; keep
     several large ones for cards with multiple Pokémon)
   - fill holes inside the Pokémon (eyes, mouth, gaps between limbs that are fully
     enclosed)
   - small dilation (2–4 px) so the silhouette outline isn't cut off by the threshold
   - optional feather for the alpha so the outline edge is not jagged
5. **Output**: `Uint8Array` mask (1 = Pokémon), cached per card.

Card-specific details:

- **Art border**: the crop already has a 5 px inset; check that the art window's
  frame never ends up in the foreground.
- **Pokémon cut off by the art window**: the silhouette touches the crop edge. Draw
  no line along the edge (the template's artwork frame already does).
- **Attacks/effects** (fire, water, beams): the model may count them as foreground or
  not. Accept either; the "Fade" mode covers it.
- **Full-art / illustration-rare cards**: the "art crop" is the default window or the
  whole card; segmentation helps most here, because the scenery is the largest part.
- **Trainer and energy cards**: no single subject; leave background removal off by
  default for them (TCGdex `category`).

## UI

- A "Background" setting next to the line presets: **Keep / Fade / Remove**.
- Global default plus a per-card override in the card's settings (some cards look
  better with the scenery).
- First enable: confirm the model download size; show progress, then process all
  cards (each card shows a spinner until its mask is ready).
- If WebGPU and WASM both fail, or the model download fails: show a message and keep
  "Keep" behavior; never block the PDF export.
- **Manual touch-up** (later milestone): brush to add/remove areas of the mask on
  the card preview, stored per card.

## Testing

- **Unit tests** (vitest, no model): mask postprocessing (largest components, hole
  filling, dilation), mask → alpha application, "Fade" mask combination, and that a
  transparent background really produces no edges in `lineArt()`.
- **Model test set**: ~20 cards spanning eras and styles: WotC base set, EX era,
  Sun & Moon, Scarlet & Violet, full-art, illustration rare, cards with two
  Pokémon, cards with big attack effects, dark/night backgrounds, and a few with
  low-contrast Pokémon (e.g. white Pokémon on snow). Compare models by eye on a
  dev-only page that shows original, mask overlay and resulting coloring card side
  by side. Record the choice and timings in this file.
- **Performance target**: < 2 s per card with WebGPU, < 8 s with WASM on a mid-range
  laptop; 9 cards (one page) in under a minute on WASM.

## Model evaluation (2026-11-01)

Offline run with ONNX Runtime (CPU, 12 cores) on 200 artwork crops, ~11 per series
from Base Set to Mega Evolution (incl. TCG Pocket).

```sh
npx vite-node scripts/fetch-testset.ts          # testdata/*.png + manifest.json (art crops only)
.venv/bin/python scripts/segment.py [model ...]  # testdata/{model}/{config}/*.png (RGBA, alpha = mask)
```

Configs are `{variant}-{fit}-{post}`: variant = fp32 or a quantized file; fit =
`stretch` (squash to the model's square input) or `pad` (keep aspect, extend edge
pixels; a flat gray letterbox made models select the whole artwork); post = `raw`
(soft mask) or `clean` (threshold 0.5, drop small blobs, fill holes, dilate 2 px).
Preprocessing follows rembg (incl. min–max rescaling of the output).

Rough failure counts (no ground truth): *empty* = mask < 3 % of the art, *all* =
mask > 85 %, i.e. the background was kept.

| Model / config (clean) | Empty | All | Size | CPU s/img |
|---|---|---|---|---|
| birefnet-lite fp32-stretch | 0 | 2 | 224 MB | 12.1 |
| birefnet-lite fp32-pad | 1 | 14 | 224 MB | 10.2 |
| rmbg-1.4 fp32-stretch | 0 | 20 | 176 MB | 1.4 |
| rmbg-1.4 quantized-stretch | 0 | 19 | 44 MB | 2.2 |
| rmbg-1.4 fp32-pad | 0 | 58 | 176 MB | 1.4 |
| isnet-general fp32-stretch | 17 | 0 | 179 MB | 1.3 |
| isnet-general quint8-stretch (imgly file) | 17 | 0 | 44 MB | 1.9 |
| isnet-general fp32-pad | 10 | 2 | 179 MB | 1.3 |
| u2netp fp32-stretch | 7 | 2 | 4.6 MB | 0.2 |
| u2netp fp32-pad | 2 | 4 | 4.6 MB | 0.2 |
| isnet-anime fp32-stretch | 115 | 11 | 176 MB | 1.4 |

Findings, from comparison sheets of ~24 hand-picked cards plus the counts:

- **BiRefNet-lite** is clearly the best: complete Pokémon including thin parts (Scyther's
  wings, Raikou's tail, Meowth's whiskers) with clean edges, and it rarely keeps the
  background. Downside: 224 MB and ~10× slower than the others.
- **RMBG-1.4** keeps the Pokémon complete but often keeps background too (Horsea's
  bubbles, Charmander's flames, Gastly's purple panel). Non-commercial license: ruled out
  for the app anyway.
- **IS-Net general** is too conservative: it often keeps only part of the Pokémon
  (Bulbasaur's bulb, two of Magneton's three heads, half of Raikou) or nothing.
- **U²-Net-p** is surprisingly usable for 4.6 MB: good on clear single Pokémon, soft or
  partial on busy art.
- **IS-Net anime** is unusable: it finds nothing on most cards (trained on anime-style
  people, not creatures). Different input normalizations didn't help.
- **Quantization** costs no visible quality (IS-Net quint8, RMBG quantized ≈ fp32), but is
  slower on CPU. It is worth it for download size.
- **stretch vs pad**: `pad` helps when the Pokémon fills the frame (Bulbasaur, Entei) but
  more often keeps the whole artwork. Use `stretch`.
- **clean** removes faint halos and stray blobs; keep it.
- Hard cases for every model: Pokémon cropped by the frame (Bulbasaur, Entei, Dialga),
  art dominated by effects (Moltres in flames), single-color special art (gold cards),
  full-art cards whose "art window" contains text.

For a coloring card, a missing part of the Pokémon is worse than leftover background
(lines can still be colored, missing lines cannot). That favors generous models.

**Next:** test BiRefNet-lite in fp16 (`onnx-community/BiRefNet_lite-ONNX`, 115 MB) and
its speed in the browser with WebGPU vs WASM. If it is fast enough, it becomes the
model, with U²-Net-p as a small fallback. Otherwise, use U²-Net-p, with "Fade" as the
default so partial masks don't lose detail.

## Milestones

1. ⬜ Prototype: onnxruntime-web + one model on a dev page, mask overlay on a few
   cards. Decide whether ML quality is good enough to continue.
   ✅ Offline evaluation of the candidates on 200 cards (see above): quality is good
   enough with BiRefNet-lite, usable with U²-Net-p.
2. ⬜ Model choice on the test set (quality, size, speed); quantize; decide hosting.
   ⬜ Remaining: browser speed of BiRefNet-lite fp16 vs U²-Net-p.
3. ✅ First version with **U²-Net-p** (4.6 MB, bundled in `public/models/`, Apache-2.0):
   `segment.ts` + `segment.worker.ts` (onnxruntime-web, WASM, own Web Worker), loaded
   only when the background isn't kept. No progress bar / Cache API needed at this size;
   the browser's HTTP cache keeps the model and the 15 MB WASM runtime.
4. ✅ Mask postprocessing (`mask.ts`, unit-tested) + "Remove" in `render.ts`.
5. ✅ UI: global *Background: Keep / Fewer lines / Remove*, persisted in settings, default
   "Fewer lines" (forgiving when U²-Net-p only finds part of the Pokémon).
   ⬜ Per-card override.
6. ✅ "Fade" mode: background with smoother, fewer, thinner lines (`fadedSettings`).
7. ⬜ Better model (BiRefNet-lite fp16 with WebGPU, see evaluation), per-card override.
8. ⬜ Optional: manual mask brush; mask for full-art cards on the whole card.

## Open questions

- Is a ~45 MB one-time download acceptable, or should the default be the small
  `u2netp` with the larger model as an "HQ" option?
- Should "Remove" become the default once it is reliable?
- Does the Pokémon outline alone leave too little to color on simple cards
  (e.g. Basic Pokémon with small art)? "Fade" may be the better default.

## Notes

- Model licenses must allow use in this project (Apache-2.0 / MIT); avoid
  CC BY-NC and AGPL dependencies.
- Card images never leave the browser; inference is local.
