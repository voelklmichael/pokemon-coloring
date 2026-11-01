// Flat color areas (docs/LINE_ART.md, step 4): SLIC superpixels, merged across weak borders, then by size.
// Images are interleaved 3-channel Float32Arrays (CIELAB); label 0 is the background.
import { blur } from './lineart';

/** Binary min-heap of [priority, payload] pairs. */
export class MinHeap<T> {
  private items: [number, T][] = [];
  get size() {
    return this.items.length;
  }
  push(priority: number, value: T) {
    const a = this.items;
    a.push([priority, value]);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, T] | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * SLIC superpixels inside the mask: about `n` regions of similar color, compact by `compactness`
 * (Lab units per grid step). Returns labels 1.. for mask pixels, 0 elsewhere; each label is connected.
 */
export function slic(lab: Float32Array, mask: Uint8Array, w: number, h: number, n: number, compactness = 12): Int32Array {
  let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      area++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  const labels = new Int32Array(w * h);
  if (!area) return labels;
  const step = Math.max(2, Math.sqrt(area / n));
  // Centers: x, y, L, a, b
  const centers: number[][] = [];
  for (let y = y0 + step / 2; y <= y1; y += step) {
    for (let x = x0 + step / 2; x <= x1; x += step) {
      const i = Math.round(y) * w + Math.round(x);
      if (mask[i]) centers.push([Math.round(x), Math.round(y), lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
    }
  }
  if (!centers.length) {
    for (let i = 0; i < mask.length; i++) labels[i] = mask[i];
    return labels;
  }
  const spatial = (compactness / step) ** 2;
  const dist = new Float32Array(w * h);
  const assign = new Int32Array(w * h).fill(-1);
  const r = Math.ceil(step);
  for (let iter = 0; iter < 10; iter++) {
    dist.fill(Infinity);
    centers.forEach(([cx, cy, cl, ca, cb], k) => {
      for (let y = Math.max(cy - r, 0); y <= Math.min(cy + r, h - 1); y++) {
        for (let x = Math.max(cx - r, 0); x <= Math.min(cx + r, w - 1); x++) {
          const i = y * w + x;
          if (!mask[i]) continue;
          const dl = lab[i * 3] - cl, da = lab[i * 3 + 1] - ca, db = lab[i * 3 + 2] - cb;
          const d = dl * dl + da * da + db * db + ((x - cx) ** 2 + (y - cy) ** 2) * spatial;
          if (d < dist[i]) {
            dist[i] = d;
            assign[i] = k;
          }
        }
      }
    });
    const sums = centers.map(() => [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < assign.length; i++) {
      const k = assign[i];
      if (k < 0) continue;
      const s = sums[k], x = i % w;
      s[0] += x;
      s[1] += (i - x) / w;
      s[2] += lab[i * 3];
      s[3] += lab[i * 3 + 1];
      s[4] += lab[i * 3 + 2];
      s[5]++;
    }
    sums.forEach((s, k) => {
      if (s[5]) centers[k] = [Math.round(s[0] / s[5]), Math.round(s[1] / s[5]), s[2] / s[5], s[3] / s[5], s[4] / s[5]];
    });
  }
  return enforceConnectivity(assign, mask, w, h, Math.max(1, (step * step) / 4));
}

/** Gives every 4-connected piece of each superpixel its own label; pieces below minSize join a neighbor. */
function enforceConnectivity(assign: Int32Array, mask: Uint8Array, w: number, h: number, minSize: number): Int32Array {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const piece: number[] = [];
  let next = 1;
  for (let s = 0; s < labels.length; s++) {
    if (!mask[s] || labels[s]) continue;
    const label = next++;
    let sp = 0, adjacent = 0;
    piece.length = 0;
    labels[s] = label;
    stack[sp++] = s;
    while (sp > 0) {
      const i = stack[--sp];
      piece.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
        if (j < 0 || !mask[j]) continue;
        if (!labels[j] && assign[j] === assign[s]) {
          labels[j] = label;
          stack[sp++] = j;
        } else if (labels[j] && labels[j] !== label) {
          adjacent = labels[j];
        }
      }
    }
    if (piece.length < minSize && adjacent) {
      for (const i of piece) labels[i] = adjacent;
      next--;
    }
  }
  return labels;
}

type Edge = { sum: number; count: number };

/**
 * Region adjacency graph with union-find merging. An edge's weight is the mean border strength along the
 * shared border, so a shading gradient (weak everywhere) merges while a border between two colors stays.
 * Label 0 (background) never merges.
 */
export class RegionGraph {
  private parent: Int32Array;
  readonly area: Float64Array;
  private edges: Map<number, Edge>[];

  constructor(private labels: Int32Array, strength: Float32Array, w: number, h: number) {
    let count = 0;
    for (const l of labels) if (l >= count) count = l + 1;
    this.parent = Int32Array.from({ length: count }, (_, i) => i);
    this.area = new Float64Array(count);
    for (const l of labels) this.area[l]++;
    this.edges = Array.from({ length: count }, () => new Map<number, Edge>());
    const add = (i: number, j: number) => {
      const a = labels[i], b = labels[j];
      if (a === b) return;
      const s = Math.max(strength[i], strength[j]);
      let e = this.edges[a].get(b);
      if (!e) {
        e = { sum: 0, count: 0 };
        this.edges[a].set(b, e);
        this.edges[b].set(a, e);
      }
      e.sum += s;
      e.count++;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x < w - 1) add(i, i + 1);
        if (y < h - 1) add(i, i + w);
      }
    }
  }

  private find(x: number): number {
    while (this.parent[x] !== x) x = this.parent[x] = this.parent[this.parent[x]];
    return x;
  }

  /** Merges a into b. */
  private union(a: number, b: number) {
    this.parent[a] = b;
    this.area[b] += this.area[a];
    for (const [n, e] of this.edges[a]) {
      if (n === b) continue;
      const other = this.edges[b].get(n);
      if (other) {
        other.sum += e.sum;
        other.count += e.count;
      } else {
        this.edges[b].set(n, e);
      }
      this.edges[n].delete(a);
      this.edges[n].set(b, other ?? e);
    }
    this.edges[b].delete(a);
    this.edges[a].clear();
  }

  private static mean(e: Edge) {
    return e.sum / e.count;
  }

  /** Merges neighbors across the weakest border first, while the border is weaker than `thresh`. */
  mergeWeak(thresh: number) {
    const heap = new MinHeap<[number, number]>();
    this.edges.forEach((m, a) => {
      for (const [b, e] of m) if (0 < a && a < b) heap.push(RegionGraph.mean(e), [a, b]);
    });
    while (heap.size) {
      const [weight, [a0, b0]] = heap.pop()!;
      if (weight >= thresh) break;
      const e = this.edges[a0].get(b0);
      if (!e || RegionGraph.mean(e) !== weight) continue; // stale
      const [a, b] = this.area[a0] > this.area[b0] ? [b0, a0] : [a0, b0];
      this.union(a, b);
      for (const [n, e2] of this.edges[b]) if (n) heap.push(RegionGraph.mean(e2), [Math.min(b, n), Math.max(b, n)]);
    }
  }

  /** Merges regions smaller than minArea into the neighbor with the weakest border, smallest first. */
  mergeSmall(minArea: number, keep: (label: number) => boolean) {
    const heap = new MinHeap<number>();
    for (let i = 1; i < this.parent.length; i++) {
      if (this.parent[i] === i && this.area[i] > 0 && this.area[i] < minArea && !keep(i)) heap.push(this.area[i], i);
    }
    while (heap.size) {
      const [area, i] = heap.pop()!;
      if (this.parent[i] !== i || this.area[i] !== area) continue;
      let best = -1, bestWeight = Infinity;
      for (const [n, e] of this.edges[i]) {
        if (!n || keep(n)) continue;
        const weight = RegionGraph.mean(e);
        if (weight < bestWeight) {
          bestWeight = weight;
          best = n;
        }
      }
      if (best < 0) continue;
      this.union(i, best);
      if (this.area[best] < minArea) heap.push(this.area[best], best);
    }
  }

  /** Current labels; each region keeps the label of its root, so per-label arrays stay valid. */
  result(): Int32Array {
    const roots = Int32Array.from(this.parent, (_, i) => this.find(i));
    const out = new Int32Array(this.labels.length);
    for (let i = 0; i < out.length; i++) out[i] = roots[this.labels[i]];
    return out;
  }
}

/** Straightens region borders: each mask pixel takes the label with the highest blurred share around it. */
export function smoothLabels(labels: Int32Array, mask: Uint8Array, w: number, h: number, radius: number): Int32Array {
  const box = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      const b = box.get(l);
      if (!b) box.set(l, [x, y, x, y]);
      else {
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
      }
    }
  }
  const best = new Float32Array(w * h);
  const out = labels.slice();
  const pad = 3 * radius;
  for (const [l, [bx0, by0, bx1, by1]] of box) {
    const x0 = Math.max(bx0 - pad, 0), y0 = Math.max(by0 - pad, 0);
    const bw = Math.min(bx1 + pad, w - 1) - x0 + 1, bh = Math.min(by1 + pad, h - 1) - y0 + 1;
    const share = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) share[y * bw + x] = labels[(y0 + y) * w + x0 + x] === l ? 1 : 0;
    const soft = blur(share, bw, bh, radius);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = (y0 + y) * w + x0 + x;
        if (soft[y * bw + x] > best[i]) {
          best[i] = soft[y * bw + x];
          out[i] = l;
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (!mask[i]) out[i] = 0;
  return out;
}
