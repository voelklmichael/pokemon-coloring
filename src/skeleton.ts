// 1 px line skeletons: thinning, cleanup and tracing into polylines (see docs/LINE_ART.md, steps 5–6).
// All masks are row-major Uint8Arrays (1 = set) whose outermost pixel ring must be empty,
// so neighbor lookups need no bounds checks.

/** Offsets of the 8 neighbors, clockwise from the top. */
const ring = (w: number) => [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1];

/** Clears the outermost pixel ring, in place. */
export function clearBorder(mask: Uint8Array, w: number, h: number): Uint8Array {
  for (let x = 0; x < w; x++) mask[x] = mask[(h - 1) * w + x] = 0;
  for (let y = 0; y < h; y++) mask[y * w] = mask[y * w + w - 1] = 0;
  return mask;
}

export function neighborCount(sk: Uint8Array, w: number, i: number): number {
  let n = 0;
  for (const d of ring(w)) n += sk[i + d];
  return n;
}

/** Set pixels with exactly one neighbor. */
export function endpoints(sk: Uint8Array, w: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sk.length; i++) if (sk[i] && neighborCount(sk, w, i) === 1) out.push(i);
  return out;
}

/** Zhang–Suen thinning to an 8-connected 1 px skeleton, plus removal of staircase corner pixels. */
export function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const img = clearBorder(mask.slice(), w, h);
  let todo: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i]) todo.push(i);
  const [n, ne, e, se, s, sw, wst, nw] = ring(w);
  for (let changed = true; changed; ) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del: number[] = [];
      for (const i of todo) {
        if (!img[i]) continue;
        const p = [img[i + n], img[i + ne], img[i + e], img[i + se], img[i + s], img[i + sw], img[i + wst], img[i + nw]];
        const b = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
        if (b < 2 || b > 6) continue;
        let a = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
        if (a !== 1) continue;
        if (step === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
        del.push(i);
      }
      for (const i of del) img[i] = 0;
      if (del.length) changed = true;
    }
    todo = todo.filter((i) => img[i]);
  }
  // Staircases: a pixel between two perpendicular 4-neighbors is redundant if its neighbors stay connected.
  for (const i of todo) {
    const p = ring(w).map((d) => img[i + d]);
    const corner = (p[0] && p[2]) || (p[2] && p[4]) || (p[4] && p[6]) || (p[6] && p[0]);
    if (corner && ringComponents(p) === 1) img[i] = 0;
  }
  return img;
}

/** Number of 8-connected groups among the set pixels of a neighbor ring (clockwise from the top). */
function ringComponents(p: number[]): number {
  const parent = [0, 1, 2, 3, 4, 5, 6, 7];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const join = (a: number, b: number) => {
    if (p[a] && p[b]) parent[find(a)] = find(b);
  };
  for (let k = 0; k < 8; k++) join(k, (k + 1) % 8);
  for (let k = 0; k < 8; k += 2) join(k, (k + 2) % 8); // two 4-neighbors next to the same corner touch diagonally
  const roots = new Set<number>();
  for (let k = 0; k < 8; k++) if (p[k]) roots.add(find(k));
  return roots.size;
}

/** Removes spurs shorter than n px: peels line ends n times, then regrows the surviving ends within the original. */
export function prune(sk: Uint8Array, w: number, h: number, n: number): Uint8Array {
  const out = sk.slice();
  for (let k = 0; k < n; k++) for (const i of endpoints(out, w)) out[i] = 0;
  let front = endpoints(out, w);
  for (let k = 0; k < n && front.length; k++) {
    const next: number[] = [];
    for (const i of front) {
      for (const d of ring(w)) {
        if (sk[i + d] && !out[i + d]) {
          out[i + d] = 1;
          next.push(i + d);
        }
      }
    }
    front = next;
  }
  return thin(out, w, h);
}

/** Follows a line from an endpoint for up to `steps` px; stops at junctions. Returns pixel indices. */
export function traceBack(sk: Uint8Array, w: number, start: number, steps: number): number[] {
  const path = [start];
  let cur = start;
  for (let k = 0; k < steps; k++) {
    const recent = path.slice(-3);
    const next = ring(w).map((d) => cur + d).filter((j) => sk[j] && !recent.includes(j));
    if (next.length !== 1) break;
    cur = next[0];
    path.push(cur);
  }
  return path;
}

/** Draws a 1 px line (Bresenham), in place. */
export function drawLine(mask: Uint8Array, w: number, a: number, b: number) {
  let x0 = a % w, y0 = (a - x0) / w;
  const x1 = b % w, y1 = (b - x1) / w;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    mask[y0 * w + x0] = 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Buckets pixel indices into a coarse grid for radius queries. */
class PointGrid {
  private cells = new Map<number, number[]>();
  constructor(private w: number, private cell: number, points: Iterable<number>) {
    for (const i of points) {
      const key = this.key(i % w, Math.floor(i / w));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }
  private key(x: number, y: number) {
    return Math.floor(y / this.cell) * 100003 + Math.floor(x / this.cell);
  }
  /** Points within `r` of (x, y), with their distance. */
  near(x: number, y: number, r: number): [number, number][] {
    const out: [number, number][] = [];
    const c = this.cell;
    for (let cy = Math.floor((y - r) / c); cy <= Math.floor((y + r) / c); cy++) {
      for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
        for (const i of this.cells.get(cy * 100003 + cx) ?? []) {
          const px = i % this.w, py = (i - px) / this.w;
          const d = Math.hypot(px - x, py - y);
          if (d <= r) out.push([i, d]);
        }
      }
    }
    return out;
  }
}

function setPixels(mask: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
  return out;
}

/** Unit direction in which a line runs out at its endpoint, from the pixel `back` steps before it. */
function direction(w: number, path: number[], back: number): [number, number] {
  const e = path[0], b = path[Math.min(path.length - 1, back)];
  const dx = (e % w) - (b % w), dy = Math.floor(e / w) - Math.floor(b / w);
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * Connects each free line end to the nearest line (or target pixel) roughly ahead of it, within `radius`.
 * `back` is how far back along the line its direction is measured.
 */
export function closeGaps(sk: Uint8Array, targets: Uint8Array, w: number, radius: number, back: number): Uint8Array {
  const out = sk.slice();
  const all = new Uint8Array(sk.length);
  for (let i = 0; i < sk.length; i++) all[i] = sk[i] | targets[i];
  const grid = new PointGrid(w, Math.max(4, Math.ceil(radius)), setPixels(all));
  for (const e of endpoints(sk, w)) {
    const path = traceBack(sk, w, e, Math.floor(radius * 1.5));
    if (path.length < 4) continue;
    const own = new Set(path);
    const [dx, dy] = direction(w, path, back);
    const ex = e % w, ey = (e - ex) / w;
    let best = -1, bestScore = Infinity;
    for (const [q, dist] of grid.near(ex, ey, radius)) {
      if (own.has(q) || dist < 1.5) continue;
      const qx = q % w, qy = (q - qx) / w;
      const cos = ((qx - ex) * dx + (qy - ey) * dy) / dist;
      if (cos < 0.5) continue; // more than 60° off the line's direction
      const score = dist * (2 - cos);
      if (score < bestScore) {
        bestScore = score;
        best = q;
      }
    }
    if (best >= 0) drawLine(out, w, e, best);
  }
  return out;
}

/**
 * Connects free line ends near the silhouette to it. Interior lines are clipped short of the outline,
 * and a small gap there lets the color leak into the neighboring area. Ends farther than `ahead` from the
 * outline only connect if the outline lies ahead of the line, not behind it.
 */
export function closeToOutline(sk: Uint8Array, edge: Uint8Array, w: number, radius: number, ahead: number, back: number) {
  const out = sk.slice();
  const grid = new PointGrid(w, Math.max(4, Math.ceil(radius)), setPixels(edge));
  for (const e of endpoints(sk, w)) {
    const ex = e % w, ey = (e - ex) / w;
    let best = -1, bestDist = Infinity;
    for (const [q, d] of grid.near(ex, ey, radius)) {
      if (d < bestDist) {
        bestDist = d;
        best = q;
      }
    }
    if (best < 0) continue;
    const path = traceBack(sk, w, e, back);
    if (path.length > 2 && bestDist > ahead) {
      const [dx, dy] = direction(w, path, back);
      const qx = best % w, qy = (best - qx) / w;
      if ((qx - ex) * dx + (qy - ey) * dy < 0) continue;
    }
    drawLine(out, w, e, best);
  }
  return out;
}

/** Removes strokes that end freely (not near an anchor) and are shorter than minLen: open hairs that bound nothing. */
export function removeDangling(sk: Uint8Array, w: number, minLen: number, anchors: Uint8Array): Uint8Array {
  const out = sk.slice();
  for (const e of endpoints(sk, w)) {
    if (anchors[e]) continue;
    const path = traceBack(sk, w, e, minLen);
    if (path.length >= minLen) continue;
    const last = path[path.length - 1];
    if (neighborCount(sk, w, last) > 2) path.pop(); // keep the junction pixel the stroke hangs on
    for (const i of path) out[i] = 0;
  }
  return out;
}

export type Point = [x: number, y: number];

/** Splits a skeleton into polylines between endpoints and junctions; closed loops end with their first point. */
export function tracePaths(sk: Uint8Array, w: number): Point[][] {
  const node = new Uint8Array(sk.length);
  for (let i = 0; i < sk.length; i++) if (sk[i] && neighborCount(sk, w, i) !== 2) node[i] = 1;
  const visited = new Uint8Array(sk.length);
  const offsets = ring(w);
  const paths: number[][] = [];

  const walk = (start: number, first: number) => {
    const path = [start, first];
    visited[first] = 1;
    let prev = start, cur = first;
    while (!node[cur]) {
      const cand = offsets.map((d) => cur + d).filter((j) => sk[j] && j !== prev && (node[j] || !visited[j]));
      if (!cand.length) break;
      // Prefer a node; otherwise the closest (4-connected) neighbor.
      const next = cand.find((j) => node[j]) ?? cand.find((j) => Math.abs(j - cur) === 1 || Math.abs(j - cur) === w) ?? cand[0];
      if (!node[next]) visited[next] = 1;
      prev = cur;
      cur = next;
      path.push(cur);
    }
    return path;
  };

  for (let n = 0; n < sk.length; n++) {
    if (!node[n]) continue;
    for (const d of offsets) {
      const q = n + d;
      if (!sk[q]) continue;
      if (node[q]) {
        if (n < q) paths.push([n, q]);
      } else if (!visited[q]) {
        paths.push(walk(n, q));
      }
    }
  }
  for (let s = 0; s < sk.length; s++) {
    if (!sk[s] || visited[s] || node[s]) continue;
    visited[s] = 1;
    const first = offsets.map((d) => s + d).find((j) => sk[j]);
    if (first === undefined) continue;
    const p = walk(s, first);
    if (p.length > 2) paths.push([...p, s]);
  }
  return paths.map((p) => p.map((i) => [i % w, Math.floor(i / w)] as Point));
}

/** Gaussian smoothing along a polyline. Open lines keep their end points, so lines still meet at junctions. */
export function smoothPath(pts: Point[], sigma: number, closed: boolean): Point[] {
  if (pts.length < 5) return pts;
  const r = Math.ceil(2.5 * sigma);
  const kernel = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  const n = closed ? pts.length - 1 : pts.length; // a closed path repeats its first point at the end
  const at = (k: number) => (closed ? pts[((k % n) + n) % n] : pts[Math.min(Math.max(k, 0), n - 1)]);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, sum = 0;
    for (let k = -r; k <= r; k++) {
      const p = at(i + k);
      x += p[0] * kernel[k + r];
      y += p[1] * kernel[k + r];
      sum += kernel[k + r];
    }
    out.push([x / sum, y / sum]);
  }
  if (closed) out.push(out[0]);
  else {
    out[0] = pts[0];
    out[n - 1] = pts[n - 1];
  }
  return out;
}
