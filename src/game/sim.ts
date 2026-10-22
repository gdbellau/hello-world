// Deterministic mission simulation. No DOM or canvas access here so it can be
// unit tested and, later, re-run server-side to validate results.

import type { SettingsMap } from "../../shared/settings";
import { dist, type Vec } from "./iso";
import { Tile, type TileMap } from "./map";
import type { MissionDef } from "./missions";

export type Kind =
  | "agent"
  | "guard"
  | "target"
  | "civilian"
  | "camera"
  | "turret"
  | "terminal"
  | "door"
  | "package";

export type AgentClass = "ghost" | "razor" | "decker" | "bruiser";

export type AlertState = "calm" | "suspicious" | "alarmed";

/** What the corp meta-game hands to a mission: one entry per deployed agent. */
export interface AgentLoadout {
  name: string;
  cls: AgentClass;
  /** Cosmetic skin id; "default" unless the player owns a skin entitlement. */
  skin: string;
  hp: number;
  speed: number;
  /** Multiplier on agent_weapon_damage. */
  damageMul?: number;
  /** Multiplier on guard detection time (higher = stealthier). */
  stealthMul?: number;
}

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
  cls?: AgentClass;
  skin?: string;
  damageMul?: number;
  stealthMul?: number;
  /** Ordered target: an enemy to attack, or a terminal/door/package to interact with. */
  attackId?: number;
  /** Package id this agent is carrying (research theft). */
  carrying?: number;
  /** Terminal/door id this agent hacked during the last tick. */
  hackingId?: number;
  // Guards / target / civilians
  patrol?: Vec[];
  patrolIdx?: number;
  repathIn?: number;
  detect?: number; // detection meter, seconds (guards and cameras)
  wait?: number; // seconds left idling at a patrol waypoint
  alert?: AlertState; // guards
  investigate?: Vec; // suspicious guards: last seen / noise position
  searchLeft?: number; // suspicious guards: seconds of searching left
  reinforcement?: boolean;
  home?: Vec; // civilians: wander centre
  panic?: number; // civilians: seconds until they reach a phone; undefined = calm
  reported?: boolean; // civilians: already raised (or no longer need to raise) the alarm
  // Mission objects
  role?: "data" | "security" | "prototype" | "scientist";
  progress?: number; // hack progress, seconds
  done?: boolean; // terminal hacked / door opened
  disabled?: boolean; // camera / turret shut down by a security terminal
  baseFacing?: number; // camera sweep centre
  sweepT?: number;
  carrierId?: number; // package: agent carrying it
  dropped?: boolean; // package: carrier went down
  staring?: boolean; // guard had an agent in view last tick
}

export interface Shot {
  from: Vec;
  to: Vec;
  ttl: number;
  hostile: boolean;
}

export type Outcome = "win" | "loss" | null;

/**
 * Things the presentation layer reacts to (sound, screen shake, HUD flashes).
 * The sim pushes; main.ts drains the queue once per frame.
 */
export type SimEvent =
  | { type: "shot"; from: Vec; hostile: boolean }
  | { type: "takedown"; at: Vec }
  | { type: "death"; id: number; kind: Kind }
  | { type: "detect"; guardId: number }
  | { type: "alarm" }
  /** A terminal or door hack completed. */
  | { type: "hack"; at: Vec; id?: number }
  /** Objective progress changed (terminal uplinked, package secured, target down). */
  | { type: "objective" }
  | { type: "outcome"; outcome: "win" | "loss" }
  | { type: "suspicious"; id: number; at: Vec }
  | { type: "noise"; at: Vec; radius: number }
  | { type: "reinforcements"; count: number; at: Vec }
  | { type: "disabled"; ids: number[] }
  | { type: "door"; id: number; at: Vec }
  | { type: "pickup"; id: number; at: Vec }
  | { type: "drop"; id: number; at: Vec }
  | { type: "panic"; id: number };

const DEFAULT_SQUAD: { name: string; cls: AgentClass }[] = [
  { name: "VIPER", cls: "razor" },
  { name: "GHOST", cls: "ghost" },
  { name: "HEX", cls: "decker" },
  { name: "BRICK", cls: "bruiser" },
  { name: "NOVA", cls: "ghost" },
  { name: "KATANA", cls: "razor" },
];

/** Squad used when no roster is supplied (offline play, tests). */
export function defaultLoadout(cfg: SettingsMap): AgentLoadout[] {
  return DEFAULT_SQUAD.slice(0, Number(cfg.squad_size)).map((a) => ({
    ...a,
    skin: "default",
    hp: Number(cfg.agent_hp),
    speed: Number(cfg.agent_speed),
  }));
}

/** Purely cosmetic beat for tracers. */
const SHOT_TTL = 0.12;
/** How often (s) a moving order re-plans toward a moving entity. */
const REPATH_AGENT = 0.4;
const REPATH_GUARD = 0.75;

const CIVILIAN_NAMES = ["CLERK", "ANALYST", "TECH", "COURIER", "INTERN", "SALARYMAN", "VENDOR", "JANITOR"];

const ORGANIC: ReadonlySet<Kind> = new Set(["guard", "target", "civilian"]);
const MECHANICAL: ReadonlySet<Kind> = new Set(["camera", "turret"]);
const INTERACTIVE: ReadonlySet<Kind> = new Set(["terminal", "door", "package"]);

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Sim {
  readonly map: TileMap;
  readonly entities: Entity[] = [];
  readonly shots: Shot[] = [];
  readonly mission: MissionDef;
  time = 0;
  alarm = false;
  /** Seconds since the alarm was raised. */
  alarmTime = 0;
  reinforcementWaves = 0;
  outcome: Outcome = null;
  outcomeReason = "";
  readonly events: SimEvent[] = [];
  private nextId = 1;
  private seed: number;
  private extracts: Vec[];

  constructor(
    mission: MissionDef,
    readonly cfg: SettingsMap,
    squad: AgentLoadout[] = defaultLoadout(cfg),
  ) {
    this.mission = mission;
    // Doors mutate tiles; keep the MissionDef pristine for redeploys.
    this.map = mission.map.clone();
    this.seed = hashSeed(mission.id);
    this.extracts = this.scanExtracts();
    const n = Math.min(Number(cfg.squad_size), squad.length, mission.agentSpawns.length);
    for (let i = 0; i < n; i++) {
      const l = squad[i]!;
      const e = this.spawn("agent", l.name, mission.agentSpawns[i]!, l.hp, l.speed);
      e.cls = l.cls;
      e.skin = l.skin;
      e.damageMul = l.damageMul ?? 1;
      e.stealthMul = l.stealthMul ?? 1;
    }
    mission.guards.forEach((g, i) => {
      const e = this.spawn("guard", `GUARD ${i + 1}`, g.patrol[0]!, Number(cfg.guard_hp), Number(cfg.guard_speed));
      e.patrol = g.patrol;
      e.patrolIdx = 0;
      e.detect = 0;
      e.alert = "calm";
    });
    if (mission.target) {
      const t = this.spawn("target", mission.target.name, mission.target.pos, Number(cfg.target_hp), Number(cfg.target_speed));
      t.patrol = mission.target.patrol;
      t.patrolIdx = 0;
    }
    const civs = mission.civilianSpawns.length ? Number(cfg.civilian_count) : 0;
    for (let i = 0; i < civs; i++) {
      const home = mission.civilianSpawns[i % mission.civilianSpawns.length]!;
      const name = CIVILIAN_NAMES[i % CIVILIAN_NAMES.length]!;
      const c = this.spawn("civilian", name, home, Number(cfg.civilian_hp), Number(cfg.civilian_speed));
      c.home = { ...home };
      c.wait = this.rand() * Number(cfg.guard_wait_time);
      c.facing = this.rand() * Math.PI * 2;
    }
    for (const o of mission.objects) {
      switch (o.kind) {
        case "camera": {
          const c = this.spawn("camera", "CAMERA", o.pos, Number(cfg.camera_hp), 0);
          c.baseFacing = c.facing = o.facing ?? 0;
          c.sweepT = this.rand() * 10;
          c.detect = 0;
          break;
        }
        case "turret": {
          const t = this.spawn("turret", "TURRET", o.pos, Number(cfg.turret_hp), 0);
          t.facing = o.facing ?? 0;
          break;
        }
        case "terminal": {
          const t = this.spawn("terminal", o.role === "security" ? "SECURITY NODE" : "DATA TERMINAL", o.pos, 1, 0);
          t.role = o.role;
          t.progress = 0;
          break;
        }
        case "door": {
          const d = this.spawn("door", "LOCKED DOOR", o.pos, 1, 0);
          d.progress = 0;
          break;
        }
        case "package": {
          const p = this.spawn("package", mission.packageName, o.pos, 1, 0);
          p.role = o.role;
          break;
        }
      }
    }
  }

  private spawn(kind: Kind, name: string, pos: Vec, hp: number, speed: number): Entity {
    const e: Entity = { id: this.nextId++, kind, name, pos: { ...pos }, facing: 0, hp, maxHp: hp, speed, path: [], cooldown: 0 };
    this.entities.push(e);
    return e;
  }

  /** Deterministic PRNG (mulberry32) seeded from the mission id. */
  private rand(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // --- Queries --------------------------------------------------------------

  get agents() {
    return this.entities.filter((e) => e.kind === "agent" && e.hp > 0);
  }
  /** Living enemies: guards, the VIP, and active cameras/turrets. */
  get hostiles() {
    return this.entities.filter(
      (e) => e.hp > 0 && (e.kind === "guard" || e.kind === "target" || (MECHANICAL.has(e.kind) && !e.disabled)),
    );
  }
  /** Things agents shoot at on their own once things are loud. */
  private get threats() {
    return this.entities.filter((e) => e.hp > 0 && (e.kind === "guard" || e.kind === "target" || (e.kind === "turret" && !e.disabled)));
  }
  get civilians() {
    return this.entities.filter((e) => e.kind === "civilian" && e.hp > 0);
  }
  /** Espionage objectives. */
  get dataTerminals() {
    return this.entities.filter((e) => e.kind === "terminal" && e.role === "data");
  }
  /** Research objective (first package), if any. */
  get package(): Entity | undefined {
    return this.entities.find((e) => e.kind === "package");
  }
  /**
   * The mission's focal entity: the VIP for assassinations, otherwise the
   * package or the next data terminal. Never undefined.
   */
  get target(): Entity {
    return (
      this.entities.find((e) => e.kind === "target") ??
      this.package ??
      this.dataTerminals.find((t) => !t.done) ??
      this.dataTerminals[0] ??
      this.entities[0]!
    );
  }
  byId(id: number) {
    return this.entities.find((e) => e.id === id);
  }
  /** Can this entity be right-clicked to move-to-and-interact? */
  isInteractive(e: Entity): boolean {
    if (!INTERACTIVE.has(e.kind)) return false;
    if (e.kind === "package") return e.carrierId === undefined;
    return !e.done;
  }
  /** Overall alert level for the HUD. */
  alertState(): AlertState {
    if (this.alarm) return "alarmed";
    const uneasy = this.entities.some(
      (e) => e.hp > 0 && ((e.kind === "guard" && (e.alert === "suspicious" || (e.detect ?? 0) > 0)) || (e.kind === "civilian" && e.panic !== undefined) || (e.kind === "camera" && (e.detect ?? 0) > 0)),
    );
    return uneasy ? "suspicious" : "calm";
  }
  /** Seconds of hacking a terminal/door needs (before class/alarm modifiers). */
  hackDuration(e: Entity): number {
    return Number(e.kind === "door" ? this.cfg.door_hack_time : this.cfg.hack_time) * (this.alarm && e.kind === "terminal" ? Number(this.cfg.alarm_hack_mul) : 1);
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

  /**
   * Attack an enemy, or, for a terminal / door / package, walk over and
   * hack it or pick it up. Right-clicking any non-agent entity lands here.
   */
  orderAttack(ids: number[], targetId: number): void {
    const t = this.byId(targetId);
    // An opened door / hacked terminal / carried package is just a place to walk to.
    if (t && INTERACTIVE.has(t.kind) && !this.isInteractive(t)) return this.orderMove(ids, t.pos);
    for (const id of ids) {
      const e = this.byId(id);
      if (e && e.hp > 0 && e.kind === "agent") {
        e.attackId = targetId;
        e.path = [];
        e.repathIn = 0;
      }
    }
  }

  /** Explicit alias of orderAttack for interactive objects. */
  orderInteract(ids: number[], objectId: number): void {
    this.orderAttack(ids, objectId);
  }

  /** Nearest walkable tiles around dest so a squad doesn't stack on one tile. */
  private formationSlots(dest: Vec, n: number): Vec[] {
    const cx = Math.floor(dest.x);
    const cy = Math.floor(dest.y);
    // Ordering a squad into the extraction zone fills the zone first.
    const preferExtract = this.map.get(cx, cy) === Tile.Extract;
    const out: Vec[] = [];
    for (const pass of preferExtract ? [true, false] : [false]) {
      for (let r = 0; r <= 3 && out.length < n; r++) {
        for (let dy = -r; dy <= r && out.length < n; dy++) {
          for (let dx = -r; dx <= r && out.length < n; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (!this.map.walkable(x, y)) continue;
            const isExtract = this.map.get(x, y) === Tile.Extract;
            if (preferExtract && pass !== isExtract) continue;
            out.push({ x: x + 0.5, y: y + 0.5 });
          }
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
      switch (e.kind) {
        case "agent": this.updateAgent(e, dt); break;
        case "guard": this.updateGuard(e, dt); break;
        case "target": this.updateTarget(e, dt); break;
        case "civilian": this.updateCivilian(e, dt); break;
        case "camera": this.updateCamera(e, dt); break;
        case "turret": this.updateTurret(e, dt); break;
        default: break;
      }
    }
    this.updatePackages();
    this.updateReinforcements(dt);
    this.checkOutcome();
  }

  private step(e: Entity, dt: number): void {
    let speed = e.speed;
    if (e.carrying !== undefined) speed *= Number(this.cfg.carry_speed_mul);
    if (e.kind === "civilian" && e.panic !== undefined) speed *= Number(this.cfg.civilian_panic_mul);
    let budget = speed * dt;
    while (budget > 0 && e.path.length) {
      const next = e.path[0]!;
      const d = dist(e.pos, next);
      if (d > 1e-6) e.facing = Math.atan2(next.y - e.pos.y, next.x - e.pos.x);
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

  raiseAlarm(): void {
    if (this.alarm) return;
    this.alarm = true;
    this.events.push({ type: "alarm" });
    for (const e of this.entities) {
      if (e.hp <= 0) continue;
      if (e.kind === "guard") {
        e.alert = "alarmed";
        e.path = [];
        e.repathIn = 0;
      } else if (e.kind === "civilian" && e.panic === undefined) {
        // Everyone already knows; civilians just run.
        this.panicCivilian(e, null);
        e.reported = true;
      }
    }
  }

  /** Short HUD line describing what the player should do next. */
  objectiveText(): string {
    const extract = "EXTRACT ALL AGENTS (GREEN ZONE)";
    switch (this.mission.type) {
      case "espionage": {
        const terms = this.dataTerminals;
        const done = terms.filter((t) => t.done).length;
        if (done < terms.length) {
          const active = terms.find((t) => !t.done && (t.progress ?? 0) > 0 && this.agents.some((a) => a.hackingId === t.id));
          const pct = active ? ` · UPLINK ${Math.floor((100 * (active.progress ?? 0)) / this.hackDuration(active))}%` : "";
          return `HACK DATA TERMINALS ${done}/${terms.length}${pct}`;
        }
        return `DATA UPLINKED. ${extract}`;
      }
      case "research": {
        const p = this.package;
        if (!p) return extract;
        if (p.carrierId !== undefined) return `${p.name} SECURED. CARRY TO EXTRACTION (GREEN ZONE)`;
        return p.dropped ? `${p.name} DROPPED. RECOVER IT` : `SECURE ${p.name}`;
      }
      default: {
        const t = this.entities.find((e) => e.kind === "target");
        if (!t) return extract;
        return t.hp > 0 ? `ELIMINATE ${t.name}` : `TARGET DOWN. ${extract}`;
      }
    }
  }

  private end(outcome: "win" | "loss", reason: string): void {
    this.outcome = outcome;
    this.outcomeReason = reason;
    this.events.push({ type: "outcome", outcome });
  }

  canSee(a: Vec, b: Vec, range: number): boolean {
    return dist(a, b) <= range && this.map.lineOfSight(a, b);
  }

  private fire(from: Entity, to: Entity, damage: number, cooldown: number, hostile: boolean): void {
    from.facing = Math.atan2(to.pos.y - from.pos.y, to.pos.x - from.pos.x);
    from.cooldown = cooldown;
    this.shots.push({ from: { ...from.pos }, to: { ...to.pos }, ttl: SHOT_TTL, hostile });
    this.events.push({ type: "shot", from: { ...from.pos }, hostile });
    const wasAlive = to.hp > 0;
    to.hp = Math.max(0, to.hp - damage);
    if (wasAlive && to.hp === 0) {
      this.events.push({ type: "death", id: to.id, kind: to.kind });
      if (to.kind === "target") this.events.push({ type: "objective" });
    }
    // A wounded guard calls it in; everything else just makes noise.
    if (to.kind === "guard" && to.hp > 0) this.raiseAlarm();
    this.noise(from.pos);
  }

  /** Gunfire: calm guards nearby investigate, civilians nearby panic. */
  noise(at: Vec): void {
    const radius = Number(this.cfg.noise_radius);
    this.events.push({ type: "noise", at: { ...at }, radius });
    if (this.alarm) return;
    for (const e of this.entities) {
      if (e.hp <= 0 || dist(e.pos, at) > radius) continue;
      if (e.kind === "guard") this.makeSuspicious(e, at);
      else if (e.kind === "civilian" && e.panic === undefined) this.panicCivilian(e, at);
    }
  }

  private makeSuspicious(g: Entity, at: Vec): void {
    if (this.alarm) return;
    if (g.alert !== "suspicious") this.events.push({ type: "suspicious", id: g.id, at: { ...at } });
    g.alert = "suspicious";
    g.investigate = { ...at };
    g.searchLeft = Number(this.cfg.suspicious_search_time);
    g.path = this.map.findPath(g.pos, at, !this.map.walkable(Math.floor(at.x), Math.floor(at.y))) ?? [];
  }

  // --- Agents ---------------------------------------------------------------

  private updateAgent(e: Entity, dt: number): void {
    e.hackingId = undefined;
    const range = Number(this.cfg.agent_weapon_range);
    let ordered = e.attackId !== undefined ? this.byId(e.attackId) : undefined;
    if (ordered && (ordered.hp <= 0 || (INTERACTIVE.has(ordered.kind) && !this.isInteractive(ordered)))) {
      e.attackId = undefined;
      ordered = undefined;
    }

    if (ordered && INTERACTIVE.has(ordered.kind)) {
      this.interact(e, ordered, dt);
    } else if (ordered) {
      const d = dist(e.pos, ordered.pos);
      // Silent takedown: reach an unaware organic target in melee range.
      if (!this.alarm && ORGANIC.has(ordered.kind) && d <= Number(this.cfg.melee_range)) {
        ordered.hp = 0;
        this.events.push({ type: "takedown", at: { ...ordered.pos } });
        this.events.push({ type: "death", id: ordered.id, kind: ordered.kind });
        if (ordered.kind === "target") this.events.push({ type: "objective" });
        e.attackId = undefined;
        e.path = [];
        return;
      }
      // Cameras and turrets can't be choked out: shoot them (loud, but not an alarm).
      if ((this.alarm || MECHANICAL.has(ordered.kind)) && this.canSee(e.pos, ordered.pos, range)) {
        e.path = [];
        if (e.cooldown === 0) this.fire(e, ordered, Number(this.cfg.agent_weapon_damage) * (e.damageMul ?? 1), Number(this.cfg.agent_fire_cooldown), false);
        return;
      }
      this.approach(e, ordered, dt);
    } else if (this.alarm && e.cooldown === 0) {
      // Return fire at the nearest visible threat once things are loud.
      const tgt = this.nearestVisible(e, this.threats, range);
      if (tgt) this.fire(e, tgt, Number(this.cfg.agent_weapon_damage) * (e.damageMul ?? 1), Number(this.cfg.agent_fire_cooldown), false);
    }
    this.step(e, dt);
  }

  /** Re-plan toward a (possibly moving, possibly unwalkable) entity. */
  private approach(e: Entity, to: Entity, dt: number): void {
    e.repathIn = (e.repathIn ?? 0) - dt;
    if (!e.path.length || e.repathIn <= 0) {
      e.repathIn = REPATH_AGENT;
      e.path = this.map.findPath(e.pos, to.pos, true) ?? [];
      // Already on a touching tile but stopped off-centre: settle onto the centre.
      if (!e.path.length) e.path = [{ x: Math.floor(e.pos.x) + 0.5, y: Math.floor(e.pos.y) + 0.5 }];
    }
  }

  private interact(e: Entity, o: Entity, dt: number): void {
    const inRange = dist(e.pos, o.pos) <= Number(this.cfg.hack_range);
    if (!inRange) {
      this.approach(e, o, dt);
      return;
    }
    e.path = [];
    e.facing = Math.atan2(o.pos.y - e.pos.y, o.pos.x - e.pos.x);
    if (o.kind === "package") {
      if (e.carrying !== undefined) return;
      o.carrierId = e.id;
      o.dropped = false;
      e.carrying = o.id;
      e.attackId = undefined;
      this.events.push({ type: "pickup", id: o.id, at: { ...o.pos } });
      this.events.push({ type: "objective" });
      return;
    }
    e.hackingId = o.id;
    const mul = e.cls === "decker" ? Number(this.cfg.decker_hack_mul) : 1;
    o.progress = (o.progress ?? 0) + dt * mul;
    if (o.progress < this.hackDuration(o)) return;
    o.done = true;
    e.attackId = undefined;
    e.hackingId = undefined;
    this.events.push({ type: "hack", at: { ...o.pos }, id: o.id });
    if (o.kind === "door") {
      this.map.set(Math.floor(o.pos.x), Math.floor(o.pos.y), Tile.Floor);
      this.events.push({ type: "door", id: o.id, at: { ...o.pos } });
    } else if (o.role === "security") {
      const r = Number(this.cfg.security_hack_radius);
      const ids: number[] = [];
      for (const x of this.entities) {
        if (MECHANICAL.has(x.kind) && x.hp > 0 && !x.disabled && dist(x.pos, o.pos) <= r) {
          x.disabled = true;
          x.detect = 0;
          ids.push(x.id);
        }
      }
      this.events.push({ type: "disabled", ids });
    } else {
      this.events.push({ type: "objective" });
    }
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

  // --- Vision ---------------------------------------------------------------

  /** Vision range (tiles) and half field-of-view (radians) for a watcher. */
  visionParams(e: Entity): { range: number; half: number } {
    const deg = (d: unknown) => (Number(d) * Math.PI) / 360;
    switch (e.kind) {
      case "camera":
        return { range: Number(this.cfg.camera_vision_range), half: deg(this.cfg.camera_fov) };
      case "civilian":
        return { range: Number(this.cfg.civilian_vision_range), half: deg(this.cfg.guard_vision_fov) };
      default:
        return { range: Number(this.cfg.guard_vision_range), half: deg(this.cfg.guard_vision_fov) };
    }
  }

  inVisionCone(g: Entity, p: Vec): boolean {
    const { range, half } = this.visionParams(g);
    if (dist(g.pos, p) > range) return false;
    let a = Math.atan2(p.y - g.pos.y, p.x - g.pos.x) - g.facing;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    return Math.abs(a) <= half && this.map.lineOfSight(g.pos, p);
  }

  /** A body (dead guard, VIP or civilian) inside the watcher's cone. */
  private seesBody(w: Entity): Entity | undefined {
    return this.entities.find((e) => e.hp <= 0 && ORGANIC.has(e.kind) && this.inVisionCone(w, e.pos));
  }

  /** Fill a watcher's detection meter from agents in its cone. Returns the nearest seen agent. */
  private watch(w: Entity, dt: number, threshold: number, mul = 1): Entity | undefined {
    const seen = this.agents.filter((a) => this.inVisionCone(w, a.pos));
    const before = w.detect ?? 0;
    if (!seen.length) {
      w.detect = Math.max(0, before - dt * Number(this.cfg.detection_decay));
      return undefined;
    }
    // Stealthier agents fill the meter more slowly.
    const rate = Math.max(...seen.map((a) => 1 / (a.stealthMul ?? 1))) * mul;
    w.detect = before + dt * rate;
    if (before === 0) this.events.push({ type: "detect", guardId: w.id });
    if (w.detect >= threshold) this.raiseAlarm();
    let nearest = seen[0]!;
    for (const a of seen) if (dist(w.pos, a.pos) < dist(w.pos, nearest.pos)) nearest = a;
    return nearest;
  }

  // --- Guards ---------------------------------------------------------------

  private updateGuard(g: Entity, dt: number): void {
    if (!this.alarm) {
      const suspicious = g.alert === "suspicious";
      const seen = this.watch(g, dt, Number(this.cfg.detection_time), suspicious ? Number(this.cfg.suspicious_detect_mul) : 1);
      if (this.seesBody(g)) this.raiseAlarm();
      if (this.alarm) return;
      if (seen) {
        // Stop and stare while the meter fills.
        g.investigate = { ...seen.pos };
        g.staring = true;
        g.path = [];
        g.facing = Math.atan2(seen.pos.y - g.pos.y, seen.pos.x - g.pos.x);
        return;
      }
      if (g.staring && g.investigate) {
        // Lost sight of something: go and look where it was.
        g.staring = false;
        this.makeSuspicious(g, g.investigate);
      }
      if (g.alert === "suspicious") {
        if (g.path.length) {
          this.step(g, dt);
          return;
        }
        g.facing += dt * Number(this.cfg.guard_look_speed);
        g.searchLeft = (g.searchLeft ?? 0) - dt;
        if (g.searchLeft <= 0) {
          g.alert = "calm";
          g.investigate = undefined;
        }
        return;
      }
      this.patrol(g, dt);
      return;
    }
    const tgt = this.nearestVisible(g, this.agents, Number(this.cfg.guard_vision_range));
    if (tgt) {
      g.path = [];
      g.facing = Math.atan2(tgt.pos.y - g.pos.y, tgt.pos.x - g.pos.x);
      if (g.cooldown === 0) this.fire(g, tgt, Number(this.cfg.guard_damage), Number(this.cfg.guard_fire_cooldown), true);
      return;
    }
    g.repathIn = (g.repathIn ?? 0) - dt;
    if (g.repathIn <= 0) {
      g.repathIn = REPATH_GUARD;
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
        e.facing += dt * Number(this.cfg.guard_look_speed);
      } else {
        const wp = e.patrol[e.patrolIdx ?? 0]!;
        if (dist(e.pos, wp) < 0.1) {
          e.patrolIdx = ((e.patrolIdx ?? 0) + 1) % e.patrol.length;
          e.wait = Number(this.cfg.guard_wait_time);
        } else {
          e.path = this.map.findPath(e.pos, wp) ?? [];
          // Unreachable waypoint (e.g. behind a door): skip it.
          if (!e.path.length) e.patrolIdx = ((e.patrolIdx ?? 0) + 1) % e.patrol.length;
        }
      }
    }
    this.step(e, dt);
  }

  private updateTarget(t: Entity, dt: number): void {
    if (this.alarm) {
      // Panic: run for the nearest extraction tile.
      if (!t.path.length) {
        let best: Vec | undefined;
        for (const x of this.extracts) if (!best || dist(t.pos, x) < dist(t.pos, best)) best = x;
        if (best) t.path = this.map.findPath(t.pos, best) ?? [];
      }
      this.step(t, dt);
      return;
    }
    this.patrol(t, dt);
  }

  // --- Civilians ------------------------------------------------------------

  private updateCivilian(c: Entity, dt: number): void {
    if (c.panic === undefined) {
      const body = this.seesBody(c);
      if (body) this.panicCivilian(c, body.pos);
    }
    if (c.panic !== undefined) {
      if (!c.reported) {
        c.panic -= dt;
        if (c.panic <= 0) {
          c.reported = true;
          this.raiseAlarm();
        }
      }
      this.step(c, dt);
      return;
    }
    // Wander around home.
    if (!c.path.length) {
      if ((c.wait ?? 0) > 0) {
        c.wait! -= dt;
      } else {
        const r = Number(this.cfg.civilian_wander_radius);
        const home = c.home ?? c.pos;
        for (let tries = 0; tries < 8 && !c.path.length; tries++) {
          const x = Math.floor(home.x + (this.rand() * 2 - 1) * r);
          const y = Math.floor(home.y + (this.rand() * 2 - 1) * r);
          if (this.map.walkable(x, y)) c.path = this.map.findPath(c.pos, { x: x + 0.5, y: y + 0.5 }) ?? [];
        }
        c.wait = Number(this.cfg.guard_wait_time) * (0.5 + this.rand() * 1.5);
      }
    }
    this.step(c, dt);
  }

  /** A civilian saw a body or heard gunfire: flee and (after a delay) call security. */
  private panicCivilian(c: Entity, threat: Vec | null): void {
    c.panic = Number(this.cfg.civilian_alarm_delay);
    this.events.push({ type: "panic", id: c.id });
    const from = threat ?? c.pos;
    const candidates: Vec[] = [...this.mission.reinforcementSpawns];
    for (let i = 0; i < 12; i++) {
      const x = Math.floor(this.rand() * this.map.width);
      const y = Math.floor(this.rand() * this.map.height);
      if (this.map.walkable(x, y)) candidates.push({ x: x + 0.5, y: y + 0.5 });
    }
    candidates.sort((a, b) => dist(b, from) - dist(a, from));
    for (const p of candidates) {
      const path = this.map.findPath(c.pos, p);
      if (path) {
        c.path = path;
        return;
      }
    }
    c.path = [];
  }

  // --- Cameras & turrets ----------------------------------------------------

  private updateCamera(c: Entity, dt: number): void {
    if (c.disabled) return;
    c.sweepT = (c.sweepT ?? 0) + dt;
    const amp = (Number(this.cfg.camera_sweep) * Math.PI) / 360;
    const speed = (Number(this.cfg.camera_rotation_speed) * Math.PI) / 180;
    c.facing = (c.baseFacing ?? 0) + (amp > 0 && speed > 0 ? amp * Math.sin((c.sweepT * speed) / amp) : 0);
    if (this.alarm) return;
    this.watch(c, dt, Number(this.cfg.camera_detection_time));
    if (this.seesBody(c)) this.raiseAlarm();
  }

  private updateTurret(t: Entity, dt: number): void {
    if (t.disabled || !this.alarm) return;
    const tgt = this.nearestVisible(t, this.agents, Number(this.cfg.turret_range));
    if (!tgt) {
      t.facing += dt * Number(this.cfg.guard_look_speed);
      return;
    }
    if (t.cooldown === 0) this.fire(t, tgt, Number(this.cfg.turret_damage), Number(this.cfg.turret_fire_cooldown), true);
    else t.facing = Math.atan2(tgt.pos.y - t.pos.y, tgt.pos.x - t.pos.x);
  }

  // --- Packages & reinforcements -------------------------------------------

  private updatePackages(): void {
    for (const p of this.entities) {
      if (p.kind !== "package" || p.carrierId === undefined) continue;
      const c = this.byId(p.carrierId);
      if (c && c.hp > 0) {
        p.pos = { ...c.pos };
        p.facing = c.facing;
        continue;
      }
      // Carrier down: the package drops where they fell.
      if (c) c.carrying = undefined;
      p.carrierId = undefined;
      p.dropped = true;
      const drop = this.formationSlots(p.pos, 1)[0] ?? p.pos;
      p.pos = { ...drop };
      this.events.push({ type: "drop", id: p.id, at: { ...p.pos } });
      this.events.push({ type: "objective" });
    }
  }

  private updateReinforcements(dt: number): void {
    if (!this.alarm) return;
    this.alarmTime += dt;
    const spawns = this.mission.reinforcementSpawns;
    const count = Number(this.cfg.reinforcement_count);
    if (!spawns.length || count <= 0) return;
    const delay = Number(this.cfg.reinforcement_delay);
    while (this.reinforcementWaves < Number(this.cfg.reinforcement_waves) && this.alarmTime >= delay * (this.reinforcementWaves + 1)) {
      const at = spawns[this.reinforcementWaves % spawns.length]!;
      const slots = this.formationSlots(at, count);
      for (let i = 0; i < count; i++) {
        const p = slots[i % Math.max(1, slots.length)] ?? at;
        const g = this.spawn("guard", `RESPONSE ${this.reinforcementWaves + 1}-${i + 1}`, p, Number(this.cfg.guard_hp), Number(this.cfg.guard_speed));
        g.patrol = [{ ...p }];
        g.patrolIdx = 0;
        g.detect = 0;
        g.alert = "alarmed";
        g.reinforcement = true;
      }
      this.reinforcementWaves++;
      this.events.push({ type: "reinforcements", count, at: { ...at } });
    }
  }

  // --- Outcome --------------------------------------------------------------

  private scanExtracts(): Vec[] {
    const out: Vec[] = [];
    for (let y = 0; y < this.map.height; y++)
      for (let x = 0; x < this.map.width; x++) if (this.map.get(x, y) === Tile.Extract) out.push({ x: x + 0.5, y: y + 0.5 });
    return out;
  }

  extractTiles(): Vec[] {
    return this.extracts.map((p) => ({ ...p }));
  }

  private onExtract(e: Entity): boolean {
    return this.map.get(Math.floor(e.pos.x), Math.floor(e.pos.y)) === Tile.Extract;
  }

  private checkOutcome(): void {
    const agents = this.agents;
    if (!agents.length) return this.end("loss", "Your squad was eliminated.");
    const extracted = agents.every((a) => this.onExtract(a));
    switch (this.mission.type) {
      case "espionage": {
        const terms = this.dataTerminals;
        if (terms.length && terms.every((t) => t.done) && extracted) this.end("win", "Data uplinked and squad extracted.");
        return;
      }
      case "research": {
        const p = this.package;
        const carrier = p?.carrierId !== undefined ? this.byId(p.carrierId) : undefined;
        if (p && carrier && carrier.hp > 0 && extracted) this.end("win", `${p.name} extracted.`);
        return;
      }
      default: {
        const t = this.entities.find((e) => e.kind === "target");
        if (!t) return;
        // The target escaping through the extraction point is a failure.
        if (t.hp > 0 && this.onExtract(t)) return this.end("loss", "The target escaped.");
        if (t.hp <= 0 && extracted) this.end("win", "Target eliminated and squad extracted.");
      }
    }
  }
}
