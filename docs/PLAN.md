# Pokémon TCG Coloring Cards — Plan

## Goal

A static website, hosted on GitHub Pages, that turns Pokémon TCG card images into
simplified black-and-white line-art "coloring cards". Several cards can be processed
at once, and the result is a printable PDF with cards at roughly real size
(63 × 88 mm) that kids can color.

## User flow

1. **Add cards** (batch). Any mix of:
   - paste an image URL (one or many, one per line)
   - upload image files (file picker or drag & drop, multiple files)
   - paste an image from the clipboard (Ctrl+V after "Copy image" in the browser)
2. **Preview** each card: original next to its line-art version.
3. **Tune** (globally, with per-card overrides): line thickness, detail level,
   "keep text" on/off, invert check.
4. **Arrange & print**: choose paper size (A4 / Letter), cards per page, cut marks,
   then **Download PDF**.

## Architecture

Everything runs in the browser — no backend. This fits GitHub Pages (static hosting
only) and means images never leave the user's machine.

```
 ┌──────────────┐   ┌──────────────┐   ┌───────────────┐   ┌────────────┐
 │ Import       │──▶│ Normalize    │──▶│ Line-art      │──▶│ PDF layout │──▶ download
 │ URL/file/clip│   │ crop, resize │   │ conversion    │   │ (jsPDF)    │
 └──────────────┘   └──────────────┘   └───────────────┘   └────────────┘
```

### Technology choice

| Option | Pros | Cons |
|---|---|---|
| **TypeScript + Vite** (recommended) | Simple, fast iteration, huge ecosystem (jsPDF, OpenCV.js), trivial GH Pages deploy | Image processing in JS is slower (fine for a handful of cards) |
| Rust → WASM (e.g. `image` + `imageproc` crates, Leptos/Yew or a thin TS UI) | Fast, typed image pipeline, fun if you like Rust | More build tooling, larger initial effort |

**Recommendation:** start with TypeScript + Vite and plain Canvas processing.
If the image pipeline becomes a bottleneck or gets complex, move just the
`lineart` module to Rust/WASM behind the same interface.

Planned libraries:
- `vite` — build/dev server
- `jspdf` — PDF generation (mm units, embeds PNG/JPEG)
- optionally `@techstark/opencv-js` — Canny edge detection, morphology (lazy-loaded, ~8 MB)

## Components

### 1. Import

- **Upload / drag & drop / clipboard:** read as `Blob` → `ImageBitmap`. No issues.
- **URL import:** the hard part is **CORS**. Loading a cross-origin image into a
  canvas taints it unless the server sends `Access-Control-Allow-Origin`.
  Strategy, in order:
  1. `fetch(url)` directly — works for hosts that send CORS headers
     (e.g. the pokemontcg.io image CDN is a good primary source to test against).
  2. Optional configurable CORS proxy (user-supplied URL, or a tiny Cloudflare Worker
     we can deploy separately — free tier is enough).
  3. Fall back with a clear message: "This site blocks direct loading — right-click
     the image → *Copy image*, then paste here" or download & upload.
- Batch: a textarea accepting multiple URLs; each becomes one card in the list.

### 2. Normalize

- Detect/crop card bounds (trim uniform border/background; uploads from photos may
  need a manual crop rectangle — v2).
- Force aspect ratio 63:88 and resample to a working resolution
  (e.g. 744 × 1039 px ≈ 300 DPI at card size).

### 3. Line-art conversion (core)

Goal: clean outlines on white, no large black areas (bad for coloring, wastes ink).

Pipeline (v1, pure Canvas):
1. Grayscale.
2. Light blur / bilateral-ish smoothing to drop texture and holo patterns.
3. Edge detection (Sobel magnitude, or Canny via OpenCV.js).
4. Threshold → binary; remove tiny speckles (connected components below N px).
5. Optionally dilate to thicken lines (kid-friendly thick strokes).
6. Output: black lines on white.

**Text handling:** card text (name, HP, attacks) looks bad through edge detection
(hollow letters). Options:
- "Keep text": for the known text regions of the standard card layout, use a simple
  threshold instead of edges, so text stays solid and readable.
- "Hide text": blank those regions, leaving empty boxes kids can fill in.
- Region layouts depend on card era (classic vs. Scarlet & Violet vs. full-art);
  start with one modern layout + "whole card same mode" fallback.

Tunable parameters exposed in UI: blur radius, edge threshold, min speckle size,
line thickness. Provide 2–3 presets ("Simple", "Detailed", "Toddler: very thick").

Future option: ML-based line extraction (e.g. ONNX model via onnxruntime-web) for
nicer results — only if classic edges aren't good enough.

### 4. PDF layout

- Card size: **63 × 88 mm** (standard TCG).
- **A4 (210 × 297 mm): 3 × 3 = 9 cards** (189 × 264 mm + gaps).
  Letter (215.9 × 279.4 mm): 3 × 3 also fits with small margins.
- Thin gray cut marks / outlines; optional 1–2 mm gap between cards.
- Embed images as PNG (1-bit-looking, compresses well) at ~300 DPI.
- Option: "duplicate each card N times" (one per kid).
- Print note in the UI: *print at 100% / "Actual size", not "Fit to page"*,
  otherwise cards come out smaller. Include a 50 mm calibration bar on page 1's
  margin to verify scaling.

### 5. UI

Single page:
- Import area (URL textarea, file drop zone, paste hint).
- Card grid: thumbnail original ↔ line-art, per-card settings, remove, reorder.
- Global settings panel + presets.
- Print settings + "Download PDF" button.
- Settings persisted in `localStorage`.

## Project structure (planned)

```
/
├─ docs/PLAN.md
├─ index.html
├─ src/
│  ├─ main.ts            UI wiring
│  ├─ import.ts          URL / file / clipboard loading, CORS fallback
│  ├─ normalize.ts       crop, resize, aspect ratio
│  ├─ lineart.ts         image → line-art pipeline
│  ├─ layout.ts          card regions per card era
│  ├─ pdf.ts             page layout, jsPDF export
│  └─ style.css
├─ test/                 unit tests (vitest) for pdf geometry & pipeline steps
├─ samples/              a few test card images (for local dev only, not committed if unclear licensing)
└─ .github/workflows/deploy.yml   build + deploy to GitHub Pages
```

## Deployment

- GitHub Actions workflow: on push to `main` → `npm ci && npm run build` →
  upload `dist/` → `actions/deploy-pages`.
- Vite `base` set to `/<repo-name>/`.
- Repository Settings → Pages → Source: "GitHub Actions".

## Milestones

1. ✅ **Skeleton:** Vite + TS project, GH Pages deploy workflow.
2. ✅ **Line art:** upload → preview; Canny with adaptive (percentile) thresholds, speckle removal, dilation; sliders.
3. ✅ **PDF export:** 3×3 A4/Letter layout at true size, cut lines, 50 mm calibration bar.
   ⬜ Real print test.
4. ✅ **Batch + clipboard + URL import** (incl. drag from other tabs) with CORS fallback messaging
   and optional proxy setting. pokemontcg.io images load directly (sends CORS headers).
5. ✅ **Text removal** (default; modern card layout only) + presets. "Keep text" mode dropped for now.
6. 🟡 **Polish:** copies per card ✅, Letter paper ✅, localStorage ✅; per-card overrides, reorder ⬜.
7. ⬜ *(Optional)* per-era text layouts, manual crop, CORS proxy worker, Rust/WASM pipeline, ML line art.

## Open questions

- Paper size: A4 (Europe) as default? Letter needed?
- Keep card text, hide it, or let kids color everything including text?
- Should the card frame/border be preserved as outline, or only the Pokémon artwork
  enlarged to fill the card?
- Which source websites will you typically copy from? (Determines how important the
  CORS proxy is.)

## Notes

- Pokémon card images are copyrighted by Nintendo / Creatures / GAME FREAK / The
  Pokémon Company. The tool does not host or bundle any card images — users bring
  their own, for private, non-commercial use at home.
