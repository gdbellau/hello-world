import type { Vec } from "./iso";

export const enum Tile {
  Floor = 0,
  Wall = 1,
  Cover = 2, // waist-high: blocks movement, not vision
  Extract = 3,
}

export class TileMap {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly tiles: Uint8Array,
  ) {}

  get(x: number, y: number): Tile {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return Tile.Wall;
    return this.tiles[y * this.width + x] as Tile;
  }

  walkable(x: number, y: number): boolean {
    const t = this.get(x, y);
    return t === Tile.Floor || t === Tile.Extract;
  }

  blocksSight(x: number, y: number): boolean {
    return this.get(x, y) === Tile.Wall;
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

  /** 8-way A* with no corner cutting. Returns tile centres, excluding start. */
  findPath(from: Vec, to: Vec): Vec[] | null {
    const sx = Math.floor(from.x);
    const sy = Math.floor(from.y);
    const gx = Math.floor(to.x);
    const gy = Math.floor(to.y);
    if (!this.walkable(gx, gy)) return null;
    const W = this.width;
    const idx = (x: number, y: number) => y * W + x;
    const start = idx(sx, sy);
    const goal = idx(gx, gy);
    const g = new Float64Array(W * this.height).fill(Infinity);
    const came = new Int32Array(W * this.height).fill(-1);
    const closed = new Uint8Array(W * this.height);
    const h = (i: number) => {
      const dx = Math.abs((i % W) - gx);
      const dy = Math.abs(Math.floor(i / W) - gy);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    // A binary heap is overkill for maps this size; a flat open list is fine.
    const open: number[] = [start];
    g[start] = 0;
    while (open.length) {
      let best = 0;
      for (let i = 1; i < open.length; i++) {
        if (g[open[i]!]! + h(open[i]!) < g[open[best]!]! + h(open[best]!)) best = i;
      }
      const cur = open.splice(best, 1)[0]!;
      if (cur === goal) break;
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
            if (!open.includes(n)) open.push(n);
          }
        }
      }
    }
    if (came[goal] === -1 && goal !== start) return null;
    const path: Vec[] = [];
    for (let c = goal; c !== start; c = came[c]!) path.push({ x: (c % W) + 0.5, y: Math.floor(c / W) + 0.5 });
    return path.reverse();
  }
}
