import { describe, expect, it } from "vitest";
import { defaultSettings } from "../shared/settings";
import { screenToWorld, worldToScreen } from "../src/game/iso";
import { Tile } from "../src/game/map";
import { loadMission, MISSION_SOURCES } from "../src/game/missions";
import { Sim } from "../src/game/sim";

describe("iso projection", () => {
  it("round-trips world → screen → world", () => {
    const s = worldToScreen(7.25, 3.5);
    const w = screenToWorld(s.x, s.y);
    expect(w.x).toBeCloseTo(7.25);
    expect(w.y).toBeCloseTo(3.5);
  });
});

describe("mission registry", () => {
  it("every mission builds with a unique id and enough spawns; neon-tower-01 stays first", () => {
    const ids = MISSION_SOURCES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("neon-tower-01");
    for (const src of MISSION_SOURCES) {
      const m = loadMission(src.id);
      expect(m.agentSpawns.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("mission map", () => {
  const m = loadMission("neon-tower-01");

  it("parses a rectangular map with spawns, guards, target and extraction", () => {
    expect(m.map.tiles.length).toBe(m.map.width * m.map.height);
    expect(m.agentSpawns.length).toBeGreaterThanOrEqual(4);
    expect(m.guards.length).toBeGreaterThan(0);
    expect(m.target).toBeDefined();
    expect(m.map.walkable(Math.floor(m.target!.pos.x), Math.floor(m.target!.pos.y))).toBe(true);
  });

  it("can path from spawn to the target and to every extraction tile", () => {
    const sim = new Sim(m, defaultSettings());
    expect(m.map.findPath(m.agentSpawns[0]!, m.target!.pos)).not.toBeNull();
    for (const e of sim.extractTiles()) expect(m.map.findPath(m.agentSpawns[0]!, e)).not.toBeNull();
  });

  it("every guard patrol waypoint is reachable", () => {
    for (const g of m.guards) for (const wp of g.patrol) expect(m.map.findPath(m.agentSpawns[0]!, wp)).not.toBeNull();
  });

  it("walls block line of sight; cover does not", () => {
    // Row 5 has a solid wall run between x=12..17.
    expect(m.map.get(14, 5)).toBe(Tile.Wall);
    expect(m.map.lineOfSight({ x: 14.5, y: 4.5 }, { x: 14.5, y: 6.5 })).toBe(false);
    expect(m.map.get(20, 1)).toBe(Tile.Cover);
    expect(m.map.lineOfSight({ x: 19.5, y: 1.5 }, { x: 21.5, y: 1.5 })).toBe(true);
    expect(m.map.walkable(20, 1)).toBe(false);
  });
});

function tick(sim: Sim, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 30) sim.update(1 / 30);
}

describe("simulation", () => {
  it("silent takedown of an unaware target does not raise the alarm", () => {
    // Guards and cameras effectively blind, no bystanders.
    const cfg = { ...defaultSettings(), guard_vision_range: 0.01, camera_vision_range: 0.01, civilian_count: 0 };
    const sim = new Sim(loadMission("neon-tower-01"), cfg);
    const agent = sim.agents[0]!;
    sim.orderAttack([agent.id], sim.target.id);
    tick(sim, 30);
    expect(sim.target.hp).toBe(0);
    expect(sim.alarm).toBe(false);
  });

  it("a guard that watches an agent long enough raises the alarm", () => {
    const sim = new Sim(loadMission("neon-tower-01"), defaultSettings());
    const guard = sim.entities.find((e) => e.kind === "guard")!;
    const agent = sim.agents[0]!;
    guard.patrol = [{ ...guard.pos }];
    guard.wait = 999;
    // Park the agent right in front of the guard.
    agent.pos = { x: guard.pos.x + 1, y: guard.pos.y };
    guard.facing = 0;
    // Freeze the guard's look-around so the agent stays in the cone.
    const update = () => {
      guard.facing = 0;
      sim.update(1 / 30);
    };
    for (let i = 0; i < 30 * 3; i++) update();
    expect(sim.alarm).toBe(true);
  });

  it("wins when the target is dead and all agents stand on extraction", () => {
    const sim = new Sim(loadMission("neon-tower-01"), defaultSettings());
    sim.target.hp = 0;
    const ex = sim.extractTiles();
    sim.agents.forEach((a, i) => (a.pos = { ...ex[i % ex.length]! }));
    sim.update(0.01);
    expect(sim.outcome).toBe("win");
  });

  it("loses when every agent is dead", () => {
    const sim = new Sim(loadMission("neon-tower-01"), defaultSettings());
    for (const a of sim.agents) a.hp = 0;
    sim.update(0.01);
    expect(sim.outcome).toBe("loss");
  });

  it("respects squad_size from config", () => {
    const sim = new Sim(loadMission("neon-tower-01"), { ...defaultSettings(), squad_size: 2 });
    expect(sim.agents.length).toBe(2);
  });
});
