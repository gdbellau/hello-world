// Rendering for mission objects that aren't agents, guards or the target
// (cameras, turrets, terminals, doors, packages, civilians). Owned by the
// missions workstream so render.ts (owned by art) doesn't need to change for
// new kinds. render.ts depth-sorts entities and calls drawObject for these.

import { drawCharacter } from "./gfx/sprites";
import { TILE_H, TILE_W, worldToScreen, type Vec } from "./iso";
import { Tile } from "./map";
import type { Entity, Sim } from "./sim";

// Mirror render.ts' block heights so doors line up with walls and cone clipping matches.
const WALL_H = 44;
const COVER_H = 14;

const C = {
  cyan: "#00f0ff",
  magenta: "#ff2bd6",
  yellow: "#ffe14d",
  red: "#ff3b5c",
  green: "#39ff8c",
  dead: "#3a3550",
  metal: "#1d1a44",
  metalHi: "#2e2a66",
  metalLo: "#120f38",
  civilian: "#b9a7ff",
  coat: "#e8f4ff",
  camCone: "rgba(255,225,77,0.13)",
  camConeHot: "rgba(255,59,92,0.26)",
};

export function drawObject(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, t: number): void {
  switch (e.kind) {
    case "camera":
      return drawCamera(ctx, sim, e, t);
    case "turret":
      return drawTurret(ctx, sim, e, t);
    case "terminal":
      return drawTerminal(ctx, sim, e, t);
    case "door":
      return drawDoor(ctx, sim, e, t);
    case "package":
      return drawPackage(ctx, sim, e, t);
    case "civilian":
      return drawCivilian(ctx, sim, e, t);
    default:
      return;
  }
}

// --- Helpers ---------------------------------------------------------------

/** Unit screen-space direction for a world-space facing angle. */
function screenDir(facing: number): Vec {
  const f = worldToScreen(Math.cos(facing), Math.sin(facing));
  const l = Math.hypot(f.x, f.y) || 1;
  return { x: f.x / l, y: f.y / l };
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy);
  ctx.closePath();
}

/** An iso box centred on (cx, cy) at floor level, `scale` of a tile wide, `h` px tall. */
function box(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number, h: number, top: string, left: string, right: string): void {
  const w = (TILE_W * scale) / 2;
  const d = (TILE_H * scale) / 2;
  ctx.beginPath();
  ctx.moveTo(cx - w, cy - h);
  ctx.lineTo(cx, cy + d - h);
  ctx.lineTo(cx, cy + d);
  ctx.lineTo(cx - w, cy);
  ctx.closePath();
  ctx.fillStyle = left;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + w, cy - h);
  ctx.lineTo(cx, cy + d - h);
  ctx.lineTo(cx, cy + d);
  ctx.lineTo(cx + w, cy);
  ctx.closePath();
  ctx.fillStyle = right;
  ctx.fill();
  diamond(ctx, cx, cy - h, w * 2, d * 2);
  ctx.fillStyle = top;
  ctx.fill();
}

function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, rx = 13, ry = 6.5): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(7,6,26,0.75)";
  const w = ctx.measureText(text).width + 6;
  ctx.fillRect(x - w / 2, y - 9, w, 12);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function progressBar(ctx: CanvasRenderingContext2D, x: number, y: number, pct: number, color: string): void {
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(x - 16, y, 32, 5);
  ctx.fillStyle = color;
  ctx.fillRect(x - 16, y, 32 * Math.max(0, Math.min(1, pct)), 5);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(x - 16.5, y - 0.5, 33, 6);
}

function glow<T>(ctx: CanvasRenderingContext2D, color: string, blur: number, fn: () => T): T {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  const r = fn();
  ctx.restore();
  return r;
}

/**
 * Vision cone on the floor plane, ray-marched against sight-blocking tiles.
 * Unlike guard cones (drawn by render.ts before any blocks), this runs inside
 * the depth-sorted pass, so blocks already painted (lower depth) are clipped
 * out of it to keep the cone on the floor.
 */
function drawCone(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, fill: string): void {
  const { range, half } = sim.visionParams(e);
  const rays = 20;
  const o = worldToScreen(e.pos.x, e.pos.y);
  ctx.save();
  const depth = e.pos.x + e.pos.y;
  const r = Math.ceil(range) + 1;
  const big = 1e5;
  for (let y = Math.floor(e.pos.y) - r; y <= Math.floor(e.pos.y) + r; y++) {
    for (let x = Math.floor(e.pos.x) - r; x <= Math.floor(e.pos.x) + r; x++) {
      if (x < 0 || y < 0 || x >= sim.map.width || y >= sim.map.height || x + y + 1 > depth) continue;
      const tile = sim.map.get(x, y);
      const h = tile === Tile.Wall || tile === Tile.Door ? WALL_H : tile === Tile.Cover ? COVER_H : 0;
      if (!h) continue;
      const s = worldToScreen(x, y);
      ctx.beginPath();
      ctx.rect(-big, -big, 2 * big, 2 * big);
      ctx.moveTo(s.x, s.y - h);
      ctx.lineTo(s.x + TILE_W / 2, s.y + TILE_H / 2 - h);
      ctx.lineTo(s.x + TILE_W / 2, s.y + TILE_H / 2);
      ctx.lineTo(s.x, s.y + TILE_H);
      ctx.lineTo(s.x - TILE_W / 2, s.y + TILE_H / 2);
      ctx.lineTo(s.x - TILE_W / 2, s.y + TILE_H / 2 - h);
      ctx.closePath();
      ctx.clip("evenodd");
    }
  }
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  for (let i = 0; i <= rays; i++) {
    const a = e.facing - half + (2 * half * i) / rays;
    let r = 0;
    while (r < range) {
      const nx = e.pos.x + Math.cos(a) * (r + 0.25);
      const ny = e.pos.y + Math.sin(a) * (r + 0.25);
      if (sim.map.blocksSight(Math.floor(nx), Math.floor(ny))) break;
      r += 0.25;
    }
    const s = worldToScreen(e.pos.x + Math.cos(a) * r, e.pos.y + Math.sin(a) * r);
    ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

// --- Cameras ---------------------------------------------------------------

function drawCamera(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  const alive = e.hp > 0;
  const active = alive && !e.disabled;
  const hot = active && (sim.alarm || (e.detect ?? 0) > 0);
  if (active) drawCone(ctx, sim, e, hot ? C.camConeHot : C.camCone);

  // Pole and base plate.
  box(ctx, s.x, s.y, 0.35, 5, C.metalHi, C.metal, C.metalLo);
  const poleH = alive ? 36 : 18;
  ctx.strokeStyle = alive ? "#4b4590" : C.dead;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y - 4);
  ctx.lineTo(s.x, s.y - poleH);
  ctx.stroke();
  ctx.lineWidth = 1;
  if (!alive) {
    // Snapped pole, a few sparks.
    ctx.fillStyle = C.yellow;
    for (let i = 0; i < 3; i++) {
      const k = (t * 3 + i * 0.37) % 1;
      ctx.globalAlpha = 1 - k;
      ctx.fillRect(s.x - 4 + i * 4, s.y - poleH - 4 + k * 12, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
    return;
  }

  // Head: a small housing pointing along the facing, lens at the front.
  const f = screenDir(e.facing);
  const hx = s.x;
  const hy = s.y - poleH;
  const color = !active ? "#6b6890" : hot ? C.red : C.yellow;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(Math.atan2(f.y, f.x));
  ctx.fillStyle = "#0d0b24";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(-7, -4, 16, 8, 2);
  ctx.fill();
  ctx.stroke();
  glow(ctx, color, active ? 10 : 0, () => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(9, 0, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
  // Status LED.
  const blink = active && Math.sin(t * (hot ? 14 : 4) + e.id) > 0;
  ctx.fillStyle = !active ? "#444" : blink ? (hot ? C.red : C.green) : "#222";
  ctx.fillRect(hx - 1.5, hy - 8, 3, 3);
  if (e.disabled) label(ctx, "OFFLINE", s.x, s.y - poleH - 12, "#8a87b8", 0.8);
}

// --- Turrets ---------------------------------------------------------------

function drawTurret(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  shadow(ctx, s.x, s.y + 2, 18, 9);
  if (e.hp <= 0) {
    box(ctx, s.x, s.y, 0.6, 8, C.dead, "#221f38", "#1a1730");
    ctx.strokeStyle = "#555";
    ctx.beginPath();
    ctx.moveTo(s.x - 6, s.y - 10);
    ctx.lineTo(s.x + 10, s.y - 14);
    ctx.stroke();
    return;
  }
  const armed = sim.alarm && !e.disabled;
  const color = e.disabled ? "#6b6890" : armed ? C.red : C.magenta;
  box(ctx, s.x, s.y, 0.6, 12, C.metalHi, C.metal, C.metalLo);
  // Dome.
  const dy = s.y - 18;
  glow(ctx, color, armed ? 14 : 4, () => {
    ctx.fillStyle = "#0d0b24";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(s.x, dy, 11, 8, 0, Math.PI, 0);
    ctx.lineTo(s.x + 11, dy + 3);
    ctx.lineTo(s.x - 11, dy + 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });
  // Twin barrels along the facing.
  const f = screenDir(e.facing);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  for (const off of [-2, 2]) {
    ctx.beginPath();
    ctx.moveTo(s.x - f.y * off, dy - 2 + f.x * off * 0.5);
    ctx.lineTo(s.x + f.x * 18 - f.y * off, dy - 2 + f.y * 18 + f.x * off * 0.5);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  // Eye.
  ctx.fillStyle = armed ? (Math.sin(t * 16) > 0 ? C.red : "#fff") : color;
  ctx.fillRect(s.x - 2, dy - 6, 4, 3);
  if (e.hp < e.maxHp) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(s.x - 12, s.y - 40, 24, 4);
    ctx.fillStyle = C.red;
    ctx.fillRect(s.x - 12, s.y - 40, (24 * e.hp) / e.maxHp, 4);
  }
  if (e.disabled) label(ctx, "OFFLINE", s.x, s.y - 34, "#8a87b8", 0.8);
}

// --- Terminals -------------------------------------------------------------

function drawTerminal(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  const data = e.role !== "security";
  const color = e.done ? C.green : data ? C.cyan : C.yellow;
  shadow(ctx, s.x, s.y + 2, 18, 9);
  // Desk / rack.
  box(ctx, s.x, s.y, 0.62, 18, C.metalHi, C.metal, C.metalLo);
  // Screen tilted toward the viewer.
  const sy = s.y - 18;
  const flicker = e.done ? 1 : 0.75 + 0.25 * Math.sin(t * 9 + e.id * 3);
  glow(ctx, color, 12, () => {
    ctx.fillStyle = "#06121c";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(s.x - 11, sy - 2);
    ctx.lineTo(s.x + 11, sy - 2);
    ctx.lineTo(s.x + 9, sy - 18);
    ctx.lineTo(s.x - 9, sy - 18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });
  // Scrolling code lines.
  ctx.save();
  ctx.globalAlpha = flicker;
  ctx.fillStyle = color;
  for (let i = 0; i < 4; i++) {
    const w = 4 + ((i * 7 + Math.floor(t * 6) + e.id) % 9);
    ctx.fillRect(s.x - 7, sy - 15 + i * 3.2, w, 1.4);
  }
  ctx.restore();
  ctx.lineWidth = 1;

  const pct = (e.progress ?? 0) / sim.hackDuration(e);
  if (e.done) label(ctx, data ? "UPLINKED" : "SEC OFF", s.x, sy - 24, C.green);
  else if (pct > 0) {
    label(ctx, `${Math.floor(pct * 100)}%`, s.x, sy - 30, color);
    progressBar(ctx, s.x, sy - 26, pct, color);
  } else label(ctx, data ? "DATA" : "SECURITY", s.x, sy - 24, color, 0.65 + 0.35 * Math.sin(t * 3 + e.id));
}

// --- Doors -----------------------------------------------------------------

function drawDoor(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  const top = s.y - TILE_H / 2; // tile's top vertex in screen space
  if (e.done) {
    // Open: a glowing threshold on the floor.
    ctx.save();
    ctx.strokeStyle = "rgba(57,255,140,0.55)";
    ctx.setLineDash([3, 3]);
    diamond(ctx, s.x, s.y, TILE_W * 0.8, TILE_H * 0.8);
    ctx.stroke();
    ctx.restore();
    return;
  }
  // Closed: a slab block like a wall but in door colours.
  const h = WALL_H - 4;
  const sx = s.x;
  box(ctx, sx, top + TILE_H / 2, 1, h, "#3a1a5a", "#2a1145", "#1d0c33");
  // Hazard light strip on the visible faces.
  const pulse = 0.55 + 0.45 * Math.sin(t * 4 + e.id);
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.strokeStyle = C.magenta;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx - TILE_W / 2 + 4, s.y - h * 0.5);
  ctx.lineTo(sx, s.y + TILE_H / 2 - h * 0.5 + 2);
  ctx.lineTo(sx + TILE_W / 2 - 4, s.y - h * 0.5);
  ctx.stroke();
  ctx.restore();
  // Lock glyph.
  glow(ctx, C.magenta, 8, () => {
    ctx.fillStyle = C.magenta;
    ctx.fillRect(sx - 3, s.y - h - 1, 6, 5);
    ctx.strokeStyle = C.magenta;
    ctx.beginPath();
    ctx.arc(sx, s.y - h - 1, 2.5, Math.PI, 0);
    ctx.stroke();
  });
  const pct = (e.progress ?? 0) / sim.hackDuration(e);
  if (pct > 0) progressBar(ctx, sx, s.y - h - 16, pct, C.magenta);
}

// --- Packages --------------------------------------------------------------

function drawPackage(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  const scientist = e.role === "scientist";
  const carried = e.carrierId !== undefined;
  if (carried) {
    // Slung over the carrier's shoulder.
    const bob = Math.sin(t * 10 + e.id) * 1;
    if (scientist) {
      ctx.save();
      ctx.translate(s.x + 2, s.y - 30 + bob);
      ctx.rotate(-0.25);
      ctx.fillStyle = C.coat;
      ctx.strokeStyle = C.yellow;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-11, -4, 22, 8, 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else {
      glow(ctx, C.yellow, 10, () => {
        ctx.fillStyle = "#1a1500";
        ctx.strokeStyle = C.yellow;
        ctx.lineWidth = 1.5;
        ctx.fillRect(s.x + 3, s.y - 26 + bob, 11, 9);
        ctx.strokeRect(s.x + 3, s.y - 26 + bob, 11, 9);
      });
    }
    ctx.lineWidth = 1;
    label(ctx, `◆ ${e.name}`, s.x, s.y - 52, C.yellow);
    return;
  }

  // Beacon column so it reads from across the map.
  const pulse = 0.5 + 0.5 * Math.sin(t * 3 + e.id);
  const grad = ctx.createLinearGradient(0, s.y - 70, 0, s.y);
  grad.addColorStop(0, "rgba(255,225,77,0)");
  grad.addColorStop(1, `rgba(255,225,77,${0.18 + 0.15 * pulse})`);
  ctx.fillStyle = grad;
  ctx.fillRect(s.x - 10, s.y - 70, 20, 70);
  ctx.strokeStyle = `rgba(255,225,77,${0.4 + 0.4 * pulse})`;
  diamond(ctx, s.x, s.y, TILE_W * 0.7, TILE_H * 0.7);
  ctx.stroke();

  if (scientist) {
    // Sedated on a gurney.
    box(ctx, s.x, s.y, 0.55, 10, "#2e2a66", C.metal, C.metalLo);
    ctx.fillStyle = C.coat;
    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y - 13, 13, 5, -0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d9b38c";
    ctx.beginPath();
    ctx.arc(s.x + 10, s.y - 18, 3.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    shadow(ctx, s.x, s.y + 1, 12, 6);
    glow(ctx, C.yellow, 14, () => box(ctx, s.x, s.y, 0.4, 14, "#3d3300", "#2a2300", "#1a1500"));
    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 1.5;
    diamond(ctx, s.x, s.y - 14, TILE_W * 0.4, TILE_H * 0.4);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  label(ctx, `◆ ${e.dropped ? "DROPPED" : e.name}`, s.x, s.y - 30, C.yellow);
}

// --- Civilians -------------------------------------------------------------

function drawCivilian(ctx: CanvasRenderingContext2D, _sim: Sim, e: Entity, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  // Same pixel-art pipeline as agents and guards (gfx/sprites "civilian" archetype).
  const moving = e.path.length > 0;
  const panicked = e.panic !== undefined;
  drawCharacter(ctx, s.x, s.y, {
    arch: "civilian",
    facing: e.facing,
    pose: e.hp <= 0 ? "dead" : moving ? "walk" : "idle",
    frame: Math.floor(t * (panicked ? 14 : 8) + e.id) % 4,
  });
  if (e.hp <= 0) return;
  if (panicked) {
    const calling = !e.reported;
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = calling ? (Math.sin(t * 12) > 0 ? C.red : "#ffb26b") : "#ffb26b";
    ctx.fillText("!", s.x, s.y - 38);
    if (calling && e.panic !== undefined) label(ctx, `CALLING ${Math.ceil(Math.max(0, e.panic))}`, s.x, s.y - 46, C.red);
  }
}
