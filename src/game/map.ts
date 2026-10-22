import type { Vec } from "./iso";

export const enum Tile {
  Floor = 0,
  Wall = 1,
  Cover = 2, // waist-high: blocks movement, not vision
  Extract = 3,
  Door = 4, // locked door: blocks movement and vision until hacked open
  Fixture = 5, // camera pole, turret, terminal: blocks movement, not vision
}

export class TileMap {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly tiles: Uint8Array,
  ) {}

  /** Independent copy, so a Sim can mutate tiles (doors) without touching the MissionDef. */
  clone(): TileMap {
    return new TileMap(this.width, this.height, new Uint8Array(this.tiles));
  }

  get(x: number, y: number): Tile {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return Tile.Wall;
    return this.tiles[y * this.width + x] as Tile;
  }

  set(x: number, y: number, t: Tile): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.tiles[y * this.width + x] = t;
  }

  walkable(x: number, y: number): boolean {
    const t = this.get(x, y);
    return t === Tile.Floor || t === Tile.Extract;
  }

  blocksSight(x: number, y: number): boolean {
    const t = this.get(x, y);
    return t === Tile.Wall || t === Tile.Door;
  }

  /** Bresenham line-of-sight between tile centres. */
  lineOfSight(a: Vec, b: Vec): boolean {
    let x0 = Math.floor(a.x);
    let y0 = Math.floor(a.y);
    const x1 = Math.floor(b.x);
    const y1 = Math.floor(b.y);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (this.blocksSight(x0, y0)) return false;
      if (x0 === x1 && y0 === y1) return true;
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

  /**
   * 8-way A* with no corner cutting. Returns tile centres, excluding start.
   * With `near`, the goal tile itself may be blocked (a terminal, a turret, a
   * door) and the path ends on the closest walkable tile touching it.
   */
  findPath(from: Vec, to: Vec, near = false): Vec[] | null {
    const sx = Math.floor(from.x);
    const sy = Math.floor(from.y);
    const gx = Math.floor(to.x);
    const gy = Math.floor(to.y);
    if (!near && !this.walkable(gx, gy)) return null;
    const W = this.width;
    const N = W * this.height;
    if (sx < 0 || sy < 0 || sx >= W || sy >= this.height) return null;
    const idx = (x: number, y: number) => y * W + x;
    const start = idx(sx, sy);
    const isGoal = near
      ? (i: number) => Math.max(Math.abs((i % W) - gx), Math.abs(Math.floor(i / W) - gy)) <= 1 && (i === start || this.walkable(i % W, Math.floor(i / W))) && i !== idx(gx, gy)
      : (i: number) => i === idx(gx, gy);
    if (near && this.walkable(gx, gy) && Math.max(Math.abs(sx - gx), Math.abs(sy - gy)) === 0) return [];
    const g = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const h = (i: number) => {
      const dx = Math.abs((i % W) - gx);
      const dy = Math.abs(Math.floor(i / W) - gy);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const heap = new MinHeap();
    heap.push(start, h(start));
    g[start] = 0;
    let goal = -1;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      if (isGoal(cur)) {
        goal = cur;
        break;
      }
      closed[cur] = 1;
      const cx = cur % W;
      const cy = Math.floor(cur / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.walkable(nx, ny)) continue;
          if (dx && dy && (!this.walkable(cx + dx, cy) || !this.walkable(cx, cy + dy))) continue;
          const n = idx(nx, ny);
          if (closed[n]) continue;
          const cost = g[cur]! + (dx && dy ? Math.SQRT2 : 1);
          if (cost < g[n]!) {
            g[n] = cost;
            came[n] = cur;
            heap.push(n, cost + h(n));
          }
        }
      }
    }
    if (goal === -1) return null;
    const path: Vec[] = [];
    for (let c = goal; c !== start; c = came[c]!) path.push({ x: (c % W) + 0.5, y: Math.floor(c / W) + 0.5 });
    return path.reverse();
  }
}

/** Tiny binary min-heap of (node, priority) for A*. */
class MinHeap {
  private nodes: number[] = [];
  private prio: number[] = [];
  get size(): number {
    return this.nodes.length;
  }
  push(n: number, p: number): void {
    const a = this.nodes;
    const q = this.prio;
    a.push(n);
    q.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (q[parent]! <= q[i]!) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      [q[parent], q[i]] = [q[i]!, q[parent]!];
      i = parent;
    }
  }
  pop(): number {
    const a = this.nodes;
    const q = this.prio;
    const top = a[0]!;
    const lastN = a.pop()!;
    const lastP = q.pop()!;
    if (a.length) {
      a[0] = lastN;
      q[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && q[l]! < q[m]!) m = l;
        if (r < a.length && q[r]! < q[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        [q[m], q[i]] = [q[i]!, q[m]!];
        i = m;
      }
    }
    return top;
  }
}
