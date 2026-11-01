# Card Pipeline — Plan

## Idea

The expensive image processing does not have to run in the browser. A **local run** on a
developer machine processes every card once and stores a **recipe** per card: which
workflow to use and the settings for each step. The app then only has to apply a
recipe, or show that a card is not supported.

- A recipe is per card image: one entry per pipeline step, each with either the step's
  result (settings, coordinates, hash, …) or an error message saying why the card stops
  there (e.g. "HTTP 404: image missing", "full art card").
- Local steps may use Python tools (OpenCV, scikit-image, ONNX models, …) and may be slow
  or search over many settings. What the app later needs from a step goes into the recipe.
- Later the recipes are uploaded (like `public/catalog.csv.gz`) and a new UI is built on
  them. **Not important right now.**

**Goal now:** a local pipeline that works end to end on at least 20 % of the Pokémon
cards, if possible 85 %.

All local data lives in `.cache/` (git-ignored). Cards are identified by their file
path `<set>/<localId>.png`, as written by `scripts/card-urls.ts`; every step writes its
output under the same path.

## Steps

| # | Step | Local script | Output in the recipe | Status |
|---|------|--------------|----------------------|--------|
| 0 | Download image | `scripts/card-urls.ts`, `scripts/download-cards.ts` | SHA-256 of the image bytes, or an error | works; error not recorded yet |
| 1 | Extract art | `scripts/extract-art.py` | art window `x, y, w, h`, or an error | works |
| 2 | Remove background | `scripts/segment.py` (evaluation only) | WIP | WIP |
| … | (further steps, e.g. art style check) | | | open |
| last | Line art | `scripts/lineart-recipes.ts` + `scripts/lineart-quality.py` (classic), `scripts/lineart.py` (coloring prototype) | workflow + settings, or an error | WIP |

### 0) Download image

```sh
npx vite-node scripts/card-urls.ts       # .cache/cards/urls.tsv: all TCGdex Pokémon cards with an image
npx vite-node scripts/download-cards.ts  # .cache/cards/<set>/<localId>.png, resumable, 5 per second
```

`card-urls.ts` lists only Pokémon cards (no Trainer or Energy), sorted by National
Pokédex number. `download-cards.ts` skips files that exist, so it can be stopped and
restarted; failed downloads are retried on the next run.

Recipe output:
- the SHA-256 of the image bytes (already computed by `scripts/build-catalog.ts` into
  the catalog), so a changed image on TCGdex invalidates the later steps,
- `null` when TCGdex has no image for the card (1,395 of 20,132 Pokémon cards),
- an error such as `"HTTP 404: image missing"` (6 cards: TCGdex lists an image that returns 404).

To do: `download-cards.ts` only prints failures; record them per card.

### 1) Extract art

```sh
.venv/bin/python scripts/extract-art.py   # all cores; ~3 min for all cards, then only new ones
```

Finds the art window of each card (port of `detectArtWindow()` in `src/detect.ts`; keep
both in sync) and writes:
- `.cache/art/<set>/<localId>.png`: the artwork (RGBA, cut 5/744 of the card width inside
  the window, as the app does),
- `.cache/art/art.tsv`: per card `id, file, status, cardW, cardH, artX, artY, artW, artH, relW, relH`.
  Status `ok`, `large` (window more than 10 % wider or taller than the median, e.g. the
  HGSS layout) or `no-window`.

Recipe output: the rectangle `x, y, w, h` (card pixels), or `"full art card"` when no
window is found (full-art and full-bleed cards: ex, EX, GX, V, VMAX, illustration rares, …).
For those the script still writes the default window crop, but the pipeline stops.

How the detection works: the strongest straight color edges in the bands where cards of
all eras have their window borders, moved to the line nearest the art (inner frame line,
top of the Pokédex info bar); left and right found separately; a small logistic score of
edge strengths, bottom line and side inset rejects the name/ability bars of full-art cards.

Result (2026-11-01, 18,731 downloaded cards): window found for 14,904 (80 % of downloaded,
74 % of all 20,132 Pokémon cards). Against labels from rarity and name suffix: 62 normal
cards without window, 148 full-art cards with a (false) window.

### 2) Remove background (WIP)

Separates the Pokémon from the scenery in the art crop. In the app this is U²-Net-p in
the browser (`src/segment.ts`); `scripts/segment.py` ran the model comparison, see
[BACKGROUND_REMOVAL.md](BACKGROUND_REMOVAL.md). Locally a larger model can be used
(isnet-general is what `scripts/lineart.py` uses).

To work out: what goes into the recipe — the mask itself is too big, so probably the
model and settings plus a quality flag, with the mask recomputed (or uploaded
separately) where needed.

### … further steps

Candidates, to be worked out:
- Art style check: soft painted or 3D-rendered art has no drawn lines and gives poor line
  art. The ink score (`src/coloring.ts`, `scripts/lineart-style.json`) already
  classifies cards as "inked" or "soft"; it could become its own step with a
  `"painted art"` error.

### last) Line art

Turns the art (with or without background) into the coloring picture. Two workflows exist:
- **classic** (`src/lineart.ts`): `scripts/lineart-recipes.ts` searches blur × detail per
  card and keeps the config whose ink coverage is closest to 15 %; it fails cards whose
  best ink is outside 4–30 %. `scripts/lineart-quality.py` scores the result (clutter,
  thin white strips, short strokes, small areas, free line ends) and adds a `quality`
  to the recipe. Recipes in `.cache/recipes/<set>/<localId>.json`, pictures in
  `.cache/lineart/classic/`.
- **coloring** (`src/coloring.ts`, prototype `scripts/lineart.py`): outline from the mask,
  the artist's ink lines, borders between flat color areas; needs step 2. See
  [LINE_ART.md](LINE_ART.md).

Recipe output: workflow name + settings (+ quality score), or an error such as
`"too many lines (busy texture)"`.

## Recipe format (draft)

One JSON file per card in `.cache/recipes/<set>/<localId>.json`, built up step by step:

```json
{
  "id": "swsh12-032",
  "file": "swsh12/032.png",
  "image": { "sha256": "…" },
  "art": { "x": 44, "y": 75, "w": 511, "h": 339 },
  "background": "WIP",
  "lineart": { "pipeline": "classic-v0", "config": { "blur": 2, "detail": 10 }, "quality": 0.66 }
}
```

A failed step has `{ "error": "…" }` instead of its result, and later steps are missing.
Today only the line-art step writes these files (with its own fields); steps 0 and 1
write `.cache/cards/urls.tsv` and `.cache/art/art.tsv`.

## Open questions

- Recipe format: one file per card or one table per step? Versioning per step, so a
  changed step only reruns what depends on it.
- Which steps must match the app exactly (pixel coordinates do; a Python background model
  probably does not need to)?
- Coverage target per step: step 1 loses ~20 % (full art), step 0 ~7 % (no image).
