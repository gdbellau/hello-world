import { NEON_TOWER } from "./neon-tower";
import { buildMission, type MissionDef, type MissionSource } from "./types";

export { buildMission, type MissionDef, type MissionSource } from "./types";

/** Campaign order. */
export const MISSION_SOURCES: readonly MissionSource[] = [NEON_TOWER];

export function loadMission(id: string): MissionDef {
  const src = MISSION_SOURCES.find((m) => m.id === id);
  if (!src) throw new Error(`Unknown mission: ${id}`);
  return buildMission(src);
}
