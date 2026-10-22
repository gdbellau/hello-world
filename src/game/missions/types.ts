import type { Vec } from "../iso";
import { Tile, TileMap } from "../map";
import type { MissionType } from "../../../shared/settings";

export interface MissionDef {
  id: string;
  type: MissionType;
  name: string;
  brief: string;
  map: TileMap;
  agentSpawns: Vec[];
  guards: { patrol: Vec[] }[];
  target: { pos: Vec; patrol: Vec[] };
}

/** Authoring format: an ASCII map plus metadata. */
export interface MissionSource {
  id: string;
  type: MissionType;
  name: string;
  brief: string;
  ascii: string;
}

// Legend: # wall, . floor, c cover, E extraction, A agent spawn, T target,
// 1-9 guard patrol waypoints (a guard walks its digits in order, looping).
export function buildMission(src: MissionSource): MissionDef {
  const rows = src.ascii.trim().split("\n");
  const h = rows.length;
  const w = rows[0]!.length;
  const tiles = new Uint8Array(w * h);
  const spawns: Vec[] = [];
  const waypoints = new Map<string, Vec[]>();
  let target: Vec = { x: 0, y: 0 };
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`${src.id}: row ${y} is ${row.length} wide, expected ${w}`);
    [...row].forEach((ch, x) => {
      const c = { x: x + 0.5, y: y + 0.5 };
      let t = Tile.Floor;
      if (ch === "#") t = Tile.Wall;
      else if (ch === "c") t = Tile.Cover;
      else if (ch === "E") t = Tile.Extract;
      else if (ch === "A") spawns.push(c);
      else if (ch === "T") target = c;
      else if (/[1-9]/.test(ch)) waypoints.set(ch, [...(waypoints.get(ch) ?? []), c]);
      tiles[y * w + x] = t;
    });
  });
  return {
    id: src.id,
    type: src.type,
    name: src.name,
    brief: src.brief,
    map: new TileMap(w, h, tiles),
    agentSpawns: spawns,
    guards: [...waypoints.values()].map((patrol) => ({ patrol })),
    target: { pos: target, patrol: [target, { x: target.x + 1, y: target.y }] },
  };
}
