"""Quality metric for line art made by scripts/lineart-recipes.ts, plus good/bad contact sheets.

Measures each picture as printed (9 source px ≈ 1 mm, as in scripts/lineart.py), per cm² of artwork:
  clutter      share of the picture where lines cover > 35 % of a 4 mm window: texture turned into scribble
  thin_white   white in strips narrower than ~0.8 mm, per black px: double lines along inked outlines
  short        share of the ink in strokes below 4 mm² of ink: dots and dashes
  small_areas  white areas of 1–9 mm² per cm²: fiddly to color
  crumbs       white specks below 1 mm² per cm² (reported, not scored: thin_white covers them)
  free_ends    line ends not touching another line per cm² (after pruning 2 px spurs): leaks
  ink          share of black
score = 1 for clean pictures, towards 0 for noisy ones (see score()). Written into each recipe
as "quality". Sheets: the SHEET best and worst scored pictures, art | line art, 6 per row.

Usage: .venv/bin/python scripts/lineart-quality.py [recipeDir=.cache/recipes] [artDir=.cache/art]
       [lineDir=.cache/lineart/classic] [sheetDir=.cache/lineart]
"""
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage import morphology

PX_PER_MM = 9
MM2 = PX_PER_MM ** 2
CM2 = 100 * MM2
SHEET = 180
COLS = 6
CELL_W = 240  # per image; each cell is art | line art

args = sys.argv[1:]
RECIPES = Path(args[0] if len(args) > 0 else '.cache/recipes')
ART = Path(args[1] if len(args) > 1 else '.cache/art')
LINES = Path(args[2] if len(args) > 2 else '.cache/lineart/classic')
SHEETS = Path(args[3] if len(args) > 3 else '.cache/lineart')

EIGHT = np.ones((3, 3), bool)


def free_ends(lines: np.ndarray) -> int:
    sk = morphology.skeletonize(lines)
    for _ in range(2):  # prune short spurs, the skeleton's own artifacts
        nb = ndimage.convolve(sk.astype(np.uint8), EIGHT.astype(np.uint8), mode='constant') - sk
        sk &= ~((nb == 1) & sk)
    nb = ndimage.convolve(sk.astype(np.uint8), EIGHT.astype(np.uint8), mode='constant') - sk
    ends = (nb == 1) & sk
    ends[:3], ends[-3:], ends[:, :3], ends[:, -3:] = False, False, False, False  # cut by the frame
    return int(ends.sum())


def metrics(file: str) -> dict:
    lines = np.asarray(Image.open(LINES / file).convert('L')) < 128
    cm2 = lines.size / CM2
    white, _ = ndimage.label(~lines)
    wsize = np.bincount(white.ravel())[1:]
    black, _ = ndimage.label(lines, structure=EIGHT)
    bsize = np.bincount(black.ravel())
    bsize[0] = 0
    density = ndimage.uniform_filter(lines.astype(np.float32), 4 * PX_PER_MM)
    opened = ndimage.binary_opening(~lines, morphology.disk(3))
    return dict(
        clutter=round(float((density > 0.35).mean()), 4),
        thin_white=round(float((~lines & ~opened).sum() / max(lines.sum(), 1)), 3),
        short=round(float(lines[bsize[black] < 4 * MM2].mean()) if lines.any() else 0, 3),
        small_areas=round(float(((wsize >= MM2) & (wsize < 9 * MM2)).sum()) / cm2, 2),
        crumbs=round(float((wsize < MM2).sum()) / cm2, 2),
        free_ends=round(free_ends(lines) / cm2, 2),
        ink=round(float(lines.mean()), 3),
    )


# (good, bad) per metric: the penalty ramps from 0 at good to 1 at bad, about the 10th and
# 95th percentile of the first 600 classic-v0 pictures.
RAMPS = dict(clutter=(0.02, 0.11), thin_white=(0.18, 0.35), short=(0.006, 0.04), small_areas=(0.24, 1.0),
             free_ends=(1.6, 5.2))
WEIGHTS = dict(clutter=0.35, thin_white=0.2, short=0.15, small_areas=0.15, free_ends=0.15)


def score(m: dict) -> float:
    """1 = clean picture; each metric's penalty ramps between its good and bad value."""
    ramp = lambda v, good, bad: min(max((v - good) / (bad - good), 0), 1)
    return round(1 - sum(w * ramp(m[k], *RAMPS[k]) for k, w in WEIGHTS.items()), 3)


def sheet(recipes: list, path: Path):
    rows = -(-len(recipes) // COLS)
    cell_h = CELL_W * 3 // 5 + 14
    out = Image.new('RGB', (COLS * 2 * CELL_W, rows * cell_h), 'white')
    draw = ImageDraw.Draw(out)
    for k, r in enumerate(recipes):
        x, y = (k % COLS) * 2 * CELL_W, (k // COLS) * cell_h
        for j, src in enumerate([ART / r['file'], LINES / r['file']]):
            im = Image.open(src).convert('RGB')
            im.thumbnail((CELL_W - 4, cell_h - 16))
            out.paste(im, (x + j * CELL_W + 2, y + 14))
        q = r['quality']
        draw.text((x + 4, y + 1), f"{r['id']}  score {q['score']}  clut {q['clutter']}  thin {q['thin_white']}  "
                  f"short {q['short']}  small {q['small_areas']}  ends {q['free_ends']}", fill='black')
    out.save(path)


def main():
    paths = sorted(RECIPES.rglob('*.json'))
    recipes = [json.loads(p.read_text()) for p in paths]
    ok = [(p, r) for p, r in zip(paths, recipes) if r['ok']]
    with Pool() as pool:
        ms = pool.map(metrics, [r['file'] for _, r in ok])
    for (p, r), m in zip(ok, ms):
        r['quality'] = {'score': score(m), **m}
        p.write_text(json.dumps(r, indent=1) + '\n')
    ranked = sorted((r for _, r in ok), key=lambda r: -r['quality']['score'])
    keys = ['score', *WEIGHTS, 'crumbs', 'ink']
    print(f'{len(recipes)} recipes, {len(ok)} with line art; quantiles 10/50/90 %:')
    for k in keys:
        v = [r['quality'][k] for r in ranked]
        print(f'  {k:10s}' + ''.join(f'{np.percentile(v, q):9.3f}' for q in (10, 50, 90)))
    sheet(ranked[:SHEET], SHEETS / 'sheet-good.png')
    sheet(ranked[-SHEET:][::-1], SHEETS / 'sheet-bad.png')
    print(f'sheets: {SHEETS}/sheet-good.png, {SHEETS}/sheet-bad.png')


if __name__ == '__main__':
    main()
