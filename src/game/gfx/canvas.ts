// Offscreen canvas helpers. Only touch the DOM lazily so importing this module
// from node (tests) is harmless.

/** CSS pixels per art pixel. Every baked layer is drawn at art resolution and upscaled. */
export const ART = 2;

export type Canvas2D = HTMLCanvasElement;

export function makeCanvas(w: number, h: number): Canvas2D {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: Canvas2D): CanvasRenderingContext2D {
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  return g;
}

/** Soft glow version of a mostly-transparent emissive canvas (cheap blur by down/up-sampling). */
export function blurGlow(src: Canvas2D, pad = 4): Canvas2D {
  const w = src.width + pad * 2;
  const h = src.height + pad * 2;
  const big = makeCanvas(w, h);
  const bg = big.getContext("2d")!;
  bg.drawImage(src, pad, pad);
  const small = makeCanvas(Math.ceil(w / 3), Math.ceil(h / 3));
  const sg = small.getContext("2d")!;
  sg.imageSmoothingEnabled = true;
  sg.drawImage(big, 0, 0, small.width, small.height);
  const out = makeCanvas(w, h);
  const og = out.getContext("2d")!;
  og.imageSmoothingEnabled = true;
  og.drawImage(small, 0, 0, w, h);
  og.globalCompositeOperation = "lighter";
  og.globalAlpha = 0.6;
  og.drawImage(src, pad, pad);
  return out;
}
