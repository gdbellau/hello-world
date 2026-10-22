// Single source of truth for every tunable value in the game.
// The admin panel renders its settings form from this schema, the Worker
// validates writes against it, and the client falls back to these defaults
// when the API is unreachable. Each area keeps its definitions in its own file.

import { ACCOUNT_SETTINGS } from "./accounts";
import { CORE_SETTINGS } from "./core";
import { CORP_SETTINGS } from "./corp";
import { MISSION_SETTINGS } from "./missions";
import { PRESENTATION_SETTINGS } from "./presentation";
import type { SettingDef } from "./types";

export type { SettingDef, SettingType } from "./types";

export const SETTINGS: readonly SettingDef[] = [
  ...CORE_SETTINGS,
  ...MISSION_SETTINGS,
  ...CORP_SETTINGS,
  ...ACCOUNT_SETTINGS,
  ...PRESENTATION_SETTINGS,
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
