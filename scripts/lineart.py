"""Prototype of the coloring line-art pipeline (see docs/LINE_ART.md).

Input:  testdata/{MASKS}/{card}.png  (art crop as RGBA, alpha = foreground mask from scripts/segment.py)
        for the cards listed in scripts/lineart-set.txt
Output: testdata/lineart/{preset}/{card}.png    coloring picture per preset
        testdata/lineart/classic/{card}.png     the app's current lineArt(), for comparison
        testdata/lineart/sheet-{n}.png          contact sheets: cutout | classic | presets...
        testdata/lineart/metrics.json           per card and method: areas, crumbs, free line ends, ...
        scripts/lineart-style.json              per card: ink score, "inked" or "soft" (--classify)

Setup:  .venv/bin/pip install opencv-python-headless scikit-image   (plus scripts/segment.py's setup)
Usage:  .venv/bin/python scripts/lineart.py [--all] [card ...]   (without --all, "soft" cards are skipped)
        .venv/bin/python scripts/lineart.py --metrics [card ...]   (only recompute metrics and sheets)
        .venv/bin/python scripts/lineart.py --classify             (rewrites scripts/lineart-style.json)
"""
import heapq
import json
import struct
import subprocess
import sys
import tempfile
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage import color, morphology, segmentation

ROOT = Path(__file__).resolve().parent.parent
TESTDATA = ROOT / 'testdata'
MASKS = 'isnet-general/fp32-pad-clean'
OUT = TESTDATA / 'lineart'

SCALE = 3  # working resolution = source × SCALE; all px values below are source px unless noted

PRESETS = {
    'detailed': dict(
        color_merge=6,      # neighbors merge across borders weaker than this (≈ weighted Lab difference per source px)
        min_area=250,       # regions smaller than this (source px²) merge into their closest neighbor
        min_ink=12,         # ink strokes shorter than this are dropped
        line=2.2, outline=3.5,  # stroke widths
    ),
    'simple': dict(
        color_merge=9, min_area=900, min_ink=30, line=2.8, outline=4.2,
    ),
}
L_WEIGHT = 0.45      # lightness counts less than hue/chroma: shading should not split an area
PUPIL_MAX_L = 28     # regions darker than this ...
PUPIL_MAX_AREA = 0.02  # ... and smaller than this share of the Pokémon are filled black
# Share of the Pokémon's interior covered by ink lines. Below this the art is soft painted or rendered
# (no drawn lines), which the pipeline can't handle yet. On the test set the scores split at 0.04–0.05.
INKED_MIN = 0.045
STYLE = ROOT / 'scripts' / 'lineart-style.json'
PX_PER_MM = 9  # source art px per mm on the printed card (art window ≈ 55 mm wide)
CRUMB = 1 * PX_PER_MM ** 2      # areas below 1 mm² can't be colored at all
SMALL = 9 * PX_PER_MM ** 2      # areas below 3×3 mm are fiddly with crayons
MIN_WIDTH = 0.5 * PX_PER_MM     # slits narrower than this can't be colored either


# ---------- preprocessing ----------

def load(card: str):
    rgba = np.asarray(Image.open(TESTDATA / MASKS / f'{card}.png').convert('RGBA'))
    h, w = rgba.shape[:2]
    big = cv2.resize(rgba[..., :3], (w * SCALE, h * SCALE), interpolation=cv2.INTER_LANCZOS4)
    # Smooth the mask edge before thresholding so the silhouette is round, not pixel steps.
    alpha = cv2.resize(rgba[..., 3].astype(np.float32) / 255, (w * SCALE, h * SCALE), interpolation=cv2.INTER_LINEAR)
    alpha = cv2.GaussianBlur(alpha, (0, 0), SCALE * 1.2)
    mask = alpha >= 0.5
    # Edge-preserving smoothing: removes print raster and texture, keeps color borders.
    img = cv2.medianBlur(big, 5)
    for _ in range(2):
        img = cv2.bilateralFilter(img, 9, 30, 2 * SCALE)
    return rgba, img, mask


# ---------- ink lines ----------

def ink_lines(img: np.ndarray, mask: np.ndarray, min_len: int) -> np.ndarray:
    """Dark thin lines (the artist's ink) as a 1 px skeleton."""
    lab = color.rgb2lab(img)
    L = lab[..., 0].astype(np.float32)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5 * SCALE, 5 * SCALE))
    tophat = cv2.morphologyEx(L, cv2.MORPH_BLACKHAT, k)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    # Must stand out from its surroundings and be dark-ish in absolute terms.
    strong = (tophat > 18) & (L < 55)
    weak = (tophat > 9) & (L < 65) & (chroma < 45)
    ink = ndimage.binary_propagation(strong, mask=weak | strong) & mask
    ink = morphology.remove_small_objects(ink, max_size=min_len * SCALE * SCALE)
    return ink


# ---------- color regions ----------

def regions(img: np.ndarray, mask: np.ndarray, ink: np.ndarray, p: dict):
    """Flat color areas: SLIC superpixels, merged across weak borders, then by size.
    Returns (labels, black) where black marks small dark areas (pupils) to fill."""
    # Paint the ink out first, so ink lines don't become thin regions of their own.
    clean = cv2.inpaint(img, cv2.dilate(ink.astype(np.uint8), np.ones((3, 3), np.uint8)), SCALE * 2, cv2.INPAINT_TELEA)
    lab = color.rgb2lab(clean).astype(np.float32)
    n = max(50, int(mask.sum() / (7 * SCALE) ** 2))
    labels = segmentation.slic(lab, n_segments=n, compactness=12, mask=mask, start_label=1,
                               convert2lab=False, enforce_connectivity=True)

    # Border strength: color gradient with lightness weighted down. A shading gradient is weak
    # everywhere along the border between two superpixels; a border between two colors is strong.
    feat = lab * np.array([L_WEIGHT, 1, 1], np.float32)
    feat = cv2.GaussianBlur(feat, (0, 0), SCALE * 0.7)
    grad = np.sqrt(sum(cv2.Sobel(feat[..., c], cv2.CV_32F, 1, 0) ** 2 + cv2.Sobel(feat[..., c], cv2.CV_32F, 0, 1) ** 2
                       for c in range(3))) / 8 * SCALE  # ≈ color difference per source px
    g = RegionGraph(labels, grad)
    g.merge_weak(p['color_merge'])

    # Small dark enclosed regions → filled black (pupils, nostrils). Decided before size merging.
    labels = g.labels()
    count = labels.max() + 1
    area = np.bincount(labels.ravel(), minlength=count).astype(np.float64)
    meanL = np.bincount(labels.ravel(), lab[..., 0].ravel(), count) / np.maximum(area, 1)
    touches_bg = np.zeros(count, bool)
    touches_bg[np.unique(labels[cv2.dilate((~mask).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0])] = True
    is_black = (meanL < PUPIL_MAX_L) & (area < PUPIL_MAX_AREA * mask.sum()) & ~touches_bg & (area > (2 * SCALE) ** 2)
    is_black[0] = False

    g.merge_small(p['min_area'] * SCALE * SCALE, keep=is_black)
    labels = smooth_labels(g.labels(), mask, 1.5 * SCALE)
    return labels, np.isin(labels, np.flatnonzero(is_black))


def smooth_labels(labels: np.ndarray, mask: np.ndarray, sigma: float) -> np.ndarray:
    """Straightens region borders: each pixel takes the label with the highest blurred share around it."""
    best = np.zeros(labels.shape, np.float32)
    out = labels.copy()
    pad = int(3 * sigma)
    h, w = labels.shape
    for i, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            continue
        sl = tuple(slice(max(s.start - pad, 0), min(s.stop + pad, n)) for s, n in zip(sl, (h, w)))
        share = cv2.GaussianBlur((labels[sl] == i).astype(np.float32), (0, 0), sigma)
        win = share > best[sl]
        best[sl][win] = share[win]
        out[sl][win] = i
    return np.where(mask, out, 0)


class RegionGraph:
    """Region adjacency graph with union-find merging. Edge weight = mean border strength along the shared border.
    Label 0 is the background and never merges."""

    def __init__(self, labels: np.ndarray, strength: np.ndarray):
        self.lab = labels
        count = labels.max() + 1
        self.parent = np.arange(count)
        self.area = np.bincount(labels.ravel(), minlength=count).astype(np.float64)
        keys, sums = [], []
        for a, b, sa, sb in ((labels[:, :-1], labels[:, 1:], strength[:, :-1], strength[:, 1:]),
                             (labels[:-1], labels[1:], strength[:-1], strength[1:])):
            d = a != b
            lo, hi = np.minimum(a[d], b[d]), np.maximum(a[d], b[d])
            keys.append(lo.astype(np.int64) * count + hi)
            sums.append(np.maximum(sa[d], sb[d]))
        keys, sums = np.concatenate(keys), np.concatenate(sums)
        uniq, inv = np.unique(keys, return_inverse=True)
        tot = np.bincount(inv, sums)
        cnt = np.bincount(inv)
        self.edges = [dict() for _ in range(count)]  # node -> {neighbor: [strength sum, border px]}
        for k, t, c in zip(uniq.tolist(), tot.tolist(), cnt.tolist()):
            a, b = divmod(k, count)
            self.edges[a][b] = [t, c]
            self.edges[b][a] = [t, c]

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        """Merges a into b."""
        self.parent[a] = b
        self.area[b] += self.area[a]
        for n, (t, c) in self.edges[a].items():
            if n == b:
                continue
            e = self.edges[b].setdefault(n, [0.0, 0])
            e[0] += t
            e[1] += c
            del self.edges[n][a]
            self.edges[n][b] = e
        del self.edges[b][a]
        self.edges[a] = {}

    @staticmethod
    def mean(e):
        return e[0] / e[1]

    def merge_weak(self, thresh: float):
        """Merges neighbors across the weakest border first, while the border is weaker than thresh."""
        heap = [(self.mean(e), a, b) for a in range(1, len(self.edges)) for b, e in self.edges[a].items() if 0 < a < b]
        heapq.heapify(heap)
        while heap:
            w, a, b = heapq.heappop(heap)
            if w >= thresh:
                break
            e = self.edges[a].get(b)
            if e is None or self.mean(e) != w:
                continue  # stale
            if self.area[a] > self.area[b]:
                a, b = b, a
            self.union(a, b)
            for n, e in self.edges[b].items():
                if n:
                    heapq.heappush(heap, (self.mean(e), min(b, n), max(b, n)))

    def merge_small(self, min_area: float, keep: np.ndarray):
        """Merges regions smaller than min_area into the neighbor with the weakest border, smallest first."""
        heap = [(self.area[i], i) for i in range(1, len(self.edges))
                if self.parent[i] == i and self.area[i] < min_area and not keep[i]]
        heapq.heapify(heap)
        while heap:
            ar, i = heapq.heappop(heap)
            if self.parent[i] != i or self.area[i] != ar:
                continue
            nbrs = [(self.mean(e), n) for n, e in self.edges[i].items() if n and not keep[n]]
            if not nbrs:
                continue
            j = min(nbrs)[1]
            self.union(i, j)
            if self.area[j] < min_area:
                heapq.heappush(heap, (self.area[j], j))

    def labels(self) -> np.ndarray:
        roots = np.array([self.find(i) for i in range(len(self.parent))])
        return roots[self.lab]


# ---------- skeleton cleanup ----------

NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def neighbors(sk: np.ndarray) -> np.ndarray:
    return ndimage.convolve(sk.astype(np.uint8), np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]]), mode='constant') * sk


def prune(sk: np.ndarray, n: int) -> np.ndarray:
    """Removes spurs shorter than n px: peel endpoints n times, then regrow surviving ends within the original."""
    out = sk.copy()
    for _ in range(n):
        out &= ~(neighbors(out) == 1)
    ends = (neighbors(out) == 1)
    grow = ends.copy()
    for _ in range(n):
        grow = ndimage.binary_dilation(grow, np.ones((3, 3), bool)) & sk & ~out
        out |= grow
    return morphology.skeletonize(out)


def trace_back(sk: np.ndarray, start, steps: int):
    """Follows a line from an endpoint for up to `steps` px (stops at junctions)."""
    h, w = sk.shape
    path = [start]
    prev = None
    cur = start
    for _ in range(steps):
        nxt = [(cur[0] + dy, cur[1] + dx) for dy, dx in NB
               if 0 <= cur[0] + dy < h and 0 <= cur[1] + dx < w and sk[cur[0] + dy, cur[1] + dx]
               and (cur[0] + dy, cur[1] + dx) not in path[-3:]]
        if len(nxt) != 1:
            break
        prev, cur = cur, nxt[0]
        path.append(cur)
    return path


def close_gaps(sk: np.ndarray, targets: np.ndarray, radius: float) -> np.ndarray:
    """Connects each free line end to the nearest line roughly ahead of it (within `radius` working px)."""
    out = sk.copy()
    all_pts = np.argwhere(sk | targets)
    if len(all_pts) == 0:
        return out
    tree = cKDTree(all_pts)
    ends = np.argwhere(neighbors(sk) == 1)
    for e in map(tuple, ends):
        path = trace_back(sk, e, int(radius * 1.5))
        if len(path) < 4:
            continue
        own = set(path)
        back = np.array(path[min(len(path) - 1, 3 * SCALE)])
        d = np.array(e) - back
        d = d / (np.linalg.norm(d) + 1e-9)
        best, best_score = None, 1e9
        for idx in tree.query_ball_point(e, radius):
            q = tuple(all_pts[idx])
            if q in own:
                continue
            v = np.array(q) - np.array(e)
            dist = np.linalg.norm(v)
            if dist < 1.5:
                continue
            cos = v @ d / dist
            if cos < 0.5:  # more than 60° off the stroke direction
                continue
            score = dist * (2 - cos)
            if score < best_score:
                best, best_score = q, score
        if best is not None:
            cv2.line(out.view(np.uint8), (e[1], e[0]), (best[1], best[0]), 1, 1)
    return out


def close_to_outline(sk: np.ndarray, edge: np.ndarray, radius: float) -> np.ndarray:
    """Connects free line ends near the silhouette to it: interior lines are clipped short of the
    outline, and a small gap there lets the color leak into the neighboring area."""
    out = sk.copy()
    pts = np.argwhere(edge)
    if len(pts) == 0:
        return out
    tree = cKDTree(pts)
    for e in map(tuple, np.argwhere(neighbors(sk) == 1)):
        dist, idx = tree.query(e, distance_upper_bound=radius)
        if not np.isfinite(dist):
            continue
        path = trace_back(sk, e, 3 * SCALE)
        q = pts[idx]
        if len(path) > 2 and dist > 4 * SCALE:  # only if the outline is ahead of the stroke, not behind it
            d = np.array(e) - np.array(path[-1])
            if d @ (q - np.array(e)) < 0:
                continue
        cv2.line(out.view(np.uint8), (e[1], e[0]), (int(q[1]), int(q[0])), 1, 1)
    return out


def remove_dangling(sk: np.ndarray, min_len: int, anchors: np.ndarray) -> np.ndarray:
    """Removes strokes that end freely and are shorter than min_len (open hairs that don't bound an area)."""
    out = sk.copy()
    nb = neighbors(sk)
    for e in map(tuple, np.argwhere(nb == 1)):
        if anchors[e]:
            continue
        path = trace_back(sk, e, min_len)
        if len(path) < min_len:
            if nb[path[-1]] > 2:  # keep the junction pixel the stroke hangs on
                path = path[:-1]
            for q in path:
                out[q] = False
    return out


# ---------- vectorize + render ----------

def trace_paths(sk: np.ndarray):
    """Splits a skeleton into polylines between endpoints/junctions (and closed loops)."""
    h, w = sk.shape
    nb = neighbors(sk)
    node = sk & (nb != 2)
    visited = np.zeros_like(sk)
    paths = []

    def nbrs(p):
        return [(p[0] + dy, p[1] + dx) for dy, dx in NB
                if 0 <= p[0] + dy < h and 0 <= p[1] + dx < w and sk[p[0] + dy, p[1] + dx]]

    def walk(start, first):
        path = [start, first]
        visited[first] = True
        prev, cur = start, first
        while not node[cur]:
            cand = [q for q in nbrs(cur) if q != prev and (node[q] or not visited[q])]
            if not cand:
                break
            nodes = [q for q in cand if node[q]]
            nxt = nodes[0] if nodes else min(cand, key=lambda q: abs(q[0] - cur[0]) + abs(q[1] - cur[1]))
            if not node[nxt]:
                visited[nxt] = True
            prev, cur = cur, nxt
            path.append(cur)
        return path

    for n in map(tuple, np.argwhere(node)):
        for q in nbrs(n):
            if node[q]:
                if n < q:
                    paths.append([n, q])
            elif not visited[q]:
                paths.append(walk(n, q))
    for s in map(tuple, np.argwhere(sk & ~visited & ~node)):  # loops without nodes
        if visited[s]:
            continue
        visited[s] = True
        nx = nbrs(s)
        if nx:
            p = walk(s, nx[0])
            if len(p) > 2:
                paths.append(p + [s])
    return paths


def smooth(pts: np.ndarray, sigma: float, closed: bool) -> np.ndarray:
    if len(pts) < 5:
        return pts
    mode = 'wrap' if closed else 'nearest'
    out = ndimage.gaussian_filter1d(pts.astype(np.float64), sigma, axis=0, mode=mode)
    if not closed:  # keep junctions/ends in place so lines still meet
        out[0], out[-1] = pts[0], pts[-1]
    return out


def silhouette(mask: np.ndarray):
    """Smoothed outer (and hole) contours of the mask as closed polylines; segments on the crop edge are dropped."""
    h, w = mask.shape
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    lines = []
    for c in contours:
        if len(c) < 20:
            continue
        pts = smooth(c[:, 0, ::-1], 2 * SCALE, closed=True)  # (y, x)
        on_edge = (pts[:, 0] < 2) | (pts[:, 0] > h - 3) | (pts[:, 1] < 2) | (pts[:, 1] > w - 3)
        if not on_edge.any():
            lines.append((np.vstack([pts, pts[:1]])))
            continue
        # Split at edge segments; rotate so we start on an edge point.
        k = int(np.argmax(on_edge))
        pts, on_edge = np.roll(pts, -k, 0), np.roll(on_edge, -k)
        run = []
        for p, e in zip(pts, on_edge):
            if e:
                if len(run) > 3:
                    lines.append(np.array(run))
                run = []
            else:
                run.append(p)
        if len(run) > 3:
            lines.append(np.array(run))
    return lines


def render(shape, outline, interior, black, p) -> Image.Image:
    """Draws at 2× the working resolution with anti-aliasing, then downsamples."""
    ss = 2
    h, w = shape
    canvas = np.full((h * ss, w * ss), 255, np.uint8)
    if black.any():
        fill = cv2.GaussianBlur(black.astype(np.float32), (0, 0), SCALE * 0.7) > 0.5
        fill = cv2.resize(fill.astype(np.uint8), (w * ss, h * ss), interpolation=cv2.INTER_NEAREST)
        canvas[fill > 0] = 0

    def draw(lines, width):
        t = max(1, round(width * SCALE * ss))
        for pts in lines:
            xy = np.round(pts[:, ::-1] * ss).astype(np.int32).reshape(-1, 1, 2)
            cv2.polylines(canvas, [xy], False, 0, t, cv2.LINE_AA)
            for end in (xy[0, 0], xy[-1, 0]):  # round caps
                cv2.circle(canvas, tuple(int(v) for v in end), t // 2, 0, -1, cv2.LINE_AA)

    draw(interior, p['line'])
    draw(outline, p['outline'])
    return Image.fromarray(canvas).resize((w, h), Image.LANCZOS)


# ---------- pipeline ----------

def coloring(card: str, p: dict) -> Image.Image:
    _, img, mask = load(card)
    ink = ink_lines(img, mask, p['min_ink'])
    labels, black = regions(img, mask, ink, p)

    inner = ndimage.binary_erosion(mask, iterations=int(4.5 * SCALE))
    borders = segmentation.find_boundaries(labels, mode='inner') & inner
    lines = (morphology.skeletonize(ink) | borders) & inner & ~black
    # Ink line and region border usually lie side by side: merge them into one stroke.
    lines = ndimage.binary_dilation(lines, morphology.disk(SCALE))
    sk = morphology.skeletonize(lines & mask)
    sk = prune(sk, 4 * SCALE)

    edge = segmentation.find_boundaries(mask, mode='inner')
    sk = close_gaps(sk, edge | ndimage.binary_dilation(black, iterations=1) & ~black, 8 * SCALE)
    sk = close_to_outline(sk, edge, 14 * SCALE)
    anchors = ndimage.binary_dilation(edge | black, iterations=int(3 * SCALE))
    for _ in range(2):
        sk = remove_dangling(sk, 6 * SCALE, anchors)
    sk = morphology.skeletonize(sk)
    sk = morphology.remove_small_objects(sk, max_size=8 * SCALE, connectivity=2)

    interior = [smooth(np.array(pth), 1.5 * SCALE, closed=pth[0] == pth[-1]) for pth in trace_paths(sk)]
    return fill_crumbs(render(mask.shape, silhouette(mask), interior, black, p), mask)


def fill_crumbs(im: Image.Image, mask: np.ndarray) -> Image.Image:
    """Fills areas that are too small or too narrow to color with black (like coloring books do
    with tiny gaps between lines)."""
    a = np.asarray(im).copy()
    space = (a >= 128) & mask
    areas, _ = ndimage.label(space)
    size = np.bincount(areas.ravel()) / SCALE ** 2
    # Widest point of each area = 2 × the largest distance to its border.
    width = 2 * ndimage.maximum(ndimage.distance_transform_edt(space), areas, np.arange(len(size))) / SCALE
    fill = (size < CRUMB) | (width < MIN_WIDTH)
    fill[0] = False
    a[fill[areas]] = 0
    return Image.fromarray(a)


def ink_score(card: str) -> float:
    """Share of the interior (away from the silhouette) covered by detected ink lines."""
    _, img, mask = load(card)
    inner = ndimage.binary_erosion(mask, iterations=4 * SCALE)
    ink = ink_lines(img, mask, 12)
    return float((ink & inner).sum() / max(inner.sum(), 1))


def classify(cards):
    with Pool() as pool:
        scores = pool.map(ink_score, cards)
    style = {c: dict(ink=round(v, 4), style='inked' if v >= INKED_MIN else 'soft') for c, v in zip(cards, scores)}
    STYLE.write_text(json.dumps(style, indent=1) + '\n')
    soft = [c for c, v in style.items() if v['style'] == 'soft']
    print(f'{len(cards) - len(soft)} inked, {len(soft)} soft: {" ".join(soft)}')


def run_card(card: str):
    for name, p in PRESETS.items():
        out = OUT / name / f'{card}.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        coloring(card, p).save(out)
    print(card, flush=True)


def classic(cards):
    """The app's current lineArt() on the source-resolution cutout, via scripts/lineart-classic.mts."""
    todo = [c for c in cards if not (OUT / 'classic' / f'{c}.png').exists()]
    if not todo:
        return
    (OUT / 'classic').mkdir(parents=True, exist_ok=True)
    bundle = ROOT / '.cache' / 'lineart-classic.mjs'
    subprocess.run([ROOT / 'node_modules/.bin/esbuild', ROOT / 'scripts/lineart-classic.mts', '--bundle',
                    '--platform=node', '--format=esm', f'--outfile={bundle}', '--log-level=warning'], check=True)
    with tempfile.TemporaryDirectory() as tmp:
        args = []
        for c in todo:
            rgba = np.asarray(Image.open(TESTDATA / MASKS / f'{c}.png').convert('RGBA'))
            h, w = rgba.shape[:2]
            (Path(tmp) / f'{c}.in').write_bytes(struct.pack('<II', w, h) + rgba.tobytes())
            args += [f'{tmp}/{c}.in', f'{tmp}/{c}.out']
        subprocess.run(['node', bundle, *args], check=True)
        for c in todo:
            buf = (Path(tmp) / f'{c}.out').read_bytes()
            w, h = struct.unpack('<II', buf[:8])
            m = np.frombuffer(buf[8:], np.uint8).reshape(h, w)
            Image.fromarray(((1 - m) * 255).astype(np.uint8)).save(OUT / 'classic' / f'{c}.png')


# ---------- metrics ----------



def metrics(card: str, method: str) -> dict:
    """Measures a rendered coloring picture as a child sees it: closed white areas inside the Pokémon and
    line ends that don't connect to anything (where colors will leak)."""
    src = Image.open(TESTDATA / MASKS / f'{card}.png')
    im = np.asarray(Image.open(OUT / method / f'{card}.png').convert('L'))
    h, w = im.shape
    scale = w / src.width
    mask = np.asarray(src.getchannel('A').resize((w, h), Image.NEAREST)) >= 128
    lines = im < 128
    areas, n = ndimage.label(mask & ~lines)
    size = np.bincount(areas.ravel())[1:] / scale ** 2  # in source px
    colorable = size[size >= CRUMB]
    sk = prune(morphology.skeletonize(lines), max(2, round(2 * scale)))
    nb = neighbors(sk)
    border = np.zeros_like(sk)
    border[:3], border[-3:], border[:, :3], border[:, -3:] = True, True, True, True
    return dict(
        areas=int(len(colorable)),
        crumbs=int((size < CRUMB).sum()),
        small=int(((size >= CRUMB) & (size < SMALL)).sum()),
        median_area_mm2=round(float(np.median(colorable)) / PX_PER_MM ** 2, 1) if len(colorable) else 0,
        free_ends=int(((nb == 1) & ~border).sum()),
        ink=round(float(lines[mask].mean()), 3),
    )


def all_metrics(cards):
    methods = ['classic', *PRESETS]
    with Pool() as pool:
        rows = pool.starmap(metrics, [(c, m) for c in cards for m in methods])
    result = {c: {m: rows[i * len(methods) + j] for j, m in enumerate(methods)} for i, c in enumerate(cards)}
    (OUT / 'metrics.json').write_text(json.dumps(result, indent=1) + '\n')
    keys = list(rows[0])
    print(f"{'median':10s}" + ''.join(f'{k:>16s}' for k in keys))
    for m in methods:
        vals = [result[c][m] for c in cards]
        print(f'{m:10s}' + ''.join(f'{np.median([v[k] for v in vals]):16g}' for k in keys))
    return result


def sheets(cards, metrics=None, per_sheet=8, col_w=360):
    cols = ['cutout', 'classic', *PRESETS]
    for s in range(0, len(cards), per_sheet):
        rows = []
        for c in cards[s:s + per_sheet]:
            src = Image.open(TESTDATA / MASKS / f'{c}.png').convert('RGBA')
            bg = Image.new('RGBA', src.size, 'white')
            bg.alpha_composite(src)
            ims = [bg.convert('RGB')] + [Image.open(OUT / k / f'{c}.png').convert('RGB') for k in cols[1:]]
            hh = round(col_w * src.height / src.width)
            row = Image.new('RGB', (col_w * len(cols), hh + 16), 'white')
            for i, im in enumerate(ims):
                row.paste(im.resize((col_w, hh), Image.LANCZOS), (i * col_w, 16))
            d = ImageDraw.Draw(row)
            d.text((4, 2), c, fill='black')
            for i, k in enumerate(cols[1:], start=1):
                m = (metrics or {}).get(c, {}).get(k)
                label = f"{k}: {m['areas']} areas, {m['crumbs']} crumbs, {m['free_ends']} open ends" if m else k
                d.text((i * col_w + 4, 2), label, fill='black')
            rows.append(row)
        sheet = Image.new('RGB', (rows[0].width, sum(r.height + 8 for r in rows)), (200, 200, 200))
        y = 0
        for r in rows:
            sheet.paste(r, (0, y))
            y += r.height + 8
        sheet.save(OUT / f'sheet-{s // per_sheet + 1}.png')


def main():
    args = sys.argv[1:]
    flags = {a for a in args if a.startswith('--')}
    cards = [a for a in args if not a.startswith('--')] or (ROOT / 'scripts' / 'lineart-set.txt').read_text().split()
    if '--classify' in flags:
        classify(cards)
        return
    if '--all' not in flags and STYLE.exists():
        style = json.loads(STYLE.read_text())
        cards = [c for c in cards if style.get(c, {}).get('style') != 'soft']
    classic(cards)
    if '--metrics' not in flags:
        with Pool() as pool:
            pool.map(run_card, cards)
    sheets(cards, all_metrics(cards))


if __name__ == '__main__':
    main()
