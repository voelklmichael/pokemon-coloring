"""Cuts the artwork out of every downloaded card (see scripts/download-cards.ts) and reports
cards whose artwork is not the usual window in the upper part of the card: full-art cards
(no window found) and unusually large windows. Runs on all CPU cores.

The detection is a port of detectArtWindow() in src/detect.ts; keep both in sync.

Input:  <list>  (scripts/card-urls.ts), card images next to it
Output: <out>/<file>   artwork per card (RGBA PNG; the default window for cards without one)
        <out>/art.tsv  per card: id, file, status (ok / large / no-window), card size,
                       window x, y, w, h in px and w, h relative to the card
        Cards already in art.tsv whose crop exists are not processed again;
        delete art.tsv to redo all.

Setup:  .venv/bin/pip install opencv-python-headless numpy
Usage:  .venv/bin/python scripts/extract-art.py [--list .cache/cards/urls.tsv] [--out .cache/art] [--jobs N]
"""
import argparse
import math
import os
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np

# Same constants as src/detect.ts.
DEFAULT_ART = (0.077, 0.098, 0.846, 0.374)  # x, y, w, h as fractions of the card
EDGE = 9
MIN_LINE = 0.6
FULL_LINE = 0.9
WINDOW_SCORE = dict(left=9.69, right=31.13, bottom=24.44, top=11.1, bottom_inside=9.69, inset=34.97, bias=-82.56)
LARGE = 1.1  # a window this much wider or taller than the median (relative to the card) counts as large


def js_round(v):
    """Math.round of JavaScript (halves up), so pixel positions match src/detect.ts."""
    return math.floor(v + 0.5)


def load_rgba(path):
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError('cannot decode')
    if img.dtype != np.uint8:
        img = (img >> 8).astype(np.uint8)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img  # BGRA


def detect_art_window(bgra):
    """The artwork window (x, y, w, h) of a card image, or None if it has none. See src/detect.ts."""
    h, w = bgra.shape[:2]
    # Only the upper part is searched; the margin keeps the blur there the same as on the whole card.
    upper = bgra[:min(h, math.ceil(0.6 * h) + 8)]
    alpha = upper[..., 3].astype(np.float32) / 255
    edge_h = np.zeros(upper.shape[:2], bool)  # edge_h[y]: color change between rows y - 1 and y + 1
    edge_v = np.zeros(upper.shape[:2], bool)  # edge_v[:, x]: between columns x - 1 and x + 1
    for c in range(3):
        ch = upper[..., c].astype(np.float32) * alpha + 255 * (1 - alpha)
        for _ in range(3):  # blur(…, 1) of src/lineart.ts: three 3×3 box passes, edges clamped
            ch = cv2.blur(ch, (3, 3), borderType=cv2.BORDER_REPLICATE)
        edge_h[1:-1] |= np.abs(ch[2:] - ch[:-2]) > EDGE
        edge_v[:, 1:-1] |= np.abs(ch[:, 2:] - ch[:, :-2]) > EDGE

    def row_score(y, x0, x1):
        return float(edge_h[y, x0:x1].mean()) if x1 > x0 else 0.0

    def best(lo, hi, score):
        vs = range(js_round(lo), math.floor(hi) + 1)
        scores = [score(v) for v in vs]
        i = int(np.argmax(scores))
        return vs[i], scores[i]

    def inner(start, end, step, score):
        found = start
        for v in range(start + step, end + step, step):
            if score(v) >= FULL_LINE:
                found = v
        return found

    x0, x1 = math.floor(0.2 * w), math.floor(0.8 * w)
    row = lambda y: row_score(y, x0, x1)
    top, top_max = best(0.08 * h, 0.17 * h, row)
    bottom, bottom_max = best(0.4 * h, 0.56 * h, row)
    if top_max < MIN_LINE or bottom_max < MIN_LINE:
        return None
    t = inner(top, min(math.floor(top + 0.03 * h), math.floor(0.17 * h)), 1, row)
    b = inner(bottom, max(math.floor(bottom - 0.035 * h), js_round(0.4 * h)), -1, row)

    margin = math.floor(0.1 * (b - t))
    col_sum = edge_v[t + margin:b - margin].sum(0)
    n = max(1, b - 2 * margin - t)
    col = lambda x: float(col_sum[x]) / n
    left, left_max = best(0.03 * w, 0.14 * w, col)
    right, right_max = best(0.86 * w, 0.97 * w, col)
    if left_max < MIN_LINE and right_max < MIN_LINE:
        return None
    l = inner(left, min(math.floor(left + 0.05 * w), math.floor(0.14 * w)), 1, col)
    r = inner(right, max(math.ceil(right - 0.05 * w), js_round(0.86 * w)), -1, col)
    if left_max < MIN_LINE:
        l = w - 1 - r
    if right_max < MIN_LINE:
        r = w - 1 - l

    bottom_inside = max(row_score(y, l + 4, r - 4) for y in range(b - 2, b + 3))
    s = WINDOW_SCORE
    score = (s['left'] * left_max + s['right'] * right_max + s['bottom'] * bottom_max + s['top'] * top_max
             + s['bottom_inside'] * bottom_inside + s['inset'] * min(l / w, (w - 1 - r) / w) + s['bias'])
    if score < 0:
        return None
    return l, t, r - l, b - t


def init_worker():
    cv2.setNumThreads(1)  # one process per core already


def process(job):
    card_id, file, src, dst = job
    try:
        img = load_rgba(src)
    except Exception as e:  # noqa: BLE001 - report and go on with the other cards
        return card_id, file, None, str(e)
    h, w = img.shape[:2]
    window = detect_art_window(img)
    x, y, rw, rh = window or tuple(js_round(f * s) for f, s in zip(DEFAULT_ART, (w, h, w, h)))
    # Same border inset as src/render.ts, scaled from the 744 px working width.
    inset = js_round(5 * w / 744)
    dst.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(dst), img[y + inset:y + rh - inset, x + inset:x + rw - inset])
    return card_id, file, dict(card=(w, h), art=(x, y, rw, rh), found=window is not None), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', default='.cache/cards/urls.tsv')
    ap.add_argument('--out', default='.cache/art')
    ap.add_argument('--jobs', type=int, default=os.cpu_count())
    args = ap.parse_args()
    root, out = Path(args.list).parent, Path(args.out)
    report = out / 'art.tsv'

    entries = [line.split('\t') for line in Path(args.list).read_text().splitlines() if line]
    previous = {}
    if report.exists():
        for line in report.read_text().splitlines()[1:]:
            card_id, file, status, cw, ch, x, y, aw, ah = line.split('\t')[:9]
            previous[file] = dict(card=(int(cw), int(ch)), art=tuple(map(int, (x, y, aw, ah))), found=status != 'no-window')

    results, jobs, missing = {}, [], 0
    for _, card_id, _, file in entries:
        if file in previous and (out / file).exists():
            results[file] = (card_id, previous[file])
        elif (root / file).exists():
            jobs.append((card_id, file, root / file, out / file))
        else:
            missing += 1
    print(f'{len(entries)} cards: {len(results)} done before, {len(jobs)} to process, {missing} not downloaded', flush=True)

    with Pool(args.jobs, init_worker) as pool:
        for i, (card_id, file, res, err) in enumerate(pool.imap_unordered(process, jobs, chunksize=32), 1):
            if err:
                print(f'failed {card_id} ({file}): {err}', file=sys.stderr)
            else:
                results[file] = (card_id, res)
            if i % 1000 == 0:
                print(f'{i}/{len(jobs)}', flush=True)

    rows = [(file, *results[file]) for _, _, _, file in entries if file in results]
    found = [r for _, _, r in rows if r['found']]
    median = lambda v: sorted(v)[len(v) // 2]
    typ_w = median([r['art'][2] / r['card'][0] for r in found])
    typ_h = median([r['art'][3] / r['card'][1] for r in found])

    def status(r):
        if not r['found']:
            return 'no-window'
        large = r['art'][2] / r['card'][0] > typ_w * LARGE or r['art'][3] / r['card'][1] > typ_h * LARGE
        return 'large' if large else 'ok'

    out.mkdir(parents=True, exist_ok=True)
    lines = ['id\tfile\tstatus\tcardW\tcardH\tartX\tartY\tartW\tartH\trelW\trelH']
    by_set = defaultdict(lambda: dict(total=0, large=[], none=[]))
    for file, card_id, r in rows:
        (cw, ch), (x, y, aw, ah) = r['card'], r['art']
        st = status(r)
        lines.append('\t'.join(map(str, (card_id, file, st, cw, ch, x, y, aw, ah, f'{aw / cw:.3f}', f'{ah / ch:.3f}'))))
        s = by_set[file.split('/')[0]]
        s['total'] += 1
        if st == 'large':
            s['large'].append(card_id)
        if st == 'no-window':
            s['none'].append(card_id)
    report.write_text('\n'.join(lines) + '\n')

    # Flagged cards per set: whole sets usually share one layout (e.g. the taller HGSS window).
    sample = lambda ids: ' '.join(ids[:8]) + (' …' if len(ids) > 8 else '')
    for name, s in by_set.items():
        if s['large']:
            print(f"{name}: {len(s['large'])}/{s['total']} large: {sample(s['large'])}")
        if s['none']:
            print(f"{name}: {len(s['none'])}/{s['total']} without window: {sample(s['none'])}")
    count = lambda st: sum(1 for _, _, r in rows if status(r) == st)
    print(f'done: {len(rows)} artworks in {out}, typical window {100 * typ_w:.1f}% × {100 * typ_h:.1f}% of the card; '
          f"{count('no-window')} without a window (full art?), {count('large')} large (see {report})"
          + (f'; {missing} not downloaded' if missing else ''))


if __name__ == '__main__':
    main()
