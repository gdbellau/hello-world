import type { Vec } from "../iso";
import { Tile, TileMap } from "../map";
import type { MissionType } from "../../../shared/settings";

/** Static mission objects placed by the ASCII map (see legend below). */
export type MissionObjectKind = "camera" | "turret" | "terminal" | "door" | "package";

export interface MissionObject {
  kind: MissionObjectKind;
  pos: Vec;
  /** terminal: "data" (objective) or "security" (disables cameras/turrets). package: "prototype" or "scientist". */
  role?: "data" | "security" | "prototype" | "scientist";
  /** camera: mounting direction in radians (world space); the sweep is centred on it. */
  facing?: number;
}

export interface MissionDef {
  id: string;
  type: MissionType;
  name: string;
  brief: string;
  map: TileMap;
  agentSpawns: Vec[];
  guards: { patrol: Vec[] }[];
  /** Assassination VIP. Absent for espionage / research missions. */
  target?: { pos: Vec; patrol: Vec[]; name: string };
  objects: MissionObject[];
  /** Map-edge tiles where reinforcement waves arrive once the alarm has run long enough. */
  reinforcementSpawns: Vec[];
  /** Civilian spawn markers; `civilian_count` civilians are spread over them. */
  civilianSpawns: Vec[];
  /** Display name of the research package (prototype or scientist). */
  packageName: string;
}

/** Authoring format: an ASCII map plus metadata. */
export interface MissionSource {
  id: string;
  type: MissionType;
  name: string;
  brief: string;
  ascii: string;
  /** Assassination: the VIP's HUD name. */
  targetName?: string;
  /** Research: the package's HUD name (e.g. "THE KESTREL PROTOTYPE", "DR. OKAFOR"). */
  packageName?: string;
}

/*
 * ASCII legend
 *
 *   #   wall (blocks movement and sight)
 *   .   floor
 *   c   cover: waist-high, blocks movement but not sight
 *   E   extraction zone
 *   A   agent spawn (at least 4 per mission)
 *   T   assassination target start
 *   t   extra target waypoints, walked in reading order after T (default: T and the tile east of it)
 *   1-9 guard patrol waypoints: one guard per digit, walking its digits in reading order, looping
 *   R   reinforcement spawn point (a floor tile on the map edge)
 *   C   civilian spawn marker (floor)
 *   V   security camera on a pole (fixture: blocks movement, not sight); sweeps toward open floor
 *   U   automated turret (fixture); engages agents in LOS only once the alarm is raised
 *   H   data terminal (fixture): espionage objective, hack by standing next to it
 *   K   security terminal (fixture): hacking it disables cameras/turrets within security_hack_radius
 *   D   locked door: blocks movement and sight until an adjacent agent hacks it open
 *   P   prototype package (research objective, floor tile)
 *   S   scientist (research objective, floor tile): carried out like a prototype
 */
export function buildMission(src: MissionSource): MissionDef {
  const rows = src.ascii.trim().split("\n");
  const h = rows.length;
  const w = rows[0]!.length;
  const tiles = new Uint8Array(w * h);
  const spawns: Vec[] = [];
  const waypoints = new Map<string, Vec[]>();
  const objects: MissionObject[] = [];
  const reinforcementSpawns: Vec[] = [];
  const civilianSpawns: Vec[] = [];
  const targetWps: Vec[] = [];
  let target = null as Vec | null;
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`${src.id}: row ${y} is ${row.length} wide, expected ${w}`);
    [...row].forEach((ch, x) => {
      const c = { x: x + 0.5, y: y + 0.5 };
      let t = Tile.Floor;
      switch (ch) {
        case "#": t = Tile.Wall; break;
        case "c": t = Tile.Cover; break;
        case "E": t = Tile.Extract; break;
        case "A": spawns.push(c); break;
        case "T": target = c; break;
        case "t": targetWps.push(c); break;
        case "R": reinforcementSpawns.push(c); break;
        case "C": civilianSpawns.push(c); break;
        case "V": t = Tile.Fixture; objects.push({ kind: "camera", pos: c }); break;
        case "U": t = Tile.Fixture; objects.push({ kind: "turret", pos: c }); break;
        case "H": t = Tile.Fixture; objects.push({ kind: "terminal", pos: c, role: "data" }); break;
        case "K": t = Tile.Fixture; objects.push({ kind: "terminal", pos: c, role: "security" }); break;
        case "D": t = Tile.Door; objects.push({ kind: "door", pos: c }); break;
        case "P": objects.push({ kind: "package", pos: c, role: "prototype" }); break;
        case "S": objects.push({ kind: "package", pos: c, role: "scientist" }); break;
        case ".": break;
        default:
          if (/[1-9]/.test(ch)) waypoints.set(ch, [...(waypoints.get(ch) ?? []), c]);
          else throw new Error(`${src.id}: unknown map glyph '${ch}' at ${x},${y}`);
      }
      tiles[y * w + x] = t;
    });
  });
  const map = new TileMap(w, h, tiles);
  // Cameras point toward the open floor around them.
  for (const o of objects) if (o.kind === "camera") o.facing = openDirection(map, o.pos);
  const tgt = target as Vec | null;
  const defaultPackage = objects.some((o) => o.role === "scientist") ? "THE SCIENTIST" : "THE PROTOTYPE";
  return {
    id: src.id,
    type: src.type,
    name: src.name,
    brief: src.brief,
    map,
    agentSpawns: spawns,
    guards: [...waypoints.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, patrol]) => ({ patrol })),
    target: tgt
      ? { pos: tgt, patrol: [tgt, ...(targetWps.length ? targetWps : [{ x: tgt.x + 1, y: tgt.y }])], name: src.targetName ?? "THE TARGET" }
      : undefined,
    objects,
    reinforcementSpawns,
    civilianSpawns,
    packageName: src.packageName ?? defaultPackage,
  };
}

/** Average direction from a tile toward the visible floor within a few tiles. */
function openDirection(map: TileMap, p: Vec): number {
  let sx = 0;
  let sy = 0;
  const r = 4;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy) continue;
      const q = { x: p.x + dx, y: p.y + dy };
      if (!map.walkable(Math.floor(q.x), Math.floor(q.y)) || !map.lineOfSight(p, q)) continue;
      const d = Math.hypot(dx, dy);
      sx += dx / d;
      sy += dy / d;
    }
  }
  return Math.atan2(sy, sx);
}
