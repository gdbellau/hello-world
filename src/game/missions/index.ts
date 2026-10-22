import { CRYO_WARD } from "./cryo-ward";
import { HELIX_LABS } from "./helix-labs";
import { KOWLOON_VAULT } from "./kowloon-vault";
import { NEON_TOWER } from "./neon-tower";
import { RAIN_MARKET } from "./rain-market";
import { UPLINK_RELAY } from "./uplink-relay";
import { buildMission, type MissionDef, type MissionSource } from "./types";

export { buildMission, type MissionDef, type MissionObject, type MissionObjectKind, type MissionSource } from "./types";

/** Campaign order. neon-tower-01 stays first (it's the deploy default). */
export const MISSION_SOURCES: readonly MissionSource[] = [NEON_TOWER, KOWLOON_VAULT, HELIX_LABS, RAIN_MARKET, UPLINK_RELAY, CRYO_WARD];

export function loadMission(id: string): MissionDef {
  const src = MISSION_SOURCES.find((m) => m.id === id);
  if (!src) throw new Error(`Unknown mission: ${id}`);
  return buildMission(src);
}
