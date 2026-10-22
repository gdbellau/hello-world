import { TILE_H, TILE_W, worldToScreen, type Vec } from "./iso";
import { Tile } from "./map";
import type { Entity, Sim } from "./sim";

const WALL_H = 44;
const COVER_H = 14;

const C = {
  bg: "#07061a",
  floorA: "#14123a",
  floorB: "#181545",
  grid: "rgba(0,240,255,0.08)",
  wallTop: "#2b2370",
  wallL: "#1b1650",
  wallR: "#120f38",
  wallEdge: "rgba(255,43,214,0.55)",
  cover: "#3a2f8a",
  extract: "rgba(57,255,140,0.35)",
  agent: "#00f0ff",
  guard: "#ff3b5c",
  target: "#ffe14d",
  cone: "rgba(255,59,92,0.13)",
  coneAlert: "rgba(255,59,92,0.28)",
};

export interface Camera {
  x: number; // screen-space offset
  y: number;
}

export interface RenderState {
  selected: Set<number>;
  hoverTile: Vec | null;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
}

function diamond(ctx: CanvasRenderingContext2D, sx: number, sy: number, lift = 0): void {
  ctx.beginPath();
  ctx.moveTo(sx, sy - lift);
  ctx.lineTo(sx + TILE_W / 2, sy + TILE_H / 2 - lift);
  ctx.lineTo(sx, sy + TILE_H - lift);
  ctx.lineTo(sx - TILE_W / 2, sy + TILE_H / 2 - lift);
  ctx.closePath();
}

function block(ctx: CanvasRenderingContext2D, sx: number, sy: number, h: number, top: string, left: string, right: string): void {
  // Left face
  ctx.beginPath();
  ctx.moveTo(sx - TILE_W / 2, sy + TILE_H / 2 - h);
  ctx.lineTo(sx, sy + TILE_H - h);
  ctx.lineTo(sx, sy + TILE_H);
  ctx.lineTo(sx - TILE_W / 2, sy + TILE_H / 2);
  ctx.closePath();
  ctx.fillStyle = left;
  ctx.fill();
  // Right face
  ctx.beginPath();
  ctx.moveTo(sx + TILE_W / 2, sy + TILE_H / 2 - h);
  ctx.lineTo(sx, sy + TILE_H - h);
  ctx.lineTo(sx, sy + TILE_H);
  ctx.lineTo(sx + TILE_W / 2, sy + TILE_H / 2);
  ctx.closePath();
  ctx.fillStyle = right;
  ctx.fill();
  // Top
  diamond(ctx, sx, sy, h);
  ctx.fillStyle = top;
  ctx.fill();
}

export function render(ctx: CanvasRenderingContext2D, sim: Sim, cam: Camera, rs: RenderState, t: number): void {
  const { width, height } = ctx.canvas;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.translate(Math.round(cam.x), Math.round(cam.y));

  const map = sim.map;

  // 1. Floors (never occlude anything).
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.get(x, y);
      if (tile === Tile.Wall) continue;
      const s = worldToScreen(x, y);
      diamond(ctx, s.x, s.y);
      ctx.fillStyle = tile === Tile.Extract ? C.extract : (x + y) % 2 ? C.floorA : C.floorB;
      ctx.fill();
      ctx.strokeStyle = C.grid;
      ctx.stroke();
    }
  }
  if (rs.hoverTile && map.walkable(Math.floor(rs.hoverTile.x), Math.floor(rs.hoverTile.y))) {
    const s = worldToScreen(Math.floor(rs.hoverTile.x), Math.floor(rs.hoverTile.y));
    diamond(ctx, s.x, s.y);
    ctx.strokeStyle = "rgba(0,240,255,0.6)";
    ctx.stroke();
  }

  // 2. Guard vision cones, drawn on the floor plane.
  for (const g of sim.entities) if (g.kind === "guard" && g.hp > 0) drawCone(ctx, sim, g);

  // 3. Walls, cover and entities, painter-sorted by depth (x + y).
  type Drawable = { depth: number; draw: () => void };
  const list: Drawable[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.get(x, y);
      if (tile !== Tile.Wall && tile !== Tile.Cover) continue;
      const s = worldToScreen(x, y);
      list.push({
        depth: x + y + 1,
        draw: () =>
          tile === Tile.Wall
            ? (block(ctx, s.x, s.y, WALL_H, C.wallTop, C.wallL, C.wallR), edge(ctx, s.x, s.y))
            : block(ctx, s.x, s.y, COVER_H, C.cover, C.wallL, C.wallR),
      });
    }
  }
  for (const e of sim.entities) list.push({ depth: e.pos.x + e.pos.y, draw: () => drawEntity(ctx, sim, e, rs.selected.has(e.id), t) });
  list.sort((a, b) => a.depth - b.depth);
  for (const d of list) d.draw();

  // 4. Tracers.
  for (const s of sim.shots) {
    const a = worldToScreen(s.from.x, s.from.y);
    const b = worldToScreen(s.to.x, s.to.y);
    ctx.strokeStyle = s.hostile ? C.guard : C.agent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - 18);
    ctx.lineTo(b.x, b.y - 18);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // 5. Movement paths for selected agents.
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(0,240,255,0.5)";
  for (const id of rs.selected) {
    const e = sim.byId(id);
    if (!e || !e.path.length) continue;
    ctx.beginPath();
    const p0 = worldToScreen(e.pos.x, e.pos.y);
    ctx.moveTo(p0.x, p0.y);
    for (const p of e.path) {
      const s = worldToScreen(p.x, p.y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (rs.dragBox) {
    const b = rs.dragBox;
    ctx.strokeStyle = C.agent;
    ctx.fillStyle = "rgba(0,240,255,0.08)";
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
}

function edge(ctx: CanvasRenderingContext2D, sx: number, sy: number): void {
  diamond(ctx, sx, sy, WALL_H);
  ctx.strokeStyle = C.wallEdge;
  ctx.stroke();
}

function drawCone(ctx: CanvasRenderingContext2D, sim: Sim, g: Entity): void {
  const range = Number(sim.cfg.guard_vision_range);
  const half = (Number(sim.cfg.guard_vision_fov) * Math.PI) / 360;
  const rays = 24;
  ctx.beginPath();
  const o = worldToScreen(g.pos.x, g.pos.y);
  ctx.moveTo(o.x, o.y);
  for (let i = 0; i <= rays; i++) {
    const a = g.facing - half + (2 * half * i) / rays;
    // March the ray until it hits a wall.
    let r = 0;
    while (r < range) {
      const nx = g.pos.x + Math.cos(a) * (r + 0.25);
      const ny = g.pos.y + Math.sin(a) * (r + 0.25);
      if (sim.map.blocksSight(Math.floor(nx), Math.floor(ny))) break;
      r += 0.25;
    }
    const s = worldToScreen(g.pos.x + Math.cos(a) * r, g.pos.y + Math.sin(a) * r);
    ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
  ctx.fillStyle = sim.alarm || (g.detect ?? 0) > 0 ? C.coneAlert : C.cone;
  ctx.fill();
}

function drawEntity(ctx: CanvasRenderingContext2D, sim: Sim, e: Entity, selected: boolean, t: number): void {
  const s = worldToScreen(e.pos.x, e.pos.y);
  const color = e.kind === "agent" ? C.agent : e.kind === "guard" ? C.guard : C.target;

  if (e.hp <= 0) {
    ctx.fillStyle = "rgba(120,0,30,0.7)";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#555";
    ctx.fillRect(s.x - 10, s.y - 4, 20, 5);
    return;
  }

  // Shadow / selection ring.
  ctx.beginPath();
  ctx.ellipse(s.x, s.y, 13, 6.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();
  if (selected) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Body: a stylised capsule with a glowing visor facing the move direction.
  const bob = e.path.length ? Math.sin(t * 14 + e.id) * 1.5 : 0;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#0d0b24";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(s.x - 7, s.y - 30 + bob, 14, 26, 6);
  ctx.fill();
  ctx.stroke();
  const f = worldToScreen(Math.cos(e.facing), Math.sin(e.facing));
  const fl = Math.hypot(f.x, f.y) || 1;
  ctx.fillStyle = color;
  ctx.fillRect(s.x + (f.x / fl) * 4 - 3, s.y - 25 + bob, 6, 3);
  ctx.restore();

  // HP bar.
  if (e.hp < e.maxHp || e.kind === "agent") {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(s.x - 12, s.y - 40, 24, 4);
    ctx.fillStyle = color;
    ctx.fillRect(s.x - 12, s.y - 40, (24 * e.hp) / e.maxHp, 4);
  }
  // Detection meter.
  if (e.kind === "guard" && !sim.alarm && (e.detect ?? 0) > 0) {
    const pct = Math.min(1, (e.detect ?? 0) / Number(sim.cfg.detection_time));
    ctx.fillStyle = "#ffe14d";
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "center";
    ctx.globalAlpha = 0.4 + 0.6 * pct;
    ctx.fillText(pct > 0.6 ? "!" : "?", s.x, s.y - 46);
    ctx.globalAlpha = 1;
  }
  if (e.kind === "target") {
    ctx.fillStyle = C.target;
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("◆ TARGET", s.x, s.y - 46);
  }
}
