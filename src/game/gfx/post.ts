// Screen-space layers: backdrop, rain, scanlines, vignette, alarm tint.
// All functions expect the context transform to be the plain DPR scale.

import { makeCanvas, type Canvas2D } from "./canvas";
import { rng } from "./hash";

let bgCache: { w: number; h: number; c: Canvas2D } | null = null;

/** Deep-indigo backdrop with a hazy distant skyline (cached per viewport size). */
function backdrop(w: number, h: number): Canvas2D {
  if (bgCache && bgCache.w === w && bgCache.h === h) return bgCache.c;
  const c = makeCanvas(w, h);
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#0d0826");
  grad.addColorStop(0.55, "#07061a");
  grad.addColorStop(1, "#05040f");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Magenta horizon glow behind the skyline.
  const horizon = h * 0.42;
  const glow = g.createRadialGradient(w * 0.5, horizon, 0, w * 0.5, horizon, w * 0.7);
  glow.addColorStop(0, "rgba(255,43,214,0.22)");
  glow.addColorStop(0.5, "rgba(120,30,160,0.08)");
  glow.addColorStop(1, "rgba(7,6,26,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);
  // Two layers of skyline silhouettes with lit windows.
  const r = rng(1337);
  for (let layer = 0; layer < 2; layer++) {
    const base = horizon + layer * h * 0.06;
    let x = -20;
    while (x < w + 20) {
      const bw = 18 + r() * 54;
      const bh = (layer ? 30 : 60) + r() * (layer ? 110 : 190);
      g.fillStyle = layer ? "#0b0820" : "#120d30";
      g.fillRect(x, base - bh, bw, h);
      if (r() < 0.25) {
        // Rooftop antenna with a red beacon.
        g.fillRect(x + bw / 2, base - bh - 14, 1, 14);
        g.fillStyle = "rgba(255,59,92,0.8)";
        g.fillRect(x + bw / 2 - 1, base - bh - 15, 2, 2);
      }
      for (let wy = base - bh + 5; wy < base + 40; wy += 5)
        for (let wx = x + 3; wx < x + bw - 3; wx += 4) {
          if (r() < (layer ? 0.08 : 0.14)) {
            g.fillStyle = ["rgba(255,225,77,0.45)", "rgba(0,240,255,0.4)", "rgba(255,43,214,0.4)", "rgba(255,200,150,0.35)"][Math.floor(r() * 4)]!;
            g.fillRect(wx, wy, 2, 2);
          }
        }
      x += bw + r() * 4;
    }
  }
  // Fog: fade the city into the deep indigo below the horizon.
  const fog = g.createLinearGradient(0, horizon - h * 0.1, 0, horizon + h * 0.25);
  fog.addColorStop(0, "rgba(7,6,26,0)");
  fog.addColorStop(1, "rgba(7,6,26,0.97)");
  g.fillStyle = fog;
  g.fillRect(0, 0, w, h);
  bgCache = { w, h, c };
  return c;
}

export function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, quality: number): void {
  if (quality === 0) {
    ctx.fillStyle = "#07061a";
    ctx.fillRect(0, 0, w, h);
    return;
  }
  ctx.drawImage(backdrop(Math.ceil(w), Math.ceil(h)), 0, 0);
}

// --- Rain --------------------------------------------------------------------

interface Drop {
  x: number;
  y: number;
  l: number;
  s: number;
}
interface Splash {
  x: number;
  y: number;
  t: number;
}

export class Rain {
  private drops: Drop[] = [];
  private splashes: Splash[] = [];
  private r = rng(99);

  update(dt: number, w: number, h: number, count: number): void {
    while (this.drops.length < count) this.drops.push(this.spawn(w, h, true));
    if (this.drops.length > count) this.drops.length = count;
    for (const d of this.drops) {
      d.y += d.s * dt;
      d.x -= d.s * 0.18 * dt;
      if (d.y > h + 20 || d.x < -20) {
        if (this.r() < 0.5 && this.splashes.length < 60) this.splashes.push({ x: d.x, y: h * (0.45 + this.r() * 0.55), t: 0 });
        Object.assign(d, this.spawn(w, h, false));
      }
    }
    for (const s of this.splashes) s.t += dt;
    this.splashes = this.splashes.filter((s) => s.t < 0.3);
  }

  private spawn(w: number, h: number, anywhere: boolean): Drop {
    return { x: this.r() * (w + 100), y: anywhere ? this.r() * h : -20 - this.r() * 40, l: 8 + this.r() * 14, s: 700 + this.r() * 500 };
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = "rgba(150,190,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this.drops) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.l * 0.18, d.y - d.l);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(170,210,255,0.3)";
    ctx.beginPath();
    for (const s of this.splashes) {
      const r = 2 + s.t * 18;
      ctx.moveTo(s.x + r, s.y);
      ctx.ellipse(s.x, s.y, r, r * 0.35, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

// --- Scanlines + vignette ---------------------------------------------------

let overlay: { w: number; h: number; scan: boolean; c: Canvas2D } | null = null;

/** Vignette and (optionally) scanlines baked into one cached overlay: one blit per frame. */
export function drawCrtOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, scanlines: boolean): void {
  const W = Math.ceil(w);
  const H = Math.ceil(h);
  if (!overlay || overlay.w !== W || overlay.h !== H || overlay.scan !== scanlines) {
    const c = makeCanvas(W, H);
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    grad.addColorStop(0, "rgba(3,2,12,0)");
    grad.addColorStop(1, "rgba(3,2,12,0.7)");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    if (scanlines) {
      g.fillStyle = "rgba(0,0,0,0.2)";
      for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    }
    overlay = { w: W, h: H, scan: scanlines, c };
  }
  ctx.drawImage(overlay.c, 0, 0, w, h);
}

/** Pulsing red edge glow while the alarm is up. */
export function drawAlarmTint(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, strength: number): void {
  const pulse = (0.5 + 0.5 * Math.sin(t * 6)) * strength;
  if (pulse < 0.02) return;
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  grad.addColorStop(0, "rgba(255,30,60,0)");
  grad.addColorStop(1, `rgba(255,30,60,${0.28 * pulse})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}
