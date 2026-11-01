# Pokémon TCG Coloring Cards — Plan

## Goal

A static website, hosted on GitHub Pages, that turns Pokémon TCG cards into
black-and-white coloring cards. Every card gets the same clean **base layout**
(header, artwork window, attacks, weakness/retreat row, footer) with all text and
numbers removed; only the card's artwork is converted to line art. Several cards
can be processed at once, and the result is a printable PDF with cards at real
size (63 × 88 mm).

## User flow

1. **Find cards**: search by Pokémon name (TCGdex database) and click results to add
   them. Alternatives: paste card links, upload/drop images, paste from the clipboard.
2. **Preview** each card: original next to the coloring version. For cards without
   database data, check/edit the layout (stage, type, attacks, …) per card.
3. **Tune** line art globally: presets + sliders (smoothing, detail, specks, line width).
   Optionally switch to "outlines of the original card".
4. **Print**: choose paper (A4 / Letter), copies per card, cut lines → **Download PDF**.

## Architecture

Everything runs in the browser — no backend.

```
 search / link ──▶ card database ──▶ structure (stage, type, attacks, …) ─┐
       │              (TCGdex, pokemontcg.io)                             │
       ▼                                                                  ▼
 card image ──▶ normalize ──▶ find art window ──▶ line art ──▶ base layout template ──▶ PDF
 (upload/paste)                                                (canvas)              (jsPDF)
```

### Card data sources

| Source | Used for | Notes |
|---|---|---|
| [TCGdex](https://tcgdex.dev) `api.tcgdex.net/v2/en` | search by name, card data + images | CORS everywhere, reliable, has stage + abilities |
| pokemontcg.io `api.pokemontcg.io/v2` | links to `images.pokemontcg.io` | API often answers 5xx without CORS headers → retry, then image only |
| Uploads / other links | image only | default layout, user edits it per card |

Structure model (`src/structure.ts`): stage (basic / stage 1 / stage 2), type,
number of abilities, attacks (energy cost list + whether there is a damage box),
weakness, resistance, retreat cost. Text and numbers are deliberately not modeled.

Detecting the structure from the image alone (energy symbol circles via Hough
transform) was prototyped and dropped: unreliable across card eras, and the
database covers the use case.

### Image processing

- **Normalize** (`normalize.ts`): trim background, scale to 744 × 1039 px (~300 DPI).
- **Art window** (`detect.ts`): strongest horizontal/vertical border lines near the
  expected positions, assuming a centered window; falls back to the modern layout's
  window (full-art cards have none).
- **Line art** (`lineart.ts`), on the art crop only so thresholds adapt to the artwork:
  1. per-channel blur (R, G, B)
  2. Sobel per channel, strongest channel wins (finds borders between colors of equal brightness)
  3. Canny: non-maximum suppression + hysteresis, thresholds from a gradient percentile ("detail")
  4. remove small connected components ("specks")
  5. dilate to the chosen line width
  - Tried and dropped: morphological closing + thinning to merge the double lines of
    inked outlines — it also merged separate details into clutter.

### Base layout template (`template.ts`)

Drawn with Canvas 2D at 744 × 1039 px:
stage tag (+ pre-evolution bubble for stage 1/2), name line, HP box, type symbol,
artwork frame, metadata strip, ability boxes, attack rows (energy cost circles with
type icons, name line, damage box), weakness / resistance / retreat symbols, footer.

### PDF (`pdf.ts`)

63 × 88 mm cards, 3 × 3 per A4 or Letter page, optional gap and cut lines, 50 mm
calibration line on page 1, identical cards embedded once.

## Project structure

```
src/
├─ main.ts        UI wiring (search, import, settings, cards, PDF button)
├─ database.ts    TCGdex / pokemontcg.io lookups, link parsing
├─ structure.ts   card structure model, energy types
├─ import.ts      URL / file / clipboard loading, CORS fallback
├─ normalize.ts   crop + resize to working resolution
├─ detect.ts      art window detection
├─ lineart.ts     image → line-art mask
├─ template.ts    base layout drawing, energy icons
├─ render.ts      combines art line art + template per card
├─ pdf.ts         page layout, jsPDF export
└─ style.css
test/             vitest unit tests
.github/workflows/deploy.yml   test + build + deploy to GitHub Pages
```

## Milestones

1. ✅ Skeleton: Vite + TS, GH Pages workflow.
2. ✅ Line art with adaptive Canny, presets, sliders.
3. ✅ PDF export at true size. ⬜ Real print test.
4. ✅ Batch import: links, files, drag & drop, clipboard, CORS fallback.
5. ✅ Card database: TCGdex search, link parsing, pokemontcg.io links.
6. ✅ Base layout template with energy icons; per-card layout editor for uploads.
7. ⬜ Next ideas:
   - better art for full-art cards (no art window: use whole card or let the user pick)
   - manual art crop adjustment per card
   - optional: write the Pokémon name / HP into the template (font, toggle)
   - ML line extraction (e.g. ONNX model) if classic edges aren't good enough
   - reorder cards, per-card line settings

## Notes

- Pokémon card images are copyrighted by Nintendo / Creatures / GAME FREAK / The
  Pokémon Company. The tool does not host or bundle card images; they are loaded from
  public card databases for private, non-commercial use at home.
