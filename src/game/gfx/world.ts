// World baking: a tiny per-pixel software renderer that turns the tile map
// into lit pixel-art layers once per mission.
//
// - The floor layer is one canvas at art resolution (1 art px = ART css px).
// - Every wall and cover tile gets its own small canvas so the painter's
//   algorithm can interleave them with units and fade them for cut-aways.
// - Static lights (neon signs, ceiling lamps, windows, monitors, extraction
//   pad) are baked in with per-tile line-of-sight, dithered and posterised.
// Dynamic effects (muzzle flashes, flicker, alarms) are added at runtime.

import type { SettingsMap } from "../../../shared/settings";
import { Tile, type TileMap } from "../map";
import { ART, ctx2d, makeCanvas, type Canvas2D } from "./canvas";
import { bayer4, hash2, rand2, rng } from "./hash";

/** Wall height in art px (×ART in css px). */
export const WALL_H = 28;
/** Cover block height in art px. */
export const COVER_H = 9;
const PROP_H = 14;

type V3 = [number, number, number];

export interface Light {
  x: number;
  y: number;
  z: number;
  col: V3;
  radius: number;
  intensity: number;
  kind: "sign" | "lamp" | "window" | "screen" | "extract" | "holo";
  /** Floor tile the light shines from (for line-of-sight). */
  tx: number;
  ty: number;
}

/** Runtime glow sprite attached to a wall/cover tile (drawn additively after it). */
export interface Glow {
  /** CSS px, world-screen space (same as worldToScreen). */
  x: number;
  y: number;
  rx: number;
  ry: number;
  color: string;
  flicker: number; // 0 = steady
  seed: number;
}

export interface BlockSprite {
  /** Shared atlas canvas; the block lives in the (sx, sy, sw, sh) art-px rect. */
  canvas: Canvas2D;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** CSS px position of the canvas origin in world-screen space. */
  x: number;
  y: number;
  /** Painter depth. */
  depth: number;
  tx: number;
  ty: number;
  wall: boolean;
  glows: Glow[];
}

export interface WorldBake {
  floor: Canvas2D;
  /** CSS px position of the floor canvas origin. */
  fx: number;
  fy: number;
  blocks: BlockSprite[];
  /** Index by y*width+x → block, for cut-away lookup. */
  blockAt: (BlockSprite | undefined)[];
  lights: Light[];
  /** Per-tile light level 0-3 for sprite shading. */
  tileLevel: Uint8Array;
  extract: { x: number; y: number }[];
  lamps: Light[];
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Colour helpers (linear-ish 0..1 floats)

const hex = (h: string): V3 => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const C = {
  magenta: hex("#ff2bd6"),
  cyan: hex("#00f0ff"),
  yellow: hex("#ffe14d"),
  green: hex("#39ff8c"),
  red: hex("#ff3b5c"),
  orange: hex("#ff8a1f"),
  blue: hex("#4d7cff"),
  violet: hex("#9b5cff"),
};
const NEON_COLS: V3[] = [C.magenta, C.cyan, C.yellow, C.magenta, C.cyan, C.violet, C.red, C.green];
const toCss = (c: V3) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

// ---------------------------------------------------------------------------
// Pixel output with dithered posterisation

function put(data: Uint8ClampedArray, o: number, px: number, py: number, r: number, g: number, b: number): void {
  const d = bayer4(px, py);
  const q = 6; // ~42 levels per channel, dithered
  data[o] = Math.floor((r * 255) / q + d) * q;
  data[o + 1] = Math.floor((g * 255) / q + d) * q;
  data[o + 2] = Math.floor((b * 255) / q + d) * q;
  data[o + 3] = 255;
}

// ---------------------------------------------------------------------------
// Procedural "kanji" glyphs for signs (6×7 bitmaps)

function glyph(seed: number): boolean[] {
  const r = rng(seed);
  const g = new Array<boolean>(6 * 7).fill(false);
  const set = (x: number, y: number) => {
    if (x >= 0 && x < 6 && y >= 0 && y < 7) g[y * 6 + x] = true;
  };
  const hRows = 1 + Math.floor(r() * 3);
  for (let i = 0; i < hRows; i++) {
    const y = Math.floor(r() * 7);
    const x0 = Math.floor(r() * 2);
    const x1 = 4 + Math.floor(r() * 2);
    for (let x = x0; x <= x1; x++) set(x, y);
  }
  const vCols = 1 + Math.floor(r() * 2);
  for (let i = 0; i < vCols; i++) {
    const x = 1 + Math.floor(r() * 4);
    const y0 = Math.floor(r() * 3);
    const y1 = 4 + Math.floor(r() * 3);
    for (let y = y0; y <= y1; y++) set(x, y);
  }
  if (r() < 0.6) {
    // A radical box.
    const bx = r() < 0.5 ? 0 : 3;
    for (let k = 0; k < 3; k++) {
      set(bx + k, 1);
      set(bx + k, 4);
      set(bx, 1 + k);
      set(bx + 2, 1 + k);
    }
  }
  if (r() < 0.5) set(Math.floor(r() * 6), 6), set(Math.floor(r() * 6), 0);
  return g;
}

// ---------------------------------------------------------------------------
// Face decoration

type Decor = "plain" | "sign" | "holo" | "window" | "vent" | "screen" | "pipes";

interface FaceInfo {
  decor: Decor;
  color: V3;
  color2: V3;
  trim: V3 | null;
  seed: number;
  glyphs: boolean[][];
  rows: number; // sign glyph count
}

interface Px {
  a: V3; // albedo
  e: V3; // emissive
  gloss: number;
}

// -0 keeps this a double array, matching every other colour (avoids polymorphic loads).
const ZERO: V3 = [-0, -0, -0];

function wallFacePx(u: number, v: number, f: FaceInfo, out: Px): void {
  // Base panelling.
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  let a: V3 = [0.25, 0.23, 0.47];
  let e: V3 = ZERO;
  let gloss = 0.12;
  const seam = iu % 8 === 0;
  if (seam) a = [0.16, 0.15, 0.32];
  if (iv === 9 || iv === 10) a = iv === 9 ? [0.32, 0.3, 0.56] : [0.17, 0.16, 0.34];
  if (iv >= WALL_H - 3) a = [0.12, 0.11, 0.22]; // baseboard
  if (iv === WALL_H - 4) a = [0.3, 0.28, 0.52];
  // Neon trim along the top edge.
  if (f.trim && iv <= 1) {
    e = iv === 0 ? f.trim : mul(f.trim, 0.45);
    a = [0.1, 0.1, 0.15];
  }
  // Lower accent strip on some walls.
  const r = (f.seed >>> 8) & 255;
  if (f.trim && r < 60 && iv === WALL_H - 4) e = mul(f.trim, 0.55);

  switch (f.decor) {
    case "sign": {
      const x0 = 4;
      const x1 = 12;
      const y0 = 3;
      const y1 = 3 + f.rows * 8 + 1;
      if (iu >= x0 && iu < x1 && iv >= y0 && iv < y1) {
        a = [0.04, 0.03, 0.08];
        gloss = 0.3;
        const border = iu === x0 || iu === x1 - 1 || iv === y0 || iv === y1 - 1;
        if (border) e = mul(f.color, 0.75);
        else {
          const gi = Math.floor((iv - y0 - 1) / 8);
          const gy = (iv - y0 - 1) % 8;
          const gx = iu - x0 - 1;
          const gl = f.glyphs[gi];
          if (gl && gy < 7 && gx >= 0 && gx < 6 && gl[gy * 6 + gx]) e = f.color;
          else e = mul(f.color, 0.08);
        }
      }
      break;
    }
    case "holo": {
      const x0 = 2;
      const x1 = 14;
      const y0 = 4;
      const y1 = 17;
      if (iu >= x0 && iu < x1 && iv >= y0 && iv < y1) {
        const t = (iv - y0) / (y1 - y0);
        const base = mix3(f.color, f.color2, t);
        a = [0.03, 0.03, 0.06];
        const scan = iv % 2 === 0 ? 1 : 0.55;
        // A simple pictogram: a head-and-shoulders silhouette or a logo ring.
        const cx = (x0 + x1) / 2 - 0.5;
        const dx = iu - cx;
        const dy = iv - (y0 + 5);
        const kind = f.seed & 1;
        let ink = false;
        if (kind === 0) ink = dx * dx + dy * dy < 7 || (iv >= y0 + 9 && Math.abs(dx) < 4 - (y1 - iv) * 0.2);
        else ink = Math.abs(Math.sqrt(dx * dx + dy * dy) - 3.5) < 0.9 || (iv === y1 - 3 && Math.abs(dx) < 4);
        const edge = iu === x0 || iu === x1 - 1 || iv === y0 || iv === y1 - 1;
        e = mul(base, (ink ? 1 : 0.28) * scan + (edge ? 0.4 : 0));
      }
      break;
    }
    case "window": {
      const x0 = 1;
      const x1 = 15;
      const y0 = 3;
      const y1 = 21;
      if (iu >= x0 && iu < x1 && iv >= y0 && iv < y1) {
        const frame = iu === x0 || iu === x1 - 1 || iv === y0 || iv === y1 - 1 || iu === 8;
        if (frame) a = [0.2, 0.2, 0.3];
        else {
          a = [0.02, 0.03, 0.08];
          gloss = 0.5;
          // Distant skyline: building masses with lit windows.
          const bh = 8 + (hash2(Math.floor((u + (f.seed & 31)) / 3), 0, f.seed) % 8);
          const sky = mix3([0.1, 0.03, 0.2], [0.02, 0.02, 0.07], (iv - y0) / (y1 - y0));
          e = mul(sky, 0.9);
          if (y1 - iv < bh) {
            e = [0.01, 0.01, 0.03];
            const lit = hash2(iu, iv, f.seed) % 7 === 0 && iv % 2 === 0;
            if (lit) e = mul(pickV(hash2(iu, iv, f.seed + 1)), 0.7);
          }
          // Glass reflection streak.
          if ((iu + iv) % 11 === 0) e = add3(e, [0.06, 0.08, 0.12]);
        }
      }
      break;
    }
    case "vent": {
      if (iu >= 3 && iu < 13 && iv >= 15 && iv < 24) {
        a = iv % 2 === 0 ? [0.08, 0.08, 0.13] : [0.34, 0.33, 0.45];
        if (iu === 3 || iu === 12) a = [0.2, 0.2, 0.3];
      }
      if (iu === 11 && iv === 13) e = C.red;
      break;
    }
    case "screen": {
      if (iu >= 4 && iu < 12 && iv >= 8 && iv < 15) {
        a = [0.03, 0.03, 0.05];
        const edge = iu === 4 || iu === 11 || iv === 8 || iv === 14;
        const text = iv % 2 === 1 && iu > 4 && iu < 11 && hash2(iu, iv, f.seed) % 3 !== 0;
        e = edge ? [0.15, 0.17, 0.25] : text ? mul(f.color, 0.85) : mul(f.color, 0.12);
      }
      if (iu >= 6 && iu < 10 && iv === 16) a = [0.35, 0.35, 0.45];
      break;
    }
    case "pipes": {
      if (iu === 2 || iu === 3 || iu === 5) {
        a = iu === 5 ? [0.3, 0.22, 0.2] : iu === 2 ? [0.42, 0.42, 0.52] : [0.25, 0.25, 0.33];
        gloss = 0.4;
        if (iv % 9 === 4) a = [0.5, 0.5, 0.6];
      }
      break;
    }
    case "plain":
      break;
  }
  out.a = a;
  out.e = e;
  out.gloss = gloss;
}

const mul = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const pickV = (h: number): V3 => [C.yellow, C.cyan, C.magenta, [1, 0.85, 0.6] as V3][h % 4]!;

// ---------------------------------------------------------------------------
// Floor materials

type Mat = "tile" | "grate" | "concrete" | "carpet";

function floorMaterial(x: number, y: number): Mat {
  const zx = Math.floor((x + (hash2(y, 3, 7) % 3)) / 6);
  const zy = Math.floor((y + (hash2(x, 5, 7) % 3)) / 6);
  const h = hash2(zx, zy, 11) % 10;
  return h < 4 ? "tile" : h < 6 ? "grate" : h < 9 ? "concrete" : "carpet";
}

interface FloorCtx {
  map: TileMap;
  extractDist: Uint8Array;
  W: number;
  /** Per-tile caches so the per-pixel loop does no hashing. */
  tile: Uint8Array;
  hash: Uint32Array;
  mat: Mat[];
}

function floorPx(fc: FloorCtx, x: number, y: number, u: number, v: number, px: number, py: number, out: Px): void {
  const ti = y * fc.W + x;
  const t = fc.tile[ti]!;
  const h = fc.hash[ti]!;
  let a: V3;
  let e: V3 = ZERO;
  let gloss = 0.18;
  const mat = fc.mat[ti]!;
  const tv = 0.94 + ((h & 15) / 15) * 0.12;
  switch (mat) {
    case "tile": {
      a = [0.2 * tv, 0.19 * tv, 0.4 * tv];
      // Each tile split into 2×2 slabs with bevelled seams.
      const su = (u * 2) % 1;
      const sv = (v * 2) % 1;
      if (su < 0.06 || sv < 0.06) a = [0.25, 0.24, 0.47];
      else if (su > 0.94 || sv > 0.94) a = [0.14, 0.13, 0.29];
      gloss = 0.32;
      break;
    }
    case "grate": {
      a = [0.17, 0.19, 0.27];
      const gu = (u * 6) % 1;
      if (gu < 0.35) a = [0.05, 0.05, 0.09];
      if (v < 0.06 || v > 0.94) a = [0.3, 0.31, 0.42];
      gloss = 0.28;
      break;
    }
    case "concrete": {
      const n = (hash2(px, py, 3) & 255) / 255;
      const k = 0.92 + n * 0.12;
      a = [0.2 * k, 0.19 * k, 0.29 * k];
      if (n > 0.97) a = [0.32, 0.3, 0.42];
      // Occasional crack.
      if ((h >>> 4) % 9 === 0 && Math.abs(u - v * 0.7 - 0.15 - Math.sin(v * 9) * 0.04) < 0.025) a = [0.06, 0.05, 0.1];
      gloss = 0.1;
      break;
    }
    case "carpet": {
      const n = bayer4(px >> 1, py) > 0.5 ? 1 : 0.9;
      a = [0.27 * n, 0.09 * n, 0.25 * n];
      if (u < 0.04 || v < 0.04) a = [0.33, 0.12, 0.3];
      gloss = 0.03;
      break;
    }
  }
  // Decals.
  const d = (h >>> 12) % 23;
  if (d === 0 && mat !== "carpet") {
    // Puddle: glossy, dark, reflects the neon.
    const dx = u - 0.5;
    const dy = v - 0.55;
    if (dx * dx * 1.6 + dy * dy + Math.sin(u * 13) * 0.01 < 0.07) {
      a = [0.03, 0.03, 0.07];
      gloss = 1.2;
    }
  } else if (d === 1 && mat !== "carpet") {
    // Drain.
    if (Math.abs(u - 0.5) + Math.abs(v - 0.5) < 0.16) a = (Math.floor(u * 20) % 2 ? [0.06, 0.06, 0.1] : [0.32, 0.32, 0.4]) as V3;
  } else if (d === 2) {
    // Painted guidance arrow.
    const au = u - 0.5;
    const av = v - 0.5;
    if (Math.abs(av) < 0.06 && au > -0.25 && au < 0.15) a = [0.55, 0.47, 0.12];
    if (au >= 0.1 && au < 0.3 && Math.abs(av) < 0.3 - au) a = [0.55, 0.47, 0.12];
  } else if (d === 3 && mat === "tile") {
    // Corp logo inlay: a triangle eye.
    const au = u - 0.5;
    const av = v - 0.5;
    const r = Math.sqrt(au * au + av * av);
    if (Math.abs(r - 0.28) < 0.03) e = mul(C.magenta, 0.25);
  }
  // Hazard stripes around the extraction zone.
  const ed = fc.extractDist[ti]!;
  if (t !== Tile.Extract && ed === 1) {
    const s = Math.floor((u + v) * 5) % 2;
    a = s ? [0.62, 0.5, 0.08] : [0.06, 0.05, 0.05];
    gloss = 0.15;
  }
  if (t === Tile.Extract) {
    a = [0.05, 0.16, 0.12];
    gloss = 0.4;
    const border = u < 0.06 || v < 0.06 || u > 0.94 || v > 0.94;
    // Chevrons pointing "east" in world space.
    const cv = Math.abs(v - 0.5);
    const cu = (u + cv * 0.9) * 3;
    const chev = cu % 1 < 0.28 && cv < 0.35;
    e = border ? mul(C.green, 0.55) : chev ? mul(C.green, 0.4) : mul(C.green, 0.04);
  }
  // Tactical grid, very faint.
  if (u < 0.035 || v < 0.035) e = add3(e, [0.0, 0.035, 0.05]);
  out.a = mul(a, 1.45);
  out.e = e;
  out.gloss = gloss;
}

// ---------------------------------------------------------------------------
// Cover props

type CoverKind = "crate" | "desk" | "planter" | "server";

function coverKind(map: TileMap, x: number, y: number): CoverKind {
  const h = hash2(x, y, 21) % 10;
  // Runs of cover read as desks or planters; singles as crates.
  const run = map.get(x + 1, y) === Tile.Cover || map.get(x - 1, y) === Tile.Cover || map.get(x, y + 1) === Tile.Cover || map.get(x, y - 1) === Tile.Cover;
  if (run) return h < 5 ? "desk" : h < 8 ? "planter" : "server";
  return h < 6 ? "crate" : h < 8 ? "planter" : "server";
}

function coverFacePx(kind: CoverKind, u: number, v: number, seed: number, out: Px): void {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  let a: V3 = [0.2, 0.2, 0.3];
  let e: V3 = ZERO;
  let gloss = 0.15;
  switch (kind) {
    case "crate": {
      a = [0.16, 0.3, 0.32];
      if (iu % 5 === 0) a = [0.1, 0.2, 0.22];
      if (iv <= 2) a = Math.floor((u + v) / 2) % 2 ? [0.7, 0.56, 0.1] : [0.06, 0.06, 0.06];
      if (iv === COVER_H - 1) a = [0.07, 0.12, 0.14];
      if (iv === 5 && iu >= 6 && iu <= 9 && hash2(iu, seed, 2) % 2) a = [0.75, 0.75, 0.8];
      break;
    }
    case "desk": {
      a = [0.13, 0.12, 0.2];
      if (iv === 0) a = [0.38, 0.38, 0.48];
      if (iv === 1) e = mul(C.cyan, 0.35);
      if (iu === 1 || iu === 14) a = [0.08, 0.08, 0.13];
      break;
    }
    case "planter": {
      a = [0.28, 0.28, 0.34];
      if (iv === 0) e = mul(C.green, 0.6);
      if (iv === COVER_H - 1) a = [0.12, 0.12, 0.16];
      gloss = 0.05;
      break;
    }
    case "server": {
      a = [0.06, 0.06, 0.1];
      if (iu % 4 === 0) a = [0.18, 0.18, 0.26];
      if (iv % 2 === 1 && iu % 4 !== 0 && hash2(iu, iv, seed) % 3 === 0) e = [C.green, C.cyan, C.red][hash2(iu, iv, seed + 1) % 3]!;
      gloss = 0.3;
      break;
    }
  }
  out.a = a;
  out.e = e;
  out.gloss = gloss;
}

function coverTopPx(kind: CoverKind, u: number, v: number, out: Px): void {
  let a: V3 = [0.3, 0.3, 0.4];
  let e: V3 = ZERO;
  switch (kind) {
    case "crate":
      a = [0.22, 0.38, 0.4];
      if (Math.abs(u - v) < 0.06 || Math.abs(u + v - 1) < 0.06) a = [0.12, 0.24, 0.26];
      if (u < 0.06 || v < 0.06) a = [0.3, 0.48, 0.5];
      break;
    case "desk":
      a = [0.42, 0.42, 0.52];
      if (u < 0.05 || v < 0.05) a = [0.55, 0.55, 0.65];
      break;
    case "planter":
      a = [0.1, 0.07, 0.06];
      if (u < 0.08 || v < 0.08 || u > 0.92 || v > 0.92) a = [0.34, 0.34, 0.4];
      break;
    case "server":
      a = [0.12, 0.12, 0.18];
      if ((Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0) a = [0.16, 0.16, 0.24];
      if (Math.abs(u - 0.5) < 0.1 && Math.abs(v - 0.5) < 0.1) e = mul(C.cyan, 0.6);
      break;
  }
  out.a = a;
  out.e = e;
  out.gloss = 0.2;
}

// ---------------------------------------------------------------------------
// Lighting

interface LightField {
  lights: Light[];
  byTile: number[][];
  ambient: V3;
  W: number;
  H: number;
}

function illuminate(lf: LightField, tileIdx: number, wx: number, wy: number, wz: number, nx: number, ny: number, nz: number, out: V3): void {
  let r = lf.ambient[0];
  let g = lf.ambient[1];
  let b = lf.ambient[2];
  const list = tileIdx >= 0 ? lf.byTile[tileIdx] : undefined;
  if (list) {
    for (const i of list) {
      const L = lf.lights[i]!;
      const dx = L.x - wx;
      const dy = L.y - wy;
      const dz = L.z - wz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const R2 = L.radius * L.radius;
      if (d2 >= R2) continue;
      const fall = (1 - d2 / R2) ** 2;
      const d = Math.sqrt(d2) || 1;
      const lam = (dx * nx + dy * ny + dz * nz) / d;
      if (lam <= 0) continue;
      const k = fall * L.intensity * (0.35 + 0.65 * lam);
      r += L.col[0] * k;
      g += L.col[1] * k;
      b += L.col[2] * k;
    }
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

function shadeOut(p: Px, l: V3, data: Uint8ClampedArray, o: number, px: number, py: number): void {
  // Diffuse + a glossy term that tints dark floors with nearby neon + emissive.
  const lr = Math.max(0, l[0] - 0.25);
  const lg = Math.max(0, l[1] - 0.25);
  const lb = Math.max(0, l[2] - 0.25);
  put(data, o, px, py, p.a[0] * l[0] + p.gloss * lr * 0.6 + p.e[0], p.a[1] * l[1] + p.gloss * lg * 0.6 + p.e[1], p.a[2] * l[2] + p.gloss * lb * 0.6 + p.e[2]);
}

// ---------------------------------------------------------------------------
// Bake

export function bakeWorld(map: TileMap, cfg: SettingsMap): WorldBake {
  const W = map.width;
  const H = map.height;
  const amb = Number(cfg.ambient_light ?? 0.4);
  const density = Number(cfg.neon_density ?? 0.35);
  const ambient: V3 = [amb * 0.75, amb * 0.7, amb * 1.2];
  const isWall = (x: number, y: number) => map.get(x, y) === Tile.Wall;

  // Distance (Chebyshev, capped) to the extraction zone.
  const extractDist = new Uint8Array(W * H).fill(9);
  const extract: { x: number; y: number }[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (map.get(x, y) === Tile.Extract) extract.push({ x, y });
  for (const e of extract)
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = e.x + dx;
        const y = e.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        extractDist[y * W + x] = Math.min(extractDist[y * W + x]!, Math.max(Math.abs(dx), Math.abs(dy)));
      }

  // --- Face decoration + lights --------------------------------------------
  const lights: Light[] = [];
  const faces = new Map<string, FaceInfo>();
  const glowsAt = new Map<number, Glow[]>();
  const addGlow = (tx: number, ty: number, g: Glow) => {
    const k = ty * W + tx;
    const l = glowsAt.get(k) ?? [];
    l.push(g);
    glowsAt.set(k, l);
  };

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!isWall(x, y)) continue;
      for (const side of [0, 1] as const) {
        // side 0: left face (toward +y), side 1: right face (toward +x).
        const fx = side ? x + 1 : x;
        const fy = side ? y : y + 1;
        if (fx >= W || fy >= H || isWall(fx, fy)) continue;
        const seed = hash2(x, y, 100 + side);
        const r = rand2(x, y, 200 + side);
        const outer = x === 0 || y === 0;
        const zoneTrim = hash2(Math.floor(x / 7), Math.floor(y / 7), 300) % 5;
        const trim = zoneTrim === 0 ? null : zoneTrim <= 2 ? C.magenta : zoneTrim === 3 ? C.cyan : C.violet;
        let decor: Decor = "plain";
        if (r < density) {
          const k = hash2(x, y, 400 + side) % 100;
          if (outer && k < 45) decor = "window";
          else if (k < 45) decor = "sign";
          else if (k < 65) decor = "holo";
          else if (k < 80) decor = "screen";
          else decor = "vent";
        } else if (r < density + 0.12) decor = (seed & 1) === 0 ? "pipes" : "vent";
        const color = NEON_COLS[seed % NEON_COLS.length]!;
        const color2 = NEON_COLS[(seed >>> 5) % NEON_COLS.length]!;
        const rows = 1 + ((seed >>> 3) & 1);
        const info: FaceInfo = { decor, color, color2, trim, seed, glyphs: [glyph(seed), glyph(seed + 7)], rows };
        faces.set(`${x},${y},${side}`, info);

        // Light emitted into the room in front of the face.
        const lx = side ? x + 1.15 : x + 0.5;
        const ly = side ? y + 0.5 : y + 1.15;
        const sx = (lx - ly) * 32;
        const sy = (lx + ly) * 16;
        const add = (col: V3, radius: number, intensity: number, kind: Light["kind"], z: number) =>
          lights.push({ x: lx, y: ly, z, col, radius, intensity, kind, tx: fx, ty: fy });
        if (decor === "sign") {
          add(color, 3.6, 1.25, "sign", 1.1);
          addGlow(x, y, { x: sx, y: sy - 34 - rows * 6, rx: 22, ry: 30 + rows * 8, color: toCss(color), flicker: seed % 4 === 0 ? 1 : 0, seed });
        } else if (decor === "holo") {
          add(mix3(color, color2, 0.5), 3.2, 1.0, "holo", 1.0);
          addGlow(x, y, { x: sx, y: sy - 38, rx: 26, ry: 22, color: toCss(mix3(color, color2, 0.5)), flicker: 2, seed });
        } else if (decor === "window") add([0.35, 0.45, 1], 2.6, 0.55, "window", 1.0);
        else if (decor === "screen") add(color, 1.8, 0.6, "screen", 0.9);
        if (trim && (x + y) % 3 === 0) add(trim, 2.2, 0.35, "sign", 1.7);
      }
    }

  // Ceiling lamps: roughly one per 5×5 block of open floor.
  const lamps: Light[] = [];
  for (let by = 0; by < H; by += 5)
    for (let bx = 0; bx < W; bx += 5) {
      if (rand2(bx, by, 500) < 0.1) continue;
      for (let tries = 0; tries < 6; tries++) {
        const x = bx + (hash2(bx, by, 600 + tries) % 5);
        const y = by + (hash2(bx, by, 700 + tries) % 5);
        if (x >= W || y >= H || !map.walkable(x, y)) continue;
        const warm = hash2(x, y, 800) % 3;
        const col: V3 = warm === 0 ? [1, 0.82, 0.6] : warm === 1 ? [0.7, 0.85, 1] : [0.55, 1, 0.95];
        const L: Light = { x: x + 0.5, y: y + 0.5, z: 2.2, col, radius: 4.4, intensity: 1.05, kind: "lamp", tx: x, ty: y };
        lights.push(L);
        lamps.push(L);
        break;
      }
    }
  for (const e of extract) lights.push({ x: e.x + 0.5, y: e.y + 0.5, z: 0.6, col: C.green, radius: 2.2, intensity: 0.5, kind: "extract", tx: e.x, ty: e.y });

  // Cover lights (desk monitors, server LEDs).
  const coverKinds = new Map<number, CoverKind>();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (map.get(x, y) !== Tile.Cover) continue;
      const k = coverKind(map, x, y);
      coverKinds.set(y * W + x, k);
      if (k === "desk") lights.push({ x: x + 0.5, y: y + 0.5, z: 1.1, col: C.cyan, radius: 1.8, intensity: 0.6, kind: "screen", tx: x, ty: y });
      if (k === "planter") lights.push({ x: x + 0.5, y: y + 0.5, z: 1.0, col: C.green, radius: 1.4, intensity: 0.35, kind: "screen", tx: x, ty: y });
    }

  // Per-tile light lists with line of sight from the light's floor tile.
  const byTile: number[][] = Array.from({ length: W * H }, () => []);
  lights.forEach((L, i) => {
    const R = Math.ceil(L.radius + 1);
    for (let y = Math.max(0, L.ty - R); y <= Math.min(H - 1, L.ty + R); y++)
      for (let x = Math.max(0, L.tx - R); x <= Math.min(W - 1, L.tx + R); x++) {
        if (isWall(x, y)) continue;
        if (Math.hypot(x + 0.5 - L.x, y + 0.5 - L.y) > L.radius + 0.8) continue;
        if (!map.lineOfSight({ x: L.tx + 0.5, y: L.ty + 0.5 }, { x: x + 0.5, y: y + 0.5 })) continue;
        byTile[y * W + x]!.push(i);
      }
  });
  const lf: LightField = { lights, byTile, ambient, W, H };

  // --- Floor layer -----------------------------------------------------------
  const fw = (W + H) * 16;
  const fh = (W + H) * 8;
  const ox = -H * 16;
  const floor = makeCanvas(fw, fh);
  const fctx = ctx2d(floor);
  const img = fctx.createImageData(fw, fh);
  const data = img.data;
  const fc: FloorCtx = { map, extractDist, W, tile: new Uint8Array(W * H), hash: new Uint32Array(W * H), mat: new Array<Mat>(W * H) };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      fc.tile[y * W + x] = map.get(x, y);
      fc.hash[y * W + x] = hash2(x, y, 1);
      fc.mat[y * W + x] = floorMaterial(x, y);
    }
  // Ambient-occlusion flags per tile: 1 = blocked on -x, 2 = blocked on -y, 4 = wall on +x, 8 = wall on +y.
  const open = (x: number, y: number) => {
    const t = map.get(x, y);
    return t === Tile.Floor || t === Tile.Extract;
  };
  const ao = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      ao[y * W + x] = (open(x - 1, y) ? 0 : 1) | (open(x, y - 1) ? 0 : 2) | (isWall(x + 1, y) ? 4 : 0) | (isWall(x, y + 1) ? 8 : 0);
  const px: Px = { a: ZERO, e: ZERO, gloss: 0 };
  const l: V3 = [0.5, 0.5, 0.5];
  const lrow = new Float32Array(Math.ceil(fw / 2) * 3 + 3);
  for (let py = 0; py < fh; py++) {
    const ay = py + 0.5;
    if ((py & 1) === 0) lrow.fill(-1);
    // Only walk the pixels inside the map diamond on this row.
    const axMin = Math.max(-2 * ay, 2 * ay - 16 * 2 * H);
    const axMax = Math.min(32 * W - 2 * ay, 2 * ay);
    const p0 = Math.max(0, Math.floor(axMin - ox - 0.5));
    const p1 = Math.min(fw - 1, Math.ceil(axMax - ox - 0.5));
    for (let pxx = p0; pxx <= p1; pxx++) {
      const ax = pxx + ox + 0.5;
      const wx = (ax / 16 + ay / 8) / 2;
      const wy = (ay / 8 - ax / 16) / 2;
      const tx = Math.floor(wx);
      const ty = Math.floor(wy);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const ti = ty * W + tx;
      if (fc.tile[ti] === Tile.Wall) continue;
      const u = wx - tx;
      const v = wy - ty;
      floorPx(fc, tx, ty, u, v, pxx, py, px);
      // Light varies slowly: evaluate on a 2×2 pixel grid and reuse.
      const lo = (pxx >> 1) * 3;
      if (((py & 1) === 0 && (pxx & 1) === 0) || lrow[lo]! < 0) {
        illuminate(lf, ti, wx, wy, 0, 0, 0, 1, l);
        lrow[lo] = l[0];
        lrow[lo + 1] = l[1];
        lrow[lo + 2] = l[2];
      }
      // Soft contact shadow where the floor meets walls and cover.
      let s = 1;
      const f = ao[ti]!;
      if (f) {
        if (f & 1) s = Math.min(s, 0.55 + 0.45 * Math.min(1, u / 0.35));
        if (f & 2) s = Math.min(s, 0.55 + 0.45 * Math.min(1, v / 0.35));
        if (f & 4) s = Math.min(s, 0.7 + 0.3 * Math.min(1, (1 - u) / 0.2));
        if (f & 8) s = Math.min(s, 0.7 + 0.3 * Math.min(1, (1 - v) / 0.2));
      }
      l[0] = lrow[lo]! * s;
      l[1] = lrow[lo + 1]! * s;
      l[2] = lrow[lo + 2]! * s;
      shadeOut(px, l, data, (py * fw + pxx) * 4, pxx, py);
    }
  }
  fctx.putImageData(img, 0, 0);

  // --- Wall and cover blocks ---------------------------------------------------
  // All blocks are baked into one atlas (one texture, one putImageData).
  const blocks: BlockSprite[] = [];
  const blockAt: (BlockSprite | undefined)[] = new Array(W * H);
  let nBlocks = 0;
  for (let i = 0; i < W * H; i++) if (fc.tile[i] === Tile.Wall || fc.tile[i] === Tile.Cover) nBlocks++;
  const COLS = 64;
  const CELL_W = 32;
  const CELL_H = 16 + Math.max(WALL_H, COVER_H + PROP_H);
  const atlas = makeCanvas(COLS * CELL_W, Math.max(1, Math.ceil(nBlocks / COLS)) * CELL_H);
  const actx = ctx2d(atlas);
  const aimg = actx.createImageData(atlas.width, atlas.height);
  const d = aimg.data;
  const AW = atlas.width;
  const props: { x: number; y: number; kind: CoverKind; seed: number; head: number }[] = [];
  let k = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = map.get(x, y);
      if (t !== Tile.Wall && t !== Tile.Cover) continue;
      const wall = t === Tile.Wall;
      const bh = wall ? WALL_H : COVER_H;
      const head = wall ? 0 : PROP_H;
      const cw = 32;
      const ch = 16 + bh + head;
      const cellX = (k % COLS) * CELL_W;
      const cellY = Math.floor(k / COLS) * CELL_H;
      k++;
      const kind = coverKinds.get(y * W + x) ?? "crate";
      const leftF = wall ? faces.get(`${x},${y},0`) : undefined;
      const rightF = wall ? faces.get(`${x},${y},1`) : undefined;
      const showL = map.get(x, y + 1) !== Tile.Wall && (wall ? true : map.get(x, y + 1) !== Tile.Cover);
      const showR = map.get(x + 1, y) !== Tile.Wall && (wall ? true : map.get(x + 1, y) !== Tile.Cover);
      const topTrim = leftF?.trim ?? rightF?.trim ?? null;
      for (let py = 0; py < ch; py++)
        for (let pxx = 0; pxx < cw; pxx++) {
          const cx = pxx + 0.5;
          const cy = py + 0.5 - head;
          const o = ((cellY + py) * AW + cellX + pxx) * 4;
          // Top diamond (corner at (16, 0)).
          const dyTop = cy;
          if (dyTop >= 0 && dyTop < 16) {
            const ax = cx - 16;
            const u = (ax / 16 + dyTop / 8) / 2;
            const v = (dyTop / 8 - ax / 16) / 2;
            if (u >= 0 && u < 1 && v >= 0 && v < 1) {
              if (wall) {
                // Solid cap; a lighter lip along edges that face the room.
                px.a = [0.3, 0.27, 0.52];
                px.e = ZERO;
                px.gloss = 0;
                const lipL = showL && v > 0.9;
                const lipR = showR && u > 0.9;
                if (lipL || lipR) {
                  px.a = [0.5, 0.47, 0.8];
                  if (topTrim) px.e = mul(topTrim, 0.35);
                }
              } else coverTopPx(kind, u, v, px);
              l[0] = ambient[0] * 1.3 + 0.08;
              l[1] = ambient[1] * 1.3 + 0.08;
              l[2] = ambient[2] * 1.3 + 0.1;
              shadeOut(px, l, d, o, pxx + x * 7, py + y * 5);
              continue;
            }
          }
          // Left face.
          if (cx < 16 && showL) {
            const u = cx;
            const v = cy - 8 - u * 0.5;
            if (v >= 0 && v < bh) {
              if (wall) wallFacePx(u, v, leftF!, px);
              else coverFacePx(kind, u, v, hash2(x, y, 5), px);
              const wx = x + u / 16;
              const wy = y + 1;
              const wz = ((bh - v) / 16) * (wall ? 1 : 1);
              illuminate(lf, y + 1 < H ? (y + 1) * W + x : -1, wx, wy + 0.02, wz, 0, 1, 0, l);
              l[0] *= 0.92;
              l[1] *= 0.92;
              l[2] *= 0.92;
              shadeOut(px, l, d, o, pxx + x * 7, py + y * 5);
              continue;
            }
          }
          // Right face.
          if (cx >= 16 && showR) {
            const u = cx - 16;
            const v = cy - 16 + u * 0.5;
            if (v >= 0 && v < bh) {
              if (wall) wallFacePx(u, v, rightF!, px);
              else coverFacePx(kind, u, v, hash2(x, y, 6), px);
              const wx = x + 1;
              const wy = y + 1 - u / 16;
              const wz = (bh - v) / 16;
              illuminate(lf, x + 1 < W ? y * W + x + 1 : -1, wx + 0.02, wy, wz, 1, 0, 0, l);
              l[0] *= 0.75;
              l[1] *= 0.75;
              l[2] *= 0.8;
              shadeOut(px, l, d, o, pxx + x * 7, py + y * 5);
              continue;
            }
          }
        }
      if (!wall) props.push({ x: cellX, y: cellY, kind, seed: hash2(x, y, 9), head });
      const s = { x: (x - y) * 32, y: (x + y) * 16 };
      const b: BlockSprite = {
        canvas: atlas,
        sx: cellX,
        sy: cellY,
        sw: cw,
        sh: ch,
        x: s.x - 16 * ART,
        y: s.y - (bh + head) * ART,
        depth: x + y + 1,
        tx: x,
        ty: y,
        wall,
        glows: glowsAt.get(y * W + x) ?? [],
      };
      if (!wall && kind === "desk") b.glows.push({ x: s.x, y: s.y + 4 - (COVER_H + 6) * ART, rx: 14, ry: 10, color: "rgb(0,240,255)", flicker: 0, seed: hash2(x, y, 3) });
      blocks.push(b);
      blockAt[y * W + x] = b;
    }

  actx.putImageData(aimg, 0, 0);
  for (const p of props) {
    actx.save();
    actx.translate(p.x, p.y);
    drawProp(actx, p.kind, p.seed, p.head);
    actx.restore();
  }
  // Per-tile light level for shading sprites.
  const tileLevel = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      illuminate(lf, y * W + x, x + 0.5, y + 0.5, 0.9, 0, 0, 1, l);
      const lum = l[0] * 0.3 + l[1] * 0.5 + l[2] * 0.2;
      tileLevel[y * W + x] = lum < 0.3 ? 0 : lum < 0.5 ? 1 : lum < 0.75 ? 2 : 3;
    }

  return { floor, fx: ox * ART, fy: 0, blocks, blockAt, lights, tileLevel, extract, lamps, width: W, height: H };
}

/** Small pixel props on top of cover blocks (monitors, plants). */
function drawProp(c: CanvasRenderingContext2D, kind: CoverKind, seed: number, head: number): void {
  const r = rng(seed);
  const topY = head + 8; // centre of the top diamond
  if (kind === "desk") {
    // Monitor facing the camera-left plus a keyboard.
    c.fillStyle = "#14122a";
    c.fillRect(12, topY - 9, 9, 7);
    c.fillStyle = "#00c8e0";
    c.fillRect(13, topY - 8, 7, 5);
    c.fillStyle = "#b8fbff";
    for (let i = 0; i < 3; i++) c.fillRect(14, topY - 7 + i * 1.5, 2 + Math.floor(r() * 4), 1);
    c.fillStyle = "#2a2840";
    c.fillRect(16, topY - 2, 2, 2);
    c.fillStyle = "#3a3858";
    c.fillRect(10, topY + 1, 7, 2);
    if (r() < 0.5) {
      c.fillStyle = "#ff2bd6";
      c.fillRect(21, topY, 2, 2);
    }
  } else if (kind === "planter") {
    const greens = ["#0f5a3a", "#178a52", "#22c06e", "#39ff8c", "#00f0ff"];
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2;
      const rad = r() * 6;
      const x = 16 + Math.cos(a) * rad * 1.3;
      const y = topY - 4 - Math.abs(Math.sin(a)) * rad - r() * 4;
      c.fillStyle = greens[Math.min(greens.length - 1, Math.floor(r() * (i < 22 ? 3 : 5)))]!;
      c.fillRect(Math.round(x), Math.round(y), 1 + Math.floor(r() * 2), 1 + Math.floor(r() * 2));
    }
  } else if (kind === "crate" && r() < 0.4) {
    // A smaller crate stacked on top.
    c.fillStyle = "#1d3a3e";
    c.fillRect(13, topY - 6, 7, 6);
    c.fillStyle = "#2c5458";
    c.fillRect(13, topY - 6, 7, 1);
    c.fillStyle = "#b39012";
    c.fillRect(14, topY - 4, 5, 1);
  }
}
