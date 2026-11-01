# Line Art for Coloring — Plan

## Goal

Turn the Pokémon cutout (art crop + foreground mask from
[BACKGROUND_REMOVAL.md](BACKGROUND_REMOVAL.md)) into a clean black-and-white
coloring picture that a child can color with crayons:

- one **closed, smooth outer outline** around the Pokémon
- interior lines only where the artist drew them or where the **color changes**
  (body vs. belly, eyes, claws), not where the shading changes
- **closed areas**: every line ends at another line, so each area can be colored
  without "leaks"
- **even, confident strokes**: no wobble, no double lines, no short hair strokes
- areas big enough for crayons; a **simple** and a **detailed** level

Scope: only the line-art step. The input is an RGBA art crop whose alpha is a good
foreground mask. While developing, use only the test cards with a clean mask
(see *Test set*). Mask quality is not part of this plan.

## What the current algorithm does wrong

`lineArt()` in `src/lineart.ts` is blur → Sobel (RGB) → Canny → remove specks →
dilate. On clean cutouts (e.g. `swsh8-204`, `base2-25`, `sm11-147`, `dp3-76`):

| Problem | Cause |
|---|---|
| **Double lines** along every inked outline | Canny finds *both* sides of a dark ink line (light→dark and dark→light) |
| **Shading becomes lines** (muscle shading, highlights, fur strokes, holo glints) | gradient magnitude can't tell a lightness change in one color from a border between two colors |
| **Broken outlines, open areas** | hysteresis stops at weak spots; nothing closes gaps |
| **Wobbly, jagged strokes** | raster edges at the low source resolution (art is ~500 px wide), then dilated pixel by pixel |
| **Outer silhouette not guaranteed** | it only appears where the contrast to white is high enough |
| **Eyes become rings** | the pupil gets an edge on both sides; no notion of "small dark area → fill black" |
| **One global "detail" knob** | a percentile threshold can't tell important lines from texture |

The pipeline below addresses each row.

## Pipeline

```
 RGBA cutout ─▶ upscale ─▶ ┬─▶ silhouette outline (from alpha) ───────────────┐
                           ├─▶ ink lines (dark ridge detection) ──────────────┤
                           └─▶ color regions (flat-color segmentation) ──▶ region borders ─┤
                                                                               ▼
              render ◀── smooth + vectorize ◀── close gaps / prune ◀── merge + thin to skeleton
```

### 1. Preprocess

- **Upscale** the crop 2–3× (bicubic or Lanczos) before processing. All
  thresholds in px are defined at that working resolution, not at the source size.
- **Edge-preserving smoothing** instead of a box blur: bilateral filter or
  Kuwahara / guided filter. Removes print raster, holo texture and paper grain while
  keeping color borders sharp. (Box blur blurs the borders too, so Canny has to
  run with a low threshold and picks up texture.)
- Convert to **CIELAB**. All later color decisions use Lab: lightness L separate
  from chroma (a, b).
- Work only inside the mask (pixels outside = white, excluded from statistics).

### 2. Silhouette outline (always on)

- Contour of the alpha mask (threshold at 0.5, after the mask cleanup from the
  background step) → polygon(s), via marching squares.
- Smooth the polygon (see step 6) and draw it as the **thickest line** (e.g. 1.5–2×
  the interior line width). A bold outer line is typical for coloring books and
  makes the figure read clearly.
- Erode the mask by a few px for the interior steps, so the outline is not drawn
  a second time by steps 3/4.
- Where the silhouette touches the crop edge (Pokémon cut off by the art window):
  no line along the edge (the template's frame is already there).

### 3. Ink lines (the artist's own outlines)

Most card art has dark inked contour lines. Detect them as **dark ridges** (thin
dark valleys in L) instead of as edges, so each ink line gives **one** centerline:

- candidates: black top-hat (`closing(L) − L`) with a structuring element a bit
  wider than the ink lines, or the Hessian's largest eigenvalue / a Frangi-style
  ridge filter at 2–3 scales
- threshold with hysteresis (like Canny), relative to the image's ridge-strength
  distribution
- also require the pixel to be **dark in absolute terms** (low L, low chroma)
  so that dark shading strokes in saturated colors are not mistaken for ink

Older cards (WotC, painted EX/DP art, `dp3-76`) have few or no ink lines: for
them the color regions (step 4) carry most of the lines. The pipeline must work
with either source alone.

### 4. Color regions (borders between colors, not shades)

Segment the cutout into a small number of **flat color areas**, then use the
borders between areas as lines. This gives closed areas by construction.

- Start from superpixels (SLIC, on Lab, ~300–800 per Pokémon) or mean-shift.
- **Merge** neighboring regions whose colors are similar, with a distance that
  weights **chroma/hue strongly and lightness weakly**: a shadowed and a lit part of
  the same orange belly merge, orange belly vs. brown body stay apart. Merge until
  no neighbor pair is below the threshold (region adjacency graph, merge the
  closest pair first).
- Merge regions below a **minimum area** into their most similar neighbor (the
  area that a crayon can still fill; this is the main knob for simple vs.
  detailed).
- Special cases:
  - very dark, small, enclosed regions (pupils, nostrils) → **fill solid black**
    instead of outlining (this is what coloring books do with pupils)
  - very light, small regions inside the eye (catchlights) → keep as white spot
  - near-white highlights on a colored area → merge into the area (they are
    shading, not a feature)
- Region borders → 1 px boundary map.

### 5. Combine and clean up

- Union of ink lines and region borders.
- **Thin** to a 1 px skeleton (Zhang–Suen or similar).
- **Prune spurs**: remove branches shorter than N px that end freely.
- **Close gaps**: for each free endpoint, look for another line within a distance
  in roughly the stroke's direction; connect if found. Remaining free ends:
  remove the stroke if it is short, keep it if it is long (an intended open
  stroke like a mouth line).
- Drop short isolated strokes (current `minSpeckle`, but on strokes, after
  thinning, measured in length).
- Check: count closed areas and free endpoints (these become test metrics).

### 6. Vectorize, smooth, render

- Trace the skeleton into polylines (graph walk between junctions and endpoints).
- Simplify (Douglas–Peucker), then smooth (Chaikin, or fitting cubic Béziers
  like potrace). Junctions stay fixed so lines still meet.
- Render with Canvas 2D `stroke()` with round caps/joins, at the **output
  resolution** (artwork frame at ~300 DPI or higher), not the working resolution:
  this removes the jaggedness for free.
- Line widths: outline thick, interior medium, optional "detail" lines (from
  ink lines that don't border two regions) thin.
- Keep the vector paths: they can also go to the PDF as vectors later (sharper
  prints, smaller files).

## Settings (UI)

Replace blur / detail / specks with knobs that mean something to a parent:

| Setting | Controls |
|---|---|
| **Detail**: simple / medium / detailed | minimum area size, color-merge threshold, whether thin detail lines are drawn |
| **Line width** | interior width; outline scales with it |
| **Fill pupils black** | on/off (default on) |
| **Show shading lines** | off by default; on = keep ink lines that lie inside one color area |

Presets set all of these together. The old algorithm stays available as
"Classic" until the new one is better on the whole test set, then it is removed.

## Implementation

### Phase A: prototype in Python (fast iteration)

- `scripts/lineart.py`, next to `scripts/segment.py`, with OpenCV and
  scikit-image (SLIC, RAG merging, skeletonize, top-hat, Frangi are all there).
- Reads the cutouts from the chosen good-mask config, writes
  `testdata/lineart/{variant}/{file}` plus a **contact sheet** (original |
  current `lineArt()` | new) so variants can be compared at a glance.
- Try each step separately and keep what helps; record decisions here.

### Phase B: port to TypeScript

Port only what Phase A kept. All of it is plain array code, no dependencies:

- `src/lineart/` split into `preprocess.ts` (upscale, bilateral, Lab),
  `ink.ts`, `regions.ts` (SLIC + region merging), `cleanup.ts` (thinning,
  pruning, gap closing), `vector.ts` (tracing, smoothing), `render.ts`
- Run in a **Web Worker** (SLIC + merging on a 1000 px crop may take
  hundreds of ms); results cached per card + settings like the mask.
- Unit tests (vitest) on synthetic images: a two-color disk gives one closed
  circle; a disk with a lightness gradient gives no interior line; a dark ink
  ring gives one line, not two; a gap of 3 px is closed; a 2 px spur is pruned.

### Optional: ML line extraction

If the classic pipeline isn't good enough on painted art, try a learned
line-art model in onnxruntime-web (already planned for background removal):
e.g. Anime2Sketch, "Informative Drawings", or the ControlNet `lineart_anime`
annotator. **Check each license first** (same rules as for the background models:
Apache-2.0 / MIT only). The ML output would replace step 3 (ink lines); steps 4–6
are still needed for closed areas and clean strokes.

## Test set

- Pick ~15–20 cards from `testdata/` where the background mask is clean, spread
  over eras and styles: inked modern art (`swsh8-204`, `sm11-147`), WotC
  (`base2-25`), painted DP-era (`dp3-76`), plus a few with patterned bodies,
  small Pokémon, two Pokémon, and big eyes.
- List them in `scripts/lineart-set.txt` (tracked; `testdata/` is not) so
  prototype and TS port use the same cards.
- **By-eye review** on the contact sheet is the main criterion ("would my kid
  want to color this?").
- **Metrics** per image, to catch regressions: number of closed areas, number of
  free line ends, smallest area, line-pixel ratio, time.
- Best real test: print a page and let the kids color it.

## Milestones

1. ✅ Choose the good-mask test set; contact-sheet script with current output.
2. ✅ Silhouette outline from the mask + current algorithm inside (quick win). In
   `lineArt()`: when the image has transparent pixels, the alpha mask is blurred and
   thresholded, its border is drawn `lineWidth + 2` px wide (not along the image border),
   and Canny edges within `outline + blur` px of the silhouette are dropped (no double line
   next to the outline). Opaque images (no cutout, "original" mode) are unchanged.
   Known limits: interior lines end a few px before the outline (small gaps), and
   interior lines close to the edge are lost.
3. ✅ Ink-line detection (single centerline) — prototype.
4. ✅ Color-region segmentation (inked art). Soft painted art is not supported: it is
   detected by the ink score and skipped (see *Art style classification*).
5. ✅ Cleanup: thinning, spur pruning, gap closing, connecting line ends to the outline,
   filling crumbs; metrics (see *Metrics*).
6. ✅ Vectorize + smooth + render at output resolution.
7. ✅ Port to TypeScript + worker + unit tests (see *In the app*). Settings UI: the existing
   sliders are mapped (no new sliders yet).
8. ⬜ Optional: pupils filled black, vector PDF output, ML line model.

## Prototype results (first run)

`scripts/lineart.py`, 52 cards from `scripts/lineart-set.txt` (masks: IS-Net
general, pad, clean; chosen by cross-model mask agreement, then by eye).
Contact sheets: `testdata/lineart/sheet-*.png` (cutout | classic | detailed | simple).
Since milestone 2, "classic" includes the silhouette outline.

**Art style classification** (`lineart.py --classify` → `scripts/lineart-style.json`):
ink score = share of the Pokémon's interior covered by detected ink lines. Inked art
scores ≥ 0.05, soft painted / 3D-rendered art ≤ 0.04 (clear gap on the test set);
threshold 0.045. 21 of 52 cards are inked. The pipeline runs only on inked cards
unless `--all` is given. Misfits: a few modern digitally shaded cards with thin
colored lines count as soft (sv03.5-025, sv09-020); a sparkly holo card counts as inked
(neo2-45).

What works:

- **Silhouette outline**: smooth, closed, bold, on every card. Biggest single win.
- **Ink lines** (black top-hat + hysteresis + darkness check): very good on inked
  art (modern sets, HGSS, WotC Base). One centerline per ink line, no doubles.
- **Smoothing + rendering** at 3× with anti-aliasing: no jaggies, even strokes.
- **Region merging by border strength** (mean chroma-weighted gradient along the
  shared border, union-find, weakest first) instead of mean color: shading
  gradients merge correctly. (First try with mean-color merging via skimage's
  `merge_hierarchical` gave random borders inside gradients and was 40 s/card.)

What doesn't work yet:

- **Soft painted art** (pl1-80, ecard2-69, pl4-18, dp2-105): with one fixed merge
  threshold either real features vanish (Glalie's black face patches, Lickilicky's
  tongue, Chansey's egg) or shading blotches come back as wiggly regions. Ideas:
  threshold relative to the image's gradient distribution; an extra hue-only
  border term (red tongue vs. pink body); never merge across a large L jump
  between big regions (black patch vs. white ice).
- **Region borders** still wiggle a bit where they don't follow a sharp edge
  (label smoothing helps, not enough).
- **Pupil filling** sometimes catches dark shadow regions (col1-SL6).
- Speed: ~15–20 s per card and preset in Python at 3× (SLIC + Python loops).
  Fine for prototyping; the TS port needs a smaller working scale or a worker.

## In the app

- `src/coloring.ts` (pipeline, rendering, ink score), `src/regions.ts` (SLIC, region graph),
  `src/skeleton.ts` (thinning, pruning, gap closing, tracing); run in `src/coloring.worker.ts`
  via `src/coloring-client.ts`. Working resolution: artwork × 2 (1280 × 768). About 2.5 s
  per card in Node; results are cached per card and line settings, and the previous lines stay
  visible while new ones are computed.
- Used for the Pokémon when *Background* is *Fewer lines* or *Remove* (outside the Pokémon:
  the faded / removed background as before), for inked cards only.
- Settings mapping: *Detail* moves between the prototype's simple (≤ 10) and detailed (≥ 14)
  presets; *Line width* is the interior stroke width, the outline is 2 px wider. *Smoothing*
  and *Remove specks* only affect the classic line art.
- **Painted art**: after the mask, each card gets an ink score (same as `lineart.py
  --classify`; TS and Python scores agree within ~0.01). Below 0.045 the card is hidden
  (checkbox *Hide cards with painted art*, on by default), with a note how many are hidden;
  hidden cards are not printed. Shown painted cards use the classic line art.
- `scripts/coloring-node.mts` runs the TS pipeline on raw RGBA files from Node, for checks
  against the prototype.
- Seen in the app with the U²-Net-p mask: the artist's own outline sometimes survives as a
  thin second line just inside the silhouette (the app's mask is looser than IS-Net's); a dark
  shadow area is sometimes filled black (pupil rule).

## Metrics

`lineart.py` measures every rendered picture (also the classic output) and writes
`testdata/lineart/metrics.json`; `--metrics` recomputes them without rerunning the
pipeline. The sheets show them per picture. Measured on the image as printed
(9 source px ≈ 1 mm):

- **areas**: closed white areas inside the Pokémon that are at least 1 mm²
- **crumbs**: areas below 1 mm² (can't be colored)
- **small**: areas between 1 and 9 mm² (fiddly with crayons)
- **free_ends**: line ends not connected to anything (after pruning 2 px spurs)
- **ink**: share of the Pokémon covered by black

Medians over the 21 inked test cards:

| | areas | crumbs | small | median area | free ends | ink |
|---|---|---|---|---|---|---|
| classic (with outline) | 8 | 75 | 6 | 5.1 mm² | 35 | 29 % |
| detailed | 21 | 0 | 12 | 5.0 mm² | 15 | 17 % |
| simple | 13 | 0 | 6 | 8.2 mm² | 20 | 19 % |

Cleanup steps added for this:

- **Connect to the outline**: free line ends within 14 px (source) of the silhouette are
  joined to it; interior lines are clipped short of the outline, and that gap leaked.
- **Fill crumbs**: areas below 1 mm² or narrower than 0.5 mm are filled black, like
  the gaps between lines in a coloring book. (First try with a 1.2 mm width limit
  turned eye whites and narrow body parts into black blobs.)

Remaining free ends are mostly the artist's open strokes inside an area (they don't
leak) and a few lines that stop short of another interior line. Known issues: eyes
sometimes fill mostly black (pupil fill + crumbs), small black dots on detailed
textures (coins, toes).

## Open questions

- How many areas is right for each age? (Guess: simple ≈ 10–25, detailed ≈ 40–80.)
- Thick outline + thin interior, or one width everywhere?
- Should "Fade" from the background plan reuse this pipeline with a very coarse
  region setting for the scenery?
