// Single source of truth for every tunable value in the game.
// The admin panel renders its settings form from this schema, the Worker
// validates writes against it, and the client falls back to these defaults
// when the API is unreachable.

export type SettingType = "number" | "integer" | "boolean" | "string";

export interface SettingDef {
  key: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  default: number | boolean | string;
  min?: number;
  max?: number;
  /** Public settings are sent to game clients via /api/config. */
  public: boolean;
}

export const SETTINGS: readonly SettingDef[] = [
  // --- General / ops -------------------------------------------------------
  { key: "maintenance_mode", category: "General", label: "Maintenance mode", description: "Blocks new missions and shows a maintenance banner.", type: "boolean", default: false, public: true },
  { key: "motd", category: "General", label: "Message of the day", description: "Shown on the title screen. Leave empty to hide.", type: "string", default: "", public: true },
  { key: "min_client_version", category: "General", label: "Minimum client version", description: "Clients below this build are asked to refresh.", type: "integer", default: 1, min: 1, max: 100000, public: true },

  // --- Squad ---------------------------------------------------------------
  { key: "squad_size", category: "Squad", label: "Squad size", description: "Agents deployed per mission.", type: "integer", default: 4, min: 1, max: 6, public: true },
  { key: "agent_hp", category: "Squad", label: "Agent base HP", description: "Starting hit points for an unaugmented agent.", type: "integer", default: 100, min: 10, max: 1000, public: true },
  { key: "agent_speed", category: "Squad", label: "Agent move speed", description: "Tiles per second.", type: "number", default: 3.2, min: 0.5, max: 10, public: true },
  { key: "agent_weapon_damage", category: "Squad", label: "Agent weapon damage", description: "Damage per shot.", type: "integer", default: 18, min: 1, max: 500, public: true },
  { key: "agent_weapon_range", category: "Squad", label: "Agent weapon range", description: "Range in tiles.", type: "number", default: 6, min: 1, max: 20, public: true },
  { key: "agent_fire_cooldown", category: "Squad", label: "Agent fire cooldown", description: "Seconds between shots.", type: "number", default: 0.6, min: 0.05, max: 5, public: true },
  { key: "permadeath", category: "Squad", label: "Permadeath (Ironman)", description: "Agents killed in a mission are lost from the roster.", type: "boolean", default: false, public: true },

  // --- Enemy AI ------------------------------------------------------------
  { key: "guard_hp", category: "Enemy AI", label: "Guard HP", description: "Hit points for a standard guard.", type: "integer", default: 60, min: 1, max: 1000, public: true },
  { key: "guard_speed", category: "Enemy AI", label: "Guard move speed", description: "Tiles per second.", type: "number", default: 2.2, min: 0.5, max: 10, public: true },
  { key: "guard_vision_range", category: "Enemy AI", label: "Guard vision range", description: "Tiles.", type: "number", default: 6, min: 1, max: 20, public: true },
  { key: "guard_vision_fov", category: "Enemy AI", label: "Guard field of view", description: "Degrees.", type: "integer", default: 90, min: 10, max: 360, public: true },
  { key: "guard_damage", category: "Enemy AI", label: "Guard weapon damage", description: "Damage per shot.", type: "integer", default: 10, min: 1, max: 500, public: true },
  { key: "guard_fire_cooldown", category: "Enemy AI", label: "Guard fire cooldown", description: "Seconds between shots.", type: "number", default: 0.9, min: 0.05, max: 5, public: true },
  { key: "detection_time", category: "Enemy AI", label: "Detection time", description: "Seconds an agent must stay in view before the alarm sounds.", type: "number", default: 1.2, min: 0, max: 10, public: true },

  // --- Economy -------------------------------------------------------------
  { key: "starting_credits", category: "Economy", label: "Starting credits", description: "Credits granted to a new corporation.", type: "integer", default: 5000, min: 0, max: 10000000, public: true },
  { key: "reward_assassination", category: "Economy", label: "Reward: assassination", description: "Base credits for a successful assassination contract.", type: "integer", default: 2500, min: 0, max: 1000000, public: true },
  { key: "reward_espionage", category: "Economy", label: "Reward: espionage", description: "Base credits for a successful espionage contract.", type: "integer", default: 1800, min: 0, max: 1000000, public: true },
  { key: "reward_research", category: "Economy", label: "Reward: research theft", description: "Base credits for a successful research theft contract.", type: "integer", default: 2000, min: 0, max: 1000000, public: true },
  { key: "stealth_bonus_pct", category: "Economy", label: "Stealth bonus %", description: "Extra reward when the alarm is never raised.", type: "integer", default: 50, min: 0, max: 500, public: true },
  { key: "min_mission_seconds", category: "Economy", label: "Min mission duration (s)", description: "Completions faster than this are rejected as implausible.", type: "integer", default: 20, min: 0, max: 3600, public: false },

  // --- Store ---------------------------------------------------------------
  { key: "store_enabled", category: "Store", label: "Store enabled", description: "Global kill switch for purchases.", type: "boolean", default: false, public: true },
  { key: "store_banner", category: "Store", label: "Store banner", description: "Promo text shown in the store.", type: "string", default: "", public: true },
];

export type SettingValue = number | boolean | string;
export type SettingsMap = Record<string, SettingValue>;

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(
  SETTINGS.map((s) => [s.key, s]),
);

export function defaultSettings(): SettingsMap {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
}

/** Returns the coerced value, or throws with a human-readable message. */
export function validateSetting(key: string, raw: unknown): SettingValue {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  switch (def.type) {
    case "boolean":
      if (typeof raw !== "boolean") throw new Error(`${key} must be true or false`);
      return raw;
    case "string":
      if (typeof raw !== "string") throw new Error(`${key} must be a string`);
      if (raw.length > 2000) throw new Error(`${key} is too long`);
      return raw;
    case "number":
    case "integer": {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${key} must be a number`);
      if (def.type === "integer" && !Number.isInteger(n)) throw new Error(`${key} must be a whole number`);
      if (def.min !== undefined && n < def.min) throw new Error(`${key} must be ≥ ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`${key} must be ≤ ${def.max}`);
      return n;
    }
  }
}

/** Merges stored overrides over defaults, silently dropping invalid/stale rows. */
export function mergeSettings(overrides: Record<string, unknown>): SettingsMap {
  const out = defaultSettings();
  for (const [k, v] of Object.entries(overrides)) {
    try {
      out[k] = validateSetting(k, v);
    } catch {
      // Ignore keys removed from the schema or values that no longer validate.
    }
  }
  return out;
}

export function publicSettings(all: SettingsMap): SettingsMap {
  return Object.fromEntries(
    Object.entries(all).filter(([k]) => SETTINGS_BY_KEY.get(k)?.public),
  );
}

export type MissionType = "assassination" | "espionage" | "research";
export const MISSION_TYPES: readonly MissionType[] = ["assassination", "espionage", "research"];

export function missionReward(type: MissionType, stealth: boolean, s: SettingsMap): number {
  const base = Number(s[`reward_${type}`] ?? 0);
  const bonus = stealth ? Math.round((base * Number(s.stealth_bonus_pct)) / 100) : 0;
  return base + bonus;
}
