// Main renderer. Orchestrates the baked world (gfx/world), procedural pixel
// sprites (gfx/sprites), effects (gfx/fx) and screen-space post (gfx/post).
//
// Signature is stable: render(ctx, sim, cam, rs, t). Everything else is
// derived per Sim (cached in a WeakMap) so main.ts needs no changes.
// Optional: forward SimEvents to renderFx() (re-exported here) for extra juice.

import type { SettingsMap } from "../../shared/settings";
import { applyAudioSettings, autoMusic } from "./audio";
import { ART } from "./gfx/canvas";
import { drainFx, fxWired, type FxEvent } from "./gfx/events";
import { drawGlow, Fx } from "./gfx/fx";
import { characterPalette } from "./gfx/palette";
import { drawAlarmTint, drawBackdrop, drawCrtOverlay, Rain } from "./gfx/post";
import { archetypeFor, drawCharacter, muzzleOffset, type Pose } from "./gfx/sprites";
import { bakeWorld, WALL_H, type BlockSprite, type WorldBake } from "./gfx/world";
import { TILE_H, TILE_W, worldToScreen, type Vec } from "./iso";
import { drawObject } from "./render-objects";
import type { Entity, Shot, Sim } from "./sim";

export { renderFx, type FxEvent } from "./gfx/events";

export interface Camera {
  x: number; // screen-space offset
  y: number;
}

export interface RenderState {
  selected: Set<number>;
  hoverTile: Vec | null;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
}

const COL = {
  agent: "#00f0ff",
  guard: "#ff3b5c",
  target: "#ffe14d",
  agentShot: "#9ff9ff",
  hostileShot: "#ff5a3c",
};

// ---------------------------------------------------------------------------
// Per-sim state

interface UnitState {
  last: Vec;
  walk: number;
  moving: number;
  aimUntil: number;
  prevHp: number;
  detect: number;
  trail: { x: number; y: number; t: number }[];
}

interface Tracer {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  hostile: boolean;
  life: number;
}

interface State {
  bake: WorldBake;
  order: BlockSprite[];
  fade: Float32Array;
  fadeTarget: Float32Array;
  fx: Fx;
  units: Map<number, UnitState>;
  seenShots: WeakSet<Shot>;
  tracers: Tracer[];
  lastT: number;
  alarm: boolean;
  alarmT: number;
  outcome: string | null;
  rain: Rain;
}

const states = new WeakMap<Sim, State>();

function num(cfg: SettingsMap, k: string, d: number): number {
  const v = Number(cfg[k]);
  return cfg[k] === undefined || !Number.isFinite(v) ? d : v;
}
function flag(cfg: SettingsMap, k: string, d: boolean): boolean {
  const v = cfg[k];
  return typeof v === "boolean" ? v : d;
}

function getState(sim: Sim, t: number): State {
  let st = states.get(sim);
  if (st) return st;
  const bake = bakeWorld(sim.map, sim.cfg);
  const order = bake.blocks.slice().sort((a, b) => a.depth - b.depth || a.tx - b.tx);
  const n = sim.map.width * sim.map.height;
  st = {
    bake,
    order,
    fade: new Float32Array(n).fill(1),
    fadeTarget: new Float32Array(n).fill(1),
    fx: new Fx(),
    units: new Map(),
    seenShots: new WeakSet(),
    tracers: [],
    lastT: t,
    alarm: false,
    alarmT: 0,
    outcome: null,
    rain: new Rain(),
  };
  states.set(sim, st);
  for (const s of sim.shots) st.seenShots.add(s);
  drainFx(); // drop events from a previous mission
  try {
    applyAudioSettings(sim.cfg);
    autoMusic(sim.alarm ? "combat" : "stealth");
  } catch {
    // Audio is optional.
  }
  return st;
}

function unit(st: State, e: Entity): UnitState {
  let u = st.units.get(e.id);
  if (!u) {
    u = { last: { ...e.pos }, walk: 0, moving: 0, aimUntil: 0, prevHp: e.hp, detect: e.detect ?? 0, trail: [] };
    st.units.set(e.id, u);
  }
  return u;
}

const isCharacter = (e: Entity) => e.kind === "agent" || e.kind === "guard" || e.kind === "target";

// ---------------------------------------------------------------------------
// State observation → effects

function observe(sim: Sim, st: State, t: number, dt: number, q: number): void {
  const wired = fxWired();
  for (const e of sim.entities) {
    const u = unit(st, e);
    const d = Math.hypot(e.pos.x - u.last.x, e.pos.y - u.last.y);
    u.walk += d;
    u.moving = d > 0.0005 ? 0.15 : Math.max(0, u.moving - dt);
    u.last = { ...e.pos };
    if (u.prevHp > 0 && e.hp <= 0 && isCharacter(e)) onDeath(sim, st, e, wired, q);
    u.prevHp = e.hp;
    if (e.kind === "guard") {
      const det = e.detect ?? 0;
      if (!wired && u.detect === 0 && det > 0 && !sim.alarm) onDetect(st, e);
      u.detect = det;
    }
  }
  for (const s of sim.shots) {
    if (st.seenShots.has(s)) continue;
    st.seenShots.add(s);
    onShot(sim, st, s, t, q);
  }
  if (sim.alarm && !st.alarm) {
    st.alarm = true;
    st.alarmT = t;
    if (!wired) st.fx.shake(7);
    autoMusic("combat");
  }
  if (sim.outcome && !st.outcome) {
    st.outcome = sim.outcome;
    autoMusic("hq");
  }
}

function onShot(sim: Sim, st: State, s: Shot, t: number, q: number): void {
  let shooter: Entity | undefined;
  let best = 1.2;
  for (const e of sim.entities) {
    if ((e.kind === "agent") === s.hostile) continue;
    const d = Math.hypot(e.pos.x - s.from.x, e.pos.y - s.from.y);
    if (d < best) {
      best = d;
      shooter = e;
    }
  }
  const from = worldToScreen(s.from.x, s.from.y);
  let mx = from.x;
  let my = from.y - 26;
  if (shooter) {
    unit(st, shooter).aimUntil = t + 0.4;
    const fp = worldToScreen(shooter.pos.x, shooter.pos.y);
    const m = muzzleOffset(archetypeFor(shooter.kind, shooter.cls), shooter.skin, shooter.facing);
    mx = fp.x + m.x;
    my = fp.y + m.y;
  }
  const to = worldToScreen(s.to.x, s.to.y);
  const jx = (Math.random() - 0.5) * 10;
  const jy = (Math.random() - 0.5) * 10;
  const bx = to.x + jx;
  const by = to.y - 22 + jy;
  st.tracers.push({ ax: mx, ay: my, bx, by, hostile: s.hostile, life: 0.1 });
  const fx = st.fx;
  const silenced = !s.hostile && shooter?.cls === "ghost";
  fx.flash(mx, my, silenced ? 16 : s.hostile ? 34 : 26, s.hostile ? "#ffb070" : "#bff8ff", 0.07);
  if (q > 0) {
    fx.burst(mx, my, 0, silenced ? 2 : 5, { color: s.hostile ? ["#ffe14d", "#ff8a1f"] : ["#ffffff", "#00f0ff"], speed: 120, life: 0.12, grav: 0, add: true });
    fx.burst(bx, to.y, to.y - by, 6, { color: s.hostile ? ["#ff3b5c", "#ffb070", "#ffe14d"] : ["#00f0ff", "#ffffff"], speed: 90, up: 80, life: 0.3, grav: 400, add: true });
    fx.flash(bx, by, 14, s.hostile ? "#ff5a3c" : "#00f0ff", 0.06);
    if (s.hostile) fx.burst(mx, my + 16, 0, 1, { color: "#c9a23a", speed: 40, up: 60, life: 0.6, grav: 300 });
  }
  fx.shake(s.hostile ? 1.6 : 0.8);
}

function onDeath(sim: Sim, st: State, e: Entity, wired: boolean, q: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  const shot = sim.shots.some((sh) => Math.hypot(sh.to.x - e.pos.x, sh.to.y - e.pos.y) < 0.6);
  st.fx.decal(s.x, s.y, e.id);
  if (q > 0) st.fx.burst(s.x, s.y, 18, 14, { color: ["#8a0c22", "#c0102e", "#5a0616"], speed: 70, up: 90, life: 0.6, grav: 420, stain: true });
  if (!shot && !wired) takedownFx(st, s);
}

function takedownFx(st: State, s: Vec): void {
  st.fx.slash(s.x, s.y, "#ff2bd6");
  st.fx.burst(s.x, s.y, 20, 10, { color: ["#ff2bd6", "#ffffff"], speed: 110, up: 40, life: 0.3, grav: 100, add: true });
  st.fx.shake(3);
}

function onDetect(st: State, g: Entity): void {
  const s = worldToScreen(g.pos.x, g.pos.y);
  st.fx.ring(s.x, s.y, 8, 40, "#ffe14d", 0.6);
}

function handleEvent(sim: Sim, st: State, ev: FxEvent): void {
  const fx = st.fx;
  switch (ev.type) {
    case "takedown":
      takedownFx(st, worldToScreen(ev.at.x, ev.at.y));
      break;
    case "detect": {
      const g = sim.byId(ev.guardId);
      if (g) onDetect(st, g);
      break;
    }
    case "alarm":
      fx.shake(8);
      break;
    case "hack": {
      const s = worldToScreen(ev.at.x, ev.at.y);
      fx.burst(s.x, s.y, 20, 18, { color: ["#00f0ff", "#39ff8c", "#ffffff"], speed: 50, up: 120, life: 0.8, grav: -40, add: true });
      fx.ring(s.x, s.y, 6, 34, "#00f0ff", 0.5);
      break;
    }
    case "explosion": {
      const s = worldToScreen(ev.at.x, ev.at.y);
      const r = (ev.radius ?? 1.5) * 40;
      fx.flash(s.x, s.y - 10, r * 2, "#ffb070", 0.25);
      fx.burst(s.x, s.y, 6, 40, { color: ["#ffe14d", "#ff8a1f", "#ff3b5c", "#ffffff"], speed: r * 4, up: 200, life: 0.7, grav: 350, add: true, size: 1.5 });
      fx.burst(s.x, s.y, 10, 16, { color: ["#2a2440", "#3a3456", "#1a1830"], speed: r * 1.5, up: 60, life: 1.4, grav: -30, size: 3 });
      fx.ring(s.x, s.y, 10, r * 1.6, "#ffb070", 0.4);
      fx.shake(14);
      break;
    }
    case "shake":
      fx.shake(ev.amount);
      break;
    case "flash": {
      const s = worldToScreen(ev.at.x, ev.at.y);
      fx.flash(s.x, s.y - 16, ev.radius ?? 40, ev.color ?? "#ffffff", 0.15);
      break;
    }
    case "sparks": {
      const s = worldToScreen(ev.at.x, ev.at.y);
      fx.burst(s.x, s.y, 16, ev.count ?? 10, { color: [ev.color ?? "#ffe14d", "#ffffff"], speed: 100, up: 120, life: 0.4, add: true });
      break;
    }
    default:
      // shot / death / objective / outcome are inferred from sim state.
      break;
  }
}

// ---------------------------------------------------------------------------
// Render

export function render(ctx: CanvasRenderingContext2D, sim: Sim, cam: Camera, rs: RenderState, t: number): void {
  const st = getState(sim, t);
  const cfg = sim.cfg;
  const q = Math.max(0, Math.min(2, Math.round(num(cfg, "graphics_quality", 2))));
  const dt = Math.max(0, Math.min(0.1, t - st.lastT));
  st.lastT = t;
  const maxP = num(cfg, "max_particles", 400);
  st.fx.cap = q === 0 ? 30 : q === 1 ? Math.floor(maxP / 2) : maxP;

  observe(sim, st, t, dt, q);
  for (const ev of drainFx()) handleEvent(sim, st, ev);
  st.fx.update(dt);
  for (const tr of st.tracers) tr.life -= dt;
  st.tracers = st.tracers.filter((tr) => tr.life > 0);

  const dpr = window.devicePixelRatio || 1;
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = false;
  drawBackdrop(ctx, w, h, q);

  const sh = st.fx.shakeOffset(t);
  const shk = num(cfg, "screen_shake", 1);
  const ox = Math.round(cam.x + sh.x * shk);
  const oy = Math.round(cam.y + sh.y * shk);
  ctx.translate(ox, oy);
  const view = { x0: -ox, y0: -oy, x1: -ox + w, y1: -oy + h };

  drawFloor(ctx, st.bake, view);
  drawFloorDynamics(ctx, sim, st, rs, t, q);

  updateCutaway(sim, st, dt, num(cfg, "wall_cutaway_alpha", 0.3));
  drawScene(ctx, sim, st, rs, t, q, view);

  drawTracers(ctx, st, q);
  st.fx.draw(ctx, q > 0);
  if (sim.alarm && q > 0) {
    ctx.globalCompositeOperation = "lighter";
    st.bake.lamps.forEach((L, i) => {
      const s = worldToScreen(L.x, L.y);
      const a = 0.5 + 0.5 * Math.sin(t * 5 + i * 1.7);
      drawGlow(ctx, "#ff1e3c", s.x, s.y, 90, 46, 0.35 * a);
    });
    ctx.globalCompositeOperation = "source-over";
  }
  drawOverlays(ctx, sim, st, rs, t);

  // Screen space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (q >= 2 && flag(cfg, "rain_enabled", true)) {
    st.rain.update(dt, w, h, Math.round(num(cfg, "rain_density", 140)));
    st.rain.draw(ctx);
  }
  if (sim.alarm && q > 0) drawAlarmTint(ctx, w, h, t, Math.min(1, (t - st.alarmT) * 2));
  if (q > 0) drawCrtOverlay(ctx, w, h, flag(cfg, "scanlines_enabled", true));
  if (rs.dragBox) {
    const b = rs.dragBox;
    ctx.strokeStyle = COL.agent;
    ctx.fillStyle = "rgba(0,240,255,0.08)";
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
}

function drawFloor(ctx: CanvasRenderingContext2D, bake: WorldBake, v: { x0: number; y0: number; x1: number; y1: number }): void {
  const f = bake.floor;
  const sx0 = Math.max(0, Math.floor((v.x0 - bake.fx) / ART));
  const sy0 = Math.max(0, Math.floor((v.y0 - bake.fy) / ART));
  const sx1 = Math.min(f.width, Math.ceil((v.x1 - bake.fx) / ART));
  const sy1 = Math.min(f.height, Math.ceil((v.y1 - bake.fy) / ART));
  if (sx1 <= sx0 || sy1 <= sy0) return;
  ctx.drawImage(f, sx0, sy0, sx1 - sx0, sy1 - sy0, bake.fx + sx0 * ART, bake.fy + sy0 * ART, (sx1 - sx0) * ART, (sy1 - sy0) * ART);
}

function diamond(ctx: CanvasRenderingContext2D, sx: number, sy: number, inset = 0): void {
  ctx.beginPath();
  ctx.moveTo(sx, sy + inset);
  ctx.lineTo(sx + TILE_W / 2 - inset * 2, sy + TILE_H / 2);
  ctx.lineTo(sx, sy + TILE_H - inset);
  ctx.lineTo(sx - TILE_W / 2 + inset * 2, sy + TILE_H / 2);
  ctx.closePath();
}

function drawFloorDynamics(ctx: CanvasRenderingContext2D, sim: Sim, st: State, rs: RenderState, t: number, q: number): void {
  const map = sim.map;
  // Extraction pad pulse.
  if (q > 0) {
    ctx.globalCompositeOperation = "lighter";
    for (const e of st.bake.extract) {
      const s = worldToScreen(e.x, e.y);
      const a = 0.06 + 0.06 * Math.sin(t * 3 - (e.x + e.y) * 0.7);
      diamond(ctx, s.x, s.y, 2);
      ctx.fillStyle = `rgba(57,255,140,${a})`;
      ctx.fill();
    }
    if (st.bake.extract.length) {
      const m = st.bake.extract[Math.floor(st.bake.extract.length / 2)]!;
      const s = worldToScreen(m.x + 0.5, m.y + 0.5);
      drawGlow(ctx, "#39ff8c", s.x, s.y, 70, 36, 0.25 + 0.1 * Math.sin(t * 2));
    }
    ctx.globalCompositeOperation = "source-over";
  }
  st.fx.drawDecals(ctx);

  // Bodies lie on the floor under everything else.
  for (const e of sim.entities) {
    if (!isCharacter(e) || e.hp > 0) continue;
    const s = worldToScreen(e.pos.x, e.pos.y);
    drawCharacter(ctx, s.x, s.y, { arch: archetypeFor(e.kind, e.cls), skin: e.skin, facing: e.facing, pose: "dead", frame: 0, light: lightAt(st, e.pos) });
  }

  if (rs.hoverTile && map.walkable(Math.floor(rs.hoverTile.x), Math.floor(rs.hoverTile.y))) {
    const s = worldToScreen(Math.floor(rs.hoverTile.x), Math.floor(rs.hoverTile.y));
    diamond(ctx, s.x, s.y, 1);
    ctx.fillStyle = "rgba(0,240,255,0.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,240,255,0.7)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Guard vision cones as flashlight beams.
  for (const g of sim.entities) if (g.kind === "guard" && g.hp > 0) drawCone(ctx, sim, g, q);

  // Planned paths for selected agents.
  for (const id of rs.selected) {
    const e = sim.byId(id);
    if (!e || !e.path.length || e.hp <= 0) continue;
    ctx.setLineDash([4, 5]);
    ctx.lineDashOffset = -t * 30;
    ctx.strokeStyle = "rgba(0,240,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const p0 = worldToScreen(e.pos.x, e.pos.y);
    ctx.moveTo(p0.x, p0.y);
    for (const p of e.path) {
      const s = worldToScreen(p.x, p.y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const last = e.path[e.path.length - 1]!;
    const s = worldToScreen(last.x, last.y);
    const k = 0.5 + 0.5 * Math.sin(t * 6);
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, 8 + k * 3, (8 + k * 3) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Shadows and selection rings for standing units.
  for (const e of sim.entities) {
    if (!isCharacter(e) || e.hp <= 0) continue;
    const s = worldToScreen(e.pos.x, e.pos.y);
    ctx.fillStyle = "rgba(2,1,10,0.55)";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, e.cls === "bruiser" ? 14 : 11, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (rs.selected.has(e.id)) {
      ctx.strokeStyle = COL.agent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 4]);
      ctx.lineDashOffset = -t * 18;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, 16, 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      if (q > 0) {
        ctx.globalCompositeOperation = "lighter";
        drawGlow(ctx, "#00f0ff", s.x, s.y, 26, 13, 0.25);
        ctx.globalCompositeOperation = "source-over";
      }
    }
  }
}

function drawCone(ctx: CanvasRenderingContext2D, sim: Sim, g: Entity, q: number): void {
  const range = num(sim.cfg, "guard_vision_range", 6);
  const half = (num(sim.cfg, "guard_vision_fov", 90) * Math.PI) / 360;
  const rays = 28;
  const o = worldToScreen(g.pos.x, g.pos.y);
  const pts: Vec[] = [];
  for (let i = 0; i <= rays; i++) {
    const a = g.facing - half + (2 * half * i) / rays;
    let r = 0;
    while (r < range) {
      const nx = g.pos.x + Math.cos(a) * (r + 0.2);
      const ny = g.pos.y + Math.sin(a) * (r + 0.2);
      if (sim.map.blocksSight(Math.floor(nx), Math.floor(ny))) break;
      r += 0.2;
    }
    pts.push(worldToScreen(g.pos.x + Math.cos(a) * r, g.pos.y + Math.sin(a) * r));
  }
  const det = Math.min(1, (g.detect ?? 0) / Math.max(0.01, num(sim.cfg, "detection_time", 1.2)));
  const col = sim.alarm ? [255, 40, 70] : det > 0 ? [255, Math.round(200 - 150 * det), Math.round(80 - 40 * det)] : [255, 226, 160];
  const R = range * 45.25;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(1, 0.5);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (const p of pts) ctx.lineTo(p.x - o.x, (p.y - o.y) * 2);
  ctx.closePath();
  const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, R);
  const a0 = q > 0 ? 0.42 : 0.26;
  grad.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a0})`);
  grad.addColorStop(0.6, `rgba(${col[0]},${col[1]},${col[2]},${a0 * 0.45})`);
  grad.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0.03)`);
  if (q > 0) ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.55)`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Walls cut-away

function updateCutaway(sim: Sim, st: State, dt: number, alpha: number): void {
  const { fadeTarget, fade } = st;
  const W = sim.map.width;
  const H = sim.map.height;
  fadeTarget.fill(1);
  for (const e of sim.entities) {
    if (e.hp <= 0 || !isCharacter(e)) continue;
    const s = worldToScreen(e.pos.x, e.pos.y);
    const ex = Math.floor(e.pos.x);
    const ey = Math.floor(e.pos.y);
    const top = s.y - 50;
    const bottom = s.y - 4;
    for (let dy = 0; dy <= 3; dy++)
      for (let dx = 0; dx <= 3; dx++) {
        if (!dx && !dy) continue;
        const x = ex + dx;
        const y = ey + dy;
        if (x >= W || y >= H) continue;
        const b = st.bake.blockAt[y * W + x];
        if (!b || !b.wall) continue;
        const cxB = b.x + 32;
        const off = Math.abs(s.x - cxB);
        if (off > 26) continue;
        const bTop = b.y + off * 0.5;
        const bBottom = b.y + WALL_H * ART + 32 - off * 0.5;
        if (bottom > bTop && top < bBottom) fadeTarget[y * W + x] = alpha;
      }
  }
  const k = Math.min(1, dt * 9);
  for (let i = 0; i < fade.length; i++) fade[i]! += (fadeTarget[i]! - fade[i]!) * k;
}

// ---------------------------------------------------------------------------
// Painter: blocks + units interleaved by depth

function lightAt(st: State, p: Vec): number {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= st.bake.width || y >= st.bake.height) return 2;
  return st.bake.tileLevel[y * st.bake.width + x]!;
}

function drawScene(ctx: CanvasRenderingContext2D, sim: Sim, st: State, rs: RenderState, t: number, q: number, v: { x0: number; y0: number; x1: number; y1: number }): void {
  const ents = sim.entities.filter((e) => !isCharacter(e) || e.hp > 0).sort((a, b) => a.pos.x + a.pos.y - (b.pos.x + b.pos.y));
  const order = st.order;
  const W = sim.map.width;
  let bi = 0;
  const drawBlock = (b: BlockSprite) => {
    const cw = b.sw * ART;
    const ch = b.sh * ART;
    if (b.x > v.x1 || b.y > v.y1 || b.x + cw < v.x0 || b.y + ch < v.y0) return;
    const a = b.wall ? st.fade[b.ty * W + b.tx]! : 1;
    ctx.globalAlpha = a;
    ctx.drawImage(b.canvas, b.sx, b.sy, b.sw, b.sh, b.x, b.y, cw, ch);
    if (q > 0 && b.glows.length) {
      ctx.globalCompositeOperation = "lighter";
      for (const g of b.glows) {
        let k = 1;
        if (g.flicker === 1) {
          const n = Math.sin(t * 31 + g.seed) * Math.sin(t * 7.3 + g.seed * 0.1);
          k = n > 0.85 ? 0.15 : 0.9 + 0.1 * Math.sin(t * 50 + g.seed);
        } else if (g.flicker === 2) k = 0.75 + 0.25 * Math.sin(t * 3 + g.seed);
        drawGlow(ctx, g.color, g.x, g.y, g.rx, g.ry, a * 0.32 * k);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
  };
  for (const e of ents) {
    const d = e.pos.x + e.pos.y;
    while (bi < order.length && order[bi]!.depth <= d) drawBlock(order[bi++]!);
    if (!isCharacter(e)) {
      ctx.save();
      drawObject(ctx, sim, e, t);
      ctx.restore();
      continue;
    }
    drawUnit(ctx, sim, st, e, rs, t, q);
  }
  while (bi < order.length) drawBlock(order[bi++]!);
}

function drawUnit(ctx: CanvasRenderingContext2D, sim: Sim, st: State, e: Entity, rs: RenderState, t: number, q: number): void {
  const u = unit(st, e);
  const s = worldToScreen(e.pos.x, e.pos.y);
  const arch = archetypeFor(e.kind, e.cls);
  let pose: Pose = "idle";
  let frame = Math.floor(t * 1.6 + e.id * 0.37);
  if (u.aimUntil > t) {
    pose = "aim";
    frame = 0;
  } else if (u.moving > 0) {
    pose = "walk";
    frame = Math.floor(u.walk / 0.3);
  }
  let light = lightAt(st, e.pos);
  if (e.kind === "agent") light = 3;
  else light = Math.max(light, 1);

  // Movement afterimage for skins with a trail colour (katana / founder / samurai).
  const pal = e.kind === "agent" ? characterPalette(arch, e.skin) : null;
  if (pal?.trail && q > 0) {
    if (u.moving > 0) u.trail.push({ x: s.x, y: s.y - 20, t });
    u.trail = u.trail.filter((p) => t - p.t < 0.28);
    if (u.trail.length > 1) {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = pal.trail;
      ctx.lineCap = "round";
      for (let i = 1; i < u.trail.length; i++) {
        const a = u.trail[i - 1]!;
        const b = u.trail[i]!;
        const k = 1 - (t - b.t) / 0.28;
        ctx.globalAlpha = 0.5 * k;
        ctx.lineWidth = 1 + 5 * k;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      ctx.globalCompositeOperation = "source-over";
    }
  }
  drawCharacter(ctx, s.x, s.y, { arch, skin: e.skin, facing: e.facing, pose, frame, light, glow: q > 0 ? (q > 1 ? 1 : 0.7) : 0 });
  void sim;
  void rs;
}

function drawTracers(ctx: CanvasRenderingContext2D, st: State, q: number): void {
  if (!st.tracers.length) return;
  ctx.lineCap = "round";
  for (const tr of st.tracers) {
    const k = tr.life / 0.1;
    const col = tr.hostile ? COL.hostileShot : COL.agentShot;
    if (q > 0) {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.35 * k;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(tr.ax, tr.ay);
      ctx.lineTo(tr.bx, tr.by);
      ctx.stroke();
    }
    ctx.globalAlpha = k;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // Draw the head of the tracer only: a streak travelling toward the target.
    const p = 1 - k;
    const hx = tr.ax + (tr.bx - tr.ax) * Math.min(1, p * 1.6 + 0.4);
    const hy = tr.ay + (tr.by - tr.ay) * Math.min(1, p * 1.6 + 0.4);
    const tx = tr.ax + (tr.bx - tr.ax) * Math.max(0, p * 1.6 - 0.2);
    const ty = tr.ay + (tr.by - tr.ay) * Math.max(0, p * 1.6 - 0.2);
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.8 * k;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tr.ax, tr.ay);
    ctx.lineTo(tr.bx, tr.by);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";
  ctx.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------------------
// HUD-ish overlays drawn above everything in world space

function drawOverlays(ctx: CanvasRenderingContext2D, sim: Sim, st: State, rs: RenderState, t: number): void {
  for (const e of sim.entities) {
    if (!isCharacter(e) || e.hp <= 0) continue;
    const s = worldToScreen(e.pos.x, e.pos.y);
    const color = e.kind === "agent" ? COL.agent : e.kind === "guard" ? COL.guard : COL.target;
    const top = s.y - (e.cls === "decker" ? 76 : 66);
    // HP bar: segmented pixel bar.
    if (e.hp < e.maxHp || e.kind === "agent") {
      const segs = 8;
      const filled = Math.ceil((segs * e.hp) / e.maxHp);
      const bw = 26;
      const x0 = Math.round(s.x - bw / 2);
      ctx.fillStyle = "rgba(4,3,14,0.85)";
      ctx.fillRect(x0 - 1, top - 1, bw + 2, 5);
      for (let i = 0; i < segs; i++) {
        ctx.fillStyle = i < filled ? (e.hp / e.maxHp < 0.34 ? "#ff3b5c" : color) : "rgba(255,255,255,0.08)";
        ctx.fillRect(x0 + i * (bw / segs) + 0.5, top, bw / segs - 1, 3);
      }
    }
    if (rs.selected.has(e.id)) {
      const by = top - 8 + Math.sin(t * 5) * 1.5;
      ctx.fillStyle = COL.agent;
      ctx.beginPath();
      ctx.moveTo(s.x - 4, by - 3);
      ctx.lineTo(s.x + 4, by - 3);
      ctx.lineTo(s.x, by + 1);
      ctx.closePath();
      ctx.fill();
    }
    if (e.kind === "guard" && !sim.alarm && (e.detect ?? 0) > 0) {
      const pct = Math.min(1, (e.detect ?? 0) / num(sim.cfg, "detection_time", 1.2));
      const ch = pct > 0.6 ? "!" : "?";
      const y = top - 8 - pct * 4;
      ctx.font = "bold 16px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#07061a";
      ctx.strokeText(ch, s.x, y);
      ctx.fillStyle = pct > 0.6 ? "#ff3b5c" : "#ffe14d";
      ctx.fillText(ch, s.x, y);
      // Ring meter.
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, y - 5, 10, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (e.kind === "target") {
      const y = top - 6 + Math.sin(t * 3) * 2;
      ctx.fillStyle = COL.target;
      ctx.beginPath();
      ctx.moveTo(s.x, y - 5);
      ctx.lineTo(s.x + 4, y);
      ctx.lineTo(s.x, y + 5);
      ctx.lineTo(s.x - 4, y);
      ctx.closePath();
      ctx.fill();
      ctx.font = "bold 9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#07061a";
      ctx.strokeText("TARGET", s.x, y - 9);
      ctx.fillText("TARGET", s.x, y - 9);
      ctx.lineWidth = 1;
    }
  }
  void st;
}
