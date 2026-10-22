// Deterministic-ish mission simulation. No DOM or canvas access here so it
// can be unit tested and, later, re-run server-side to validate results.

import type { SettingsMap } from "../../shared/settings";
import { dist, type Vec } from "./iso";
import { Tile, type MissionDef, type TileMap } from "./map";

export type Kind = "agent" | "guard" | "target";

export interface Entity {
  id: number;
  kind: Kind;
  name: string;
  pos: Vec;
  facing: number; // radians, world space
  hp: number;
  maxHp: number;
  speed: number;
  path: Vec[];
  cooldown: number;
  // Agents
  attackId?: number;
  // Guards / target
  patrol?: Vec[];
  patrolIdx?: number;
  repathIn?: number;
  detect?: number; // per-guard detection meter, seconds
  wait?: number; // seconds left idling at a patrol waypoint
}

export interface Shot {
  from: Vec;
  to: Vec;
  ttl: number;
  hostile: boolean;
}

export type Outcome = "win" | "loss" | null;

const AGENT_NAMES = ["VIPER", "GHOST", "RAZOR", "HEX", "BRICK", "NOVA"];
const MELEE_RANGE = 1.25;

export class Sim {
  readonly map: TileMap;
  readonly entities: Entity[] = [];
  readonly shots: Shot[] = [];
  readonly mission: MissionDef;
  time = 0;
  alarm = false;
  outcome: Outcome = null;
  private nextId = 1;

  constructor(mission: MissionDef, readonly cfg: SettingsMap) {
    this.mission = mission;
    this.map = mission.map;
    const n = Math.min(Number(cfg.squad_size), mission.agentSpawns.length);
    for (let i = 0; i < n; i++) {
      this.spawn("agent", AGENT_NAMES[i] ?? `AGENT ${i + 1}`, mission.agentSpawns[i]!, Number(cfg.agent_hp), Number(cfg.agent_speed));
    }
    mission.guards.forEach((g, i) => {
      const e = this.spawn("guard", `GUARD ${i + 1}`, g.patrol[0]!, Number(cfg.guard_hp), Number(cfg.guard_speed));
      e.patrol = g.patrol;
      e.patrolIdx = 0;
      e.detect = 0;
    });
    const t = this.spawn("target", "CFO M. VANCE", mission.target.pos, 40, 1.2);
    t.patrol = mission.target.patrol;
    t.patrolIdx = 0;
  }

  private spawn(kind: Kind, name: string, pos: Vec, hp: number, speed: number): Entity {
    const e: Entity = { id: this.nextId++, kind, name, pos: { ...pos }, facing: 0, hp, maxHp: hp, speed, path: [], cooldown: 0 };
    this.entities.push(e);
    return e;
  }

  get agents() {
    return this.entities.filter((e) => e.kind === "agent" && e.hp > 0);
  }
  get hostiles() {
    return this.entities.filter((e) => e.kind !== "agent" && e.hp > 0);
  }
  get target() {
    return this.entities.find((e) => e.kind === "target")!;
  }
  byId(id: number) {
    return this.entities.find((e) => e.id === id);
  }

  // --- Orders ---------------------------------------------------------------

  orderMove(ids: number[], dest: Vec): void {
    const slots = this.formationSlots(dest, ids.length);
    ids.forEach((id, i) => {
      const e = this.byId(id);
      if (!e || e.hp <= 0) return;
      e.attackId = undefined;
      e.path = this.map.findPath(e.pos, slots[i] ?? dest) ?? [];
    });
  }

  orderAttack(ids: number[], targetId: number): void {
    for (const id of ids) {
      const e = this.byId(id);
      if (e && e.hp > 0) {
        e.attackId = targetId;
        e.path = [];
      }
    }
  }

  /** Nearest walkable tiles around dest so a squad doesn't stack on one tile. */
  private formationSlots(dest: Vec, n: number): Vec[] {
    const cx = Math.floor(dest.x);
    const cy = Math.floor(dest.y);
    const out: Vec[] = [];
    for (let r = 0; r <= 3 && out.length < n; r++) {
      for (let dy = -r; dy <= r && out.length < n; dy++) {
        for (let dx = -r; dx <= r && out.length < n; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.map.walkable(cx + dx, cy + dy)) out.push({ x: cx + dx + 0.5, y: cy + dy + 0.5 });
        }
      }
    }
    return out;
  }

  // --- Tick -----------------------------------------------------------------

  update(dt: number): void {
    if (this.outcome) return;
    this.time += dt;
    for (const s of this.shots) s.ttl -= dt;
    for (let i = this.shots.length - 1; i >= 0; i--) if (this.shots[i]!.ttl <= 0) this.shots.splice(i, 1);

    for (const e of this.entities) {
      if (e.hp <= 0) continue;
      e.cooldown = Math.max(0, e.cooldown - dt);
      if (e.kind === "agent") this.updateAgent(e, dt);
      else if (e.kind === "guard") this.updateGuard(e, dt);
      else this.updateTarget(e, dt);
    }
    this.checkOutcome();
  }

  private step(e: Entity, dt: number): void {
    let budget = e.speed * dt;
    while (budget > 0 && e.path.length) {
      const next = e.path[0]!;
      const d = dist(e.pos, next);
      e.facing = Math.atan2(next.y - e.pos.y, next.x - e.pos.x);
      if (d <= budget) {
        e.pos = { ...next };
        e.path.shift();
        budget -= d;
      } else {
        e.pos.x += ((next.x - e.pos.x) / d) * budget;
        e.pos.y += ((next.y - e.pos.y) / d) * budget;
        budget = 0;
      }
    }
  }

  canSee(a: Vec, b: Vec, range: number): boolean {
    return dist(a, b) <= range && this.map.lineOfSight(a, b);
  }

  private fire(from: Entity, to: Entity, damage: number, cooldown: number, hostile: boolean): void {
    from.facing = Math.atan2(to.pos.y - from.pos.y, to.pos.x - from.pos.x);
    from.cooldown = cooldown;
    this.shots.push({ from: { ...from.pos }, to: { ...to.pos }, ttl: 0.12, hostile });
    to.hp = Math.max(0, to.hp - damage);
    this.alarm = true; // gunfire is loud
  }

  private updateAgent(e: Entity, dt: number): void {
    const range = Number(this.cfg.agent_weapon_range);
    const ordered = e.attackId !== undefined ? this.byId(e.attackId) : undefined;
    if (ordered && ordered.hp <= 0) e.attackId = undefined;

    if (ordered && ordered.hp > 0) {
      const d = dist(e.pos, ordered.pos);
      // Silent takedown: reach an unaware target in melee range.
      if (!this.alarm && d <= MELEE_RANGE) {
        ordered.hp = 0;
        e.attackId = undefined;
        e.path = [];
        return;
      }
      if (this.alarm && this.canSee(e.pos, ordered.pos, range)) {
        e.path = [];
        if (e.cooldown === 0) this.fire(e, ordered, Number(this.cfg.agent_weapon_damage), Number(this.cfg.agent_fire_cooldown), false);
        return;
      }
      if (!e.path.length || (e.repathIn = (e.repathIn ?? 0) - dt) <= 0) {
        e.repathIn = 0.4;
        e.path = this.map.findPath(e.pos, ordered.pos) ?? [];
        // Don't step onto the victim's tile.
        if (e.path.length) e.path.pop();
      }
    } else if (this.alarm && e.cooldown === 0) {
      // Return fire at the nearest visible hostile once things are loud.
      const tgt = this.nearestVisible(e, this.hostiles, range);
      if (tgt) this.fire(e, tgt, Number(this.cfg.agent_weapon_damage), Number(this.cfg.agent_fire_cooldown), false);
    }
    this.step(e, dt);
  }

  private nearestVisible(from: Entity, pool: Entity[], range: number): Entity | undefined {
    let best: Entity | undefined;
    let bestD = Infinity;
    for (const o of pool) {
      const d = dist(from.pos, o.pos);
      if (d < bestD && this.canSee(from.pos, o.pos, range)) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  inVisionCone(g: Entity, p: Vec): boolean {
    const range = Number(this.cfg.guard_vision_range);
    const half = (Number(this.cfg.guard_vision_fov) * Math.PI) / 360;
    if (dist(g.pos, p) > range) return false;
    let a = Math.atan2(p.y - g.pos.y, p.x - g.pos.x) - g.facing;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    return Math.abs(a) <= half && this.map.lineOfSight(g.pos, p);
  }

  private updateGuard(g: Entity, dt: number): void {
    const range = Number(this.cfg.guard_vision_range);
    if (!this.alarm) {
      const seen = this.agents.some((a) => this.inVisionCone(g, a.pos));
      g.detect = seen ? (g.detect ?? 0) + dt : Math.max(0, (g.detect ?? 0) - dt * 0.5);
      if (g.detect >= Number(this.cfg.detection_time)) this.alarm = true;
      // Bodies on the floor in view also trip the alarm.
      if (this.hostiles.length < this.entities.filter((e) => e.kind !== "agent").length) {
        const body = this.entities.find((e) => e.kind !== "agent" && e.hp <= 0 && this.inVisionCone(g, e.pos));
        if (body) this.alarm = true;
      }
      this.patrol(g, dt);
      return;
    }
    const tgt = this.nearestVisible(g, this.agents, range);
    if (tgt) {
      g.path = [];
      g.facing = Math.atan2(tgt.pos.y - g.pos.y, tgt.pos.x - g.pos.x);
      if (g.cooldown === 0) this.fire(g, tgt, Number(this.cfg.guard_damage), Number(this.cfg.guard_fire_cooldown), true);
      return;
    }
    g.repathIn = (g.repathIn ?? 0) - dt;
    if (g.repathIn <= 0) {
      g.repathIn = 0.75;
      let nearest: Entity | undefined;
      for (const a of this.agents) if (!nearest || dist(g.pos, a.pos) < dist(g.pos, nearest.pos)) nearest = a;
      if (nearest) g.path = this.map.findPath(g.pos, nearest.pos) ?? [];
    }
    this.step(g, dt);
  }

  private patrol(e: Entity, dt: number): void {
    if (!e.path.length && e.patrol && e.patrol.length) {
      if ((e.wait ?? 0) > 0) {
        // Idle look-around while standing at a waypoint.
        e.wait! -= dt;
        e.facing += dt * 1.2;
      } else {
        const wp = e.patrol[e.patrolIdx ?? 0]!;
        if (dist(e.pos, wp) < 0.1) {
          e.patrolIdx = ((e.patrolIdx ?? 0) + 1) % e.patrol.length;
          e.wait = 1.5;
        } else {
          e.path = this.map.findPath(e.pos, wp) ?? [];
        }
      }
    }
    this.step(e, dt);
  }

  private updateTarget(t: Entity, dt: number): void {
    if (this.alarm) {
      // Panic: run for the nearest extraction tile.
      if (!t.path.length) t.path = this.map.findPath(t.pos, this.extractTiles()[0]!) ?? [];
      this.step(t, dt);
      return;
    }
    this.patrol(t, dt);
  }

  extractTiles(): Vec[] {
    const out: Vec[] = [];
    for (let y = 0; y < this.map.height; y++)
      for (let x = 0; x < this.map.width; x++) if (this.map.get(x, y) === Tile.Extract) out.push({ x: x + 0.5, y: y + 0.5 });
    return out;
  }

  private checkOutcome(): void {
    const agents = this.agents;
    if (!agents.length) {
      this.outcome = "loss";
      return;
    }
    const t = this.target;
    // The target escaping through the extraction point is a failure.
    if (t.hp > 0 && this.map.get(Math.floor(t.pos.x), Math.floor(t.pos.y)) === Tile.Extract) {
      this.outcome = "loss";
      return;
    }
    if (t.hp <= 0 && agents.every((a) => this.map.get(Math.floor(a.pos.x), Math.floor(a.pos.y)) === Tile.Extract)) {
      this.outcome = "win";
    }
  }
}
