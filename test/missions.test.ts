import { describe, expect, it } from "vitest";
import { defaultSettings, MISSION_TYPES, type SettingsMap } from "../shared/settings";
import { dist, type Vec } from "../src/game/iso";
import { Tile, type TileMap } from "../src/game/map";
import { loadMission, MISSION_SOURCES } from "../src/game/missions";
import { Sim, type Entity } from "../src/game/sim";

const DT = 1 / 30;
function tick(sim: Sim, seconds: number, until?: () => boolean) {
  for (let t = 0; t < seconds; t += DT) {
    sim.update(DT);
    if (until?.()) return;
  }
}

/** Guards, cameras and civilians can't see anything; nobody wanders. */
function quiet(extra: SettingsMap = {}): SettingsMap {
  return { ...defaultSettings(), guard_vision_range: 0.01, camera_vision_range: 0.01, civilian_count: 0, ...extra };
}

/** Tiles reachable from spawn when every locked door can be hacked open. */
function reachable(map: TileMap, from: Vec): Set<number> {
  const W = map.width;
  const ok = (x: number, y: number) => map.walkable(x, y) || map.get(x, y) === Tile.Door;
  const start = Math.floor(from.y) * W + Math.floor(from.x);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const c = queue.pop()!;
    const cx = c % W;
    const cy = Math.floor(c / W);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!ok(nx, ny) || (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy)))) continue;
        const n = ny * W + nx;
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
  }
  return seen;
}

describe("mission content", () => {
  it("has at least six missions, two of each type, sized 24-40 tiles", () => {
    expect(MISSION_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const type of MISSION_TYPES) expect(MISSION_SOURCES.filter((m) => m.type === type).length).toBeGreaterThanOrEqual(2);
    for (const src of MISSION_SOURCES) {
      const m = loadMission(src.id);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.brief.length).toBeGreaterThan(40);
      expect(Math.max(m.map.width, m.map.height)).toBeGreaterThanOrEqual(24);
      expect(Math.max(m.map.width, m.map.height)).toBeLessThanOrEqual(40);
      expect(m.reinforcementSpawns.length).toBeGreaterThan(0);
    }
  });

  for (const src of MISSION_SOURCES) {
    it(`${src.id}: every objective, object and extraction tile is reachable from spawn`, () => {
      const m = loadMission(src.id);
      const W = m.map.width;
      const seen = reachable(m.map, m.agentSpawns[0]!);
      const at = (p: Vec) => seen.has(Math.floor(p.y) * W + Math.floor(p.x));
      const touchable = (p: Vec) => {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at({ x: p.x + dx, y: p.y + dy })) return true;
        return false;
      };
      for (const s of m.agentSpawns) expect(at(s)).toBe(true);
      const extracts = new Sim(m, defaultSettings()).extractTiles();
      expect(extracts.length).toBeGreaterThanOrEqual(4);
      for (const e of extracts) expect(at(e)).toBe(true);
      for (const o of m.objects) expect(o.kind === "package" ? at(o.pos) : touchable(o.pos), `${o.kind} at ${o.pos.x},${o.pos.y}`).toBe(true);
      for (const g of m.guards) for (const wp of g.patrol) expect(at(wp)).toBe(true);
      for (const r of m.reinforcementSpawns) expect(at(r)).toBe(true);
      for (const c of m.civilianSpawns) expect(at(c)).toBe(true);
      if (m.type === "assassination") {
        expect(m.target).toBeDefined();
        expect(at(m.target!.pos)).toBe(true);
      } else if (m.type === "espionage") {
        expect(m.objects.filter((o) => o.kind === "terminal" && o.role === "data").length).toBeGreaterThanOrEqual(2);
      } else {
        expect(m.objects.filter((o) => o.kind === "package").length).toBe(1);
      }
    });

    it(`${src.id}: the squad is not spotted while idling at spawn`, () => {
      const sim = new Sim(loadMission(src.id), defaultSettings());
      tick(sim, 8);
      expect(sim.alarm).toBe(false);
      const spotted = sim.events.filter((e) => e.type === "detect");
      expect(spotted).toEqual([]);
    });

    it(`${src.id}: simulates a minute without errors and gives objective text`, () => {
      const sim = new Sim(loadMission(src.id), defaultSettings());
      expect(sim.objectiveText().length).toBeGreaterThan(0);
      expect(sim.target).toBeDefined();
      tick(sim, 60);
      sim.raiseAlarm();
      tick(sim, 40);
      expect(sim.objectiveText().length).toBeGreaterThan(0);
    });
  }
});

/** Hack every reachable door, then every data terminal, via the orderAttack (right-click) path. */
function hackAll(sim: Sim, agent: Entity) {
  for (let guard = 0; guard < 40; guard++) {
    const pending = sim.dataTerminals.filter((t) => !t.done);
    if (!pending.length) return;
    const next =
      pending.find((t) => sim.map.findPath(agent.pos, t.pos, true)) ??
      sim.entities.find((d) => d.kind === "door" && !d.done && sim.map.findPath(agent.pos, d.pos, true));
    if (!next) throw new Error("stuck: nothing reachable to hack");
    sim.orderAttack([agent.id], next.id);
    tick(sim, 60, () => !!next.done);
    expect(next.done).toBe(true);
  }
}

function extractAll(sim: Sim) {
  const ex = sim.extractTiles();
  sim.orderMove(
    sim.agents.map((a) => a.id),
    ex[0]!,
  );
  tick(sim, 90, () => !!sim.outcome);
}

describe("espionage", () => {
  it("hacking every data terminal and extracting wins the mission", () => {
    const sim = new Sim(loadMission("kowloon-vault-02"), quiet());
    expect(sim.objectiveText()).toMatch(/HACK DATA TERMINALS 0\/3/);
    const hacker = sim.agents.find((a) => a.cls === "decker")!;
    hackAll(sim, hacker);
    expect(sim.events.some((e) => e.type === "hack")).toBe(true);
    expect(sim.objectiveText()).toMatch(/UPLINKED/);
    expect(sim.outcome).toBeNull();
    extractAll(sim);
    expect(sim.outcome).toBe("win");
    expect(sim.alarm).toBe(false);
  });

  it("hack progress needs the agent to stay adjacent, and deckers hack faster", () => {
    const cfg = quiet({ hack_time: 4, decker_hack_mul: 2 });
    const sim = new Sim(loadMission("uplink-relay-05"), cfg);
    const term = sim.dataTerminals[0]!;
    const [a, b] = [sim.agents.find((x) => x.cls !== "decker")!, sim.agents.find((x) => x.cls === "decker")!];
    const spot = sim.map.findPath(a.pos, term.pos, true)!.at(-1)!;
    a.pos = { ...spot };
    sim.orderAttack([a.id], term.id);
    tick(sim, 1);
    expect(term.progress).toBeGreaterThan(0.8);
    expect(term.done).toBeFalsy();
    sim.orderMove([a.id], sim.mission.agentSpawns[0]!);
    const p = term.progress!;
    tick(sim, 1);
    expect(term.progress).toBe(p);
    b.pos = { ...spot };
    sim.orderAttack([b.id], term.id);
    tick(sim, (4 - p) / 2 + 0.2);
    expect(term.done).toBe(true);
  });

  it("locked doors block movement and sight until hacked", () => {
    const sim = new Sim(loadMission("kowloon-vault-02"), quiet());
    const door = sim.entities.find((e) => e.kind === "door")!;
    const tx = Math.floor(door.pos.x);
    const ty = Math.floor(door.pos.y);
    expect(sim.map.walkable(tx, ty)).toBe(false);
    expect(sim.map.blocksSight(tx, ty)).toBe(true);
    sim.orderAttack([sim.agents[0]!.id], door.id);
    tick(sim, 60, () => !!door.done);
    expect(door.done).toBe(true);
    expect(sim.map.walkable(tx, ty)).toBe(true);
    // The MissionDef map is untouched, so redeploys start locked again.
    expect(sim.mission.map.walkable(tx, ty)).toBe(false);
  });
});

describe("research theft", () => {
  it("picking up the package slows the carrier; carrying it out wins", () => {
    const sim = new Sim(loadMission("helix-labs-03"), quiet({ carry_speed_mul: 0.5 }));
    const pkg = sim.package!;
    const [carrier, other] = sim.agents;
    // Stage both agents on the open south concourse.
    pkg.pos = { x: 10.5, y: 18.5 };
    carrier!.pos = { x: 9.5, y: 18.5 };
    other!.pos = { x: 9.5, y: 19.5 };
    sim.orderAttack([carrier!.id], pkg.id);
    tick(sim, 0.2);
    expect(carrier!.carrying).toBe(pkg.id);
    expect(pkg.carrierId).toBe(carrier!.id);
    expect(sim.objectiveText()).toMatch(/SECURED/);
    const x0 = carrier!.pos.x;
    const y0 = other!.pos.x;
    sim.orderMove([carrier!.id], { x: 25.5, y: 18.5 });
    sim.orderMove([other!.id], { x: 25.5, y: 19.5 });
    tick(sim, 1);
    const carried = carrier!.pos.x - x0;
    const free = other!.pos.x - y0;
    expect(carried).toBeGreaterThan(0);
    expect(carried / free).toBeCloseTo(0.5, 1);
    expect(dist(pkg.pos, carrier!.pos)).toBe(0);
    extractAll(sim);
    expect(sim.outcome).toBe("win");
  });

  it("the package drops when its carrier dies and can be picked up again", () => {
    const sim = new Sim(loadMission("cryo-ward-06"), quiet());
    const pkg = sim.package!;
    const [carrier, other] = sim.agents;
    carrier!.pos = { ...pkg.pos };
    sim.orderAttack([carrier!.id], pkg.id);
    tick(sim, 0.1);
    expect(pkg.carrierId).toBe(carrier!.id);
    carrier!.hp = 0;
    tick(sim, 0.1);
    expect(pkg.carrierId).toBeUndefined();
    expect(sim.objectiveText()).toMatch(/DROPPED/);
    expect(sim.events.some((e) => e.type === "drop")).toBe(true);
    other!.pos = { x: pkg.pos.x + 1, y: pkg.pos.y };
    sim.orderAttack([other!.id], pkg.id);
    tick(sim, 3, () => pkg.carrierId !== undefined);
    expect(pkg.carrierId).toBe(other!.id);
  });
});

/** Camera with a frozen sweep and an agent parked a few tiles down its view line. */
function cameraSetup(extra: SettingsMap = {}) {
  const sim = new Sim(loadMission("neon-tower-01"), { ...quiet(), camera_vision_range: 7, camera_sweep: 0, ...extra });
  const cam = sim.entities.find((e) => e.kind === "camera")!;
  const agent = sim.agents[0]!;
  let spot: Vec | undefined;
  for (let r = 2; r <= 5 && !spot; r++) {
    const p = { x: cam.pos.x + Math.cos(cam.facing) * r, y: cam.pos.y + Math.sin(cam.facing) * r };
    if (sim.map.walkable(Math.floor(p.x), Math.floor(p.y)) && sim.inVisionCone(cam, p)) spot = p;
  }
  agent.pos = { ...spot! };
  return { sim, cam, agent };
}

describe("cameras", () => {
  it("a camera that sees an agent raises the alarm", () => {
    const { sim, cam } = cameraSetup();
    tick(sim, 3, () => sim.alarm);
    expect(sim.alarm).toBe(true);
    expect(sim.events.some((e) => e.type === "detect" && e.guardId === cam.id)).toBe(true);
  });

  it("camera vision sweeps over time", () => {
    const sim = new Sim(loadMission("neon-tower-01"), defaultSettings());
    const cam = sim.entities.find((e) => e.kind === "camera")!;
    const f0 = cam.facing;
    tick(sim, 1);
    expect(cam.facing).not.toBeCloseTo(f0, 3);
  });

  it("hacking the security terminal disables nearby cameras and turrets", () => {
    const { sim, cam, agent } = cameraSetup();
    const node = sim.entities.find((e) => e.kind === "terminal" && e.role === "security")!;
    const helper = sim.agents[1]!;
    cam.detect = 0;
    agent.pos = { ...sim.mission.agentSpawns[0]! }; // out of view while we hack
    sim.orderAttack([helper.id], node.id);
    tick(sim, 60, () => !!node.done);
    expect(node.done).toBe(true);
    expect(cam.disabled).toBe(true);
    expect(sim.entities.find((e) => e.kind === "turret")!.disabled).toBe(true);
    const fresh = cameraSetup();
    // Same spot that trips an active camera is now safe.
    agent.pos = { ...fresh.agent.pos };
    tick(sim, 3);
    expect(sim.alarm).toBe(false);
  });

  it("a camera can be shot out; the gunfire is noise, not an alarm", () => {
    const sim = new Sim(loadMission("neon-tower-01"), quiet({ camera_vision_range: 7, camera_sweep: 0 }));
    const cam = sim.entities.find((e) => e.kind === "camera")!;
    const agent = sim.agents[0]!;
    // Beside the camera, outside its (frozen) cone.
    agent.pos = { x: cam.pos.x, y: cam.pos.y + 2 };
    expect(sim.map.walkable(Math.floor(agent.pos.x), Math.floor(agent.pos.y))).toBe(true);
    expect(sim.inVisionCone(cam, agent.pos)).toBe(false);
    sim.orderAttack([agent.id], cam.id);
    tick(sim, 0.1);
    expect(sim.events.some((e) => e.type === "noise")).toBe(true);
    expect(sim.alarm).toBe(false);
    expect(sim.entities.some((e) => e.kind === "guard" && e.alert === "suspicious")).toBe(true);
    tick(sim, 3, () => cam.hp <= 0);
    expect(cam.hp).toBe(0);
  });
});

describe("turrets", () => {
  it("only fire once the alarm is raised", () => {
    const sim = new Sim(loadMission("neon-tower-01"), quiet({ guard_damage: 0 }));
    const turret = sim.entities.find((e) => e.kind === "turret")!;
    const agent = sim.agents[0]!;
    agent.pos = { x: turret.pos.x + 2, y: turret.pos.y + 1 };
    expect(sim.canSee(turret.pos, agent.pos, Number(sim.cfg.turret_range))).toBe(true);
    tick(sim, 3);
    expect(agent.hp).toBe(agent.maxHp);
    expect(sim.shots.some((s) => s.hostile)).toBe(false);
    sim.raiseAlarm();
    const hp = agent.hp;
    tick(sim, 1);
    expect(agent.hp).toBeLessThan(hp);
  });
});

describe("alert states", () => {
  it("gunfire noise makes calm guards in range investigate the spot", () => {
    const sim = new Sim(loadMission("neon-tower-01"), quiet({ noise_radius: 8 }));
    const guards = sim.entities.filter((e) => e.kind === "guard");
    const at = { ...guards[0]!.pos };
    sim.noise(at);
    expect(sim.alarm).toBe(false);
    for (const g of guards) expect(g.alert).toBe(dist(g.pos, at) <= 8 ? "suspicious" : "calm");
    expect(guards[0]!.investigate).toEqual(at);
    expect(sim.alertState()).toBe("suspicious");
  });

  it("a guard that glimpses an agent investigates the last seen position, then calms down", () => {
    const sim = new Sim(loadMission("neon-tower-01"), { ...quiet(), guard_vision_range: 6, detection_time: 5, suspicious_search_time: 1 });
    const g = sim.entities.find((e) => e.kind === "guard")!;
    const agent = sim.agents[0]!;
    g.facing = 0;
    g.wait = 99;
    g.path = [];
    let spot: Vec | undefined;
    for (let r = 2; r <= 4 && !spot; r++) {
      const p = { x: g.pos.x + r, y: g.pos.y };
      if (sim.map.walkable(Math.floor(p.x), Math.floor(p.y)) && sim.inVisionCone(g, p)) spot = p;
    }
    agent.pos = { ...spot! };
    tick(sim, 0.5);
    expect(g.detect).toBeGreaterThan(0);
    agent.pos = { ...sim.mission.agentSpawns[0]! };
    tick(sim, 0.1);
    expect(g.alert).toBe("suspicious");
    expect(g.investigate).toEqual(spot);
    expect(sim.events.some((e) => e.type === "suspicious")).toBe(true);
    tick(sim, 10, () => g.alert === "calm");
    expect(g.alert).toBe("calm");
    expect(sim.alarm).toBe(false);
  });

  it("reinforcements arrive from the map edge after the alarm runs long enough", () => {
    const cfg = quiet({ reinforcement_delay: 2, reinforcement_count: 3, reinforcement_waves: 2 });
    const sim = new Sim(loadMission("neon-tower-01"), cfg);
    const before = sim.entities.filter((e) => e.kind === "guard").length;
    tick(sim, 3);
    expect(sim.entities.filter((e) => e.kind === "guard").length).toBe(before);
    sim.raiseAlarm();
    tick(sim, 1.5);
    expect(sim.entities.filter((e) => e.kind === "guard").length).toBe(before);
    tick(sim, 1);
    const reinf = sim.entities.filter((e) => e.reinforcement);
    expect(reinf.length).toBe(3);
    expect(reinf.every((r) => r.alert === "alarmed")).toBe(true);
    expect(sim.events.some((e) => e.type === "reinforcements")).toBe(true);
    tick(sim, 10);
    expect(sim.entities.filter((e) => e.reinforcement).length).toBe(6);
  });
});

describe("civilians", () => {
  it("spawn per civilian_count and wander", () => {
    const sim = new Sim(loadMission("rain-market-04"), { ...defaultSettings(), civilian_count: 5 });
    const civs = sim.civilians;
    expect(civs.length).toBe(5);
    const start = civs.map((c) => ({ ...c.pos }));
    tick(sim, 8);
    expect(civs.some((c, i) => dist(c.pos, start[i]!) > 0.5)).toBe(true);
  });

  it("panic at gunfire and raise the alarm after a delay unless stopped", () => {
    const cfg = quiet({ civilian_count: 1, civilian_alarm_delay: 2 });
    const sim = new Sim(loadMission("neon-tower-01"), cfg);
    const civ = sim.civilians[0]!;
    sim.noise(civ.pos);
    expect(civ.panic).toBeDefined();
    tick(sim, 1);
    expect(sim.alarm).toBe(false);
    tick(sim, 1.5);
    expect(sim.alarm).toBe(true);

    const sim2 = new Sim(loadMission("neon-tower-01"), cfg);
    const civ2 = sim2.civilians[0]!;
    sim2.noise(civ2.pos);
    tick(sim2, 1);
    civ2.hp = 0; // silenced
    tick(sim2, 3);
    expect(sim2.alarm).toBe(false);
  });

  it("a civilian who sees a body panics", () => {
    const sim = new Sim(loadMission("neon-tower-01"), quiet({ civilian_count: 1, civilian_vision_range: 6 }));
    const civ = sim.civilians[0]!;
    const guard = sim.entities.find((e) => e.kind === "guard")!;
    civ.path = [];
    civ.wait = 99;
    civ.facing = 0;
    guard.hp = 0;
    guard.pos = { x: civ.pos.x + 2, y: civ.pos.y };
    tick(sim, 0.1);
    expect(civ.panic).toBeDefined();
  });
});

describe("contracts with main.ts", () => {
  it("sim.target is never undefined and right-click (orderAttack) on objects interacts", () => {
    for (const src of MISSION_SOURCES) {
      const sim = new Sim(loadMission(src.id), quiet());
      expect(sim.target).toBeDefined();
      expect(sim.hostiles.every((h) => h.kind !== "terminal" && h.kind !== "package" && h.kind !== "civilian")).toBe(true);
    }
  });

  it("agents do not auto-shoot civilians or objects when the alarm is up", () => {
    const sim = new Sim(loadMission("rain-market-04"), quiet({ civilian_count: 6 }));
    sim.raiseAlarm();
    tick(sim, 5);
    expect(sim.entities.filter((e) => e.kind === "civilian" && e.hp <= 0).length).toBe(0);
  });

  it("right-clicking an opened door walks there instead of doing nothing", () => {
    const sim = new Sim(loadMission("kowloon-vault-02"), quiet());
    const door = sim.entities.find((e) => e.kind === "door")!;
    door.done = true;
    sim.map.set(Math.floor(door.pos.x), Math.floor(door.pos.y), Tile.Floor);
    const a = sim.agents[0]!;
    sim.orderAttack([a.id], door.id);
    expect(a.attackId).toBeUndefined();
    expect(a.path.length).toBeGreaterThan(0);
  });
});
