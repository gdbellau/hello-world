// Deterministic hashing for per-tile variation. Pure: no DOM, safe in tests.

/** 32-bit integer hash of (x, y, seed). Same inputs always give the same output. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash mapped to [0, 1). */
export function rand2(x: number, y: number, seed = 0): number {
  return hash2(x, y, seed) / 4294967296;
}

/** Deterministic pick from a list. */
export function pick<T>(list: readonly T[], x: number, y: number, seed = 0): T {
  return list[hash2(x, y, seed) % list.length]!;
}

/** Small seeded PRNG (mulberry32) for procedural generation. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Ordered-dither threshold in [0, 1) for pixel (x, y). */
export function bayer4(x: number, y: number): number {
  return (BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16;
}
