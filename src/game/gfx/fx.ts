// Particles, flashes, decals and camera shake.
//
// Positions are world-screen CSS px (the space worldToScreen returns), with
// an extra `z` height for particles. The renderer owns one Fx per Sim.

import type { Vec } from "../iso";
import { ART, ctx2d, makeCanvas, type Canvas2D } from "./canvas";
import { rng } from "./hash";

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  color: string;
  size: number;
  grav: number;
  drag: number;
  add: boolean;
  /** Leave a floor decal on landing. */
  stain?: boolean;
}

interface Flash {
  x: number;
  y: number;
  r: number;
  color: string;
  life: number;
  max: number;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  color: string;
  life: number;
  max: number;
}

interface Slash {
  x: number;
  y: number;
  a: number;
  color: string;
  life: number;
  max: number;
}

interface Decal {
  x: number;
  y: number;
  c: Canvas2D;
}

const glowCache = new Map<string, Canvas2D>();

/** Soft round additive glow sprite (64×64) for a colour; cached. */
export function glowSprite(color: string): Canvas2D {
  let c = glowCache.get(color);
  if (c) return c;
  c = makeCanvas(64, 64);
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(0.25, withAlpha(color, 0.45));
  grad.addColorStop(0.6, withAlpha(color, 0.12));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(color, c);
  return c;
}

function withAlpha(color: string, a: number): string {
  if (color.startsWith("rgb(")) return color.replace("rgb(", "rgba(").replace(")", `,${a})`);
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

/** Draws an additive elliptical glow centred at (x, y). Caller sets composite op. */
export function drawGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, rx: number, ry: number, alpha: number): void {
  if (alpha <= 0.003) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(glowSprite(color), x - rx, y - ry, rx * 2, ry * 2);
  ctx.globalAlpha = prev;
}

const bloodCache: Canvas2D[] = [];
function bloodDecal(seed: number): Canvas2D {
  const i = seed % 6;
  if (bloodCache[i]) return bloodCache[i]!;
  const r = rng(seed * 977 + 13);
  const c = makeCanvas(24, 12);
  const g = ctx2d(c);
  const cols = ["#4a0612", "#6a0a1c", "#80102a", "#3a0410"];
  for (let k = 0; k < 70; k++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * (k < 50 ? 6 : 10);
    const x = 12 + Math.cos(a) * d;
    const y = 6 + Math.sin(a) * d * 0.5;
    g.fillStyle = cols[Math.floor(r() * cols.length)]!;
    g.fillRect(Math.round(x), Math.round(y), 1 + (r() < 0.3 ? 1 : 0), 1);
  }
  bloodCache[i] = c;
  return c;
}

export class Fx {
  particles: Particle[] = [];
  flashes: Flash[] = [];
  rings: Ring[] = [];
  slashes: Slash[] = [];
  decals: Decal[] = [];
  private shakeAmp = 0;
  private seed = 1;
  cap = 400;

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  shake(amount: number): void {
    this.shakeAmp = Math.min(24, Math.max(this.shakeAmp, amount));
  }

  shakeOffset(t: number): Vec {
    const a = this.shakeAmp;
    if (a < 0.05) return { x: 0, y: 0 };
    return { x: Math.sin(t * 83.1) * a * 0.8 + Math.sin(t * 41.7) * a * 0.4, y: Math.cos(t * 71.3) * a * 0.6 };
  }

  flash(x: number, y: number, r: number, color: string, life = 0.08): void {
    this.flashes.push({ x, y, r, color, life, max: life });
  }

  ring(x: number, y: number, r0: number, r1: number, color: string, life = 0.5): void {
    this.rings.push({ x, y, r0, r1, color, life, max: life });
  }

  slash(x: number, y: number, color: string): void {
    this.slashes.push({ x, y, a: this.rand() * Math.PI, color, life: 0.35, max: 0.35 });
  }

  decal(x: number, y: number, seed: number): void {
    this.decals.push({ x, y, c: bloodDecal(seed) });
    if (this.decals.length > 120) this.decals.shift();
  }

  burst(x: number, y: number, z: number, n: number, o: { color: string | string[]; speed: number; up?: number; life?: number; size?: number; grav?: number; add?: boolean; stain?: boolean; dir?: number; spread?: number }): void {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this.cap) this.particles.shift();
      const a = o.dir !== undefined ? o.dir + (this.rand() - 0.5) * (o.spread ?? 1) : this.rand() * Math.PI * 2;
      const s = o.speed * (0.4 + this.rand() * 0.6);
      const life = (o.life ?? 0.5) * (0.6 + this.rand() * 0.8);
      const col = Array.isArray(o.color) ? o.color[Math.floor(this.rand() * o.color.length)]! : o.color;
      this.particles.push({
        x,
        y,
        z,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s * 0.5,
        vz: (o.up ?? 0) * (0.5 + this.rand()),
        life,
        max: life,
        color: col,
        size: o.size ?? 1,
        grav: o.grav ?? 300,
        drag: 2,
        add: o.add ?? false,
        stain: o.stain,
      });
    }
  }

  update(dt: number): void {
    this.shakeAmp *= Math.exp(-dt * 7);
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vz -= p.grav * dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      if (p.z < 0) {
        p.z = 0;
        if (p.stain && this.rand() < 0.15) this.decals.push({ x: p.x, y: p.y, c: bloodDecal(Math.floor(this.rand() * 6)) });
        p.vz *= -0.25;
        p.vx *= 0.5;
        p.vy *= 0.5;
        p.stain = false;
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter((f) => f.life > 0);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const s of this.slashes) s.life -= dt;
    this.slashes = this.slashes.filter((s) => s.life > 0);
  }

  /** Floor decals (under units). */
  drawDecals(ctx: CanvasRenderingContext2D): void {
    for (const d of this.decals) ctx.drawImage(d.c, Math.round(d.x - d.c.width), Math.round(d.y - d.c.height), d.c.width * ART, d.c.height * ART);
  }

  /** Particles, flashes, rings: drawn on top of the scene. */
  draw(ctx: CanvasRenderingContext2D, additive: boolean): void {
    // Normal particles first.
    for (const p of this.particles) {
      if (p.add) continue;
      ctx.globalAlpha = Math.min(1, p.life / p.max + 0.3);
      ctx.fillStyle = p.color;
      const s = p.size * ART;
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - p.z - s / 2), s, s);
    }
    ctx.globalAlpha = 1;
    const prev = ctx.globalCompositeOperation;
    if (additive) ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      if (!p.add) continue;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      const s = p.size * ART;
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - p.z - s / 2), s, s);
    }
    ctx.globalAlpha = 1;
    for (const f of this.flashes) {
      const k = f.life / f.max;
      drawGlow(ctx, f.color, f.x, f.y, f.r * (0.7 + 0.3 * k), f.r * (0.7 + 0.3 * k) * 0.8, k);
    }
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const rr = r.r0 + (r.r1 - r.r0) * k;
      ctx.ellipse(r.x, r.y, rr, rr * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const s of this.slashes) {
      const k = 1 - s.life / s.max;
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 3 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y - 20, 14 + k * 8, s.a, s.a + Math.PI * 0.9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.globalCompositeOperation = prev;
  }
}
