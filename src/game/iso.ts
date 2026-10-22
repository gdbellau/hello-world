// Isometric projection helpers. World space is a tile grid (x right-down,
// y left-down); screen space is pixels relative to the camera origin.

export const TILE_W = 64;
export const TILE_H = 32;

export interface Vec {
  x: number;
  y: number;
}

export function worldToScreen(wx: number, wy: number): Vec {
  return { x: ((wx - wy) * TILE_W) / 2, y: ((wx + wy) * TILE_H) / 2 };
}

export function screenToWorld(sx: number, sy: number): Vec {
  return {
    x: sy / TILE_H + sx / TILE_W,
    y: sy / TILE_H - sx / TILE_W,
  };
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
