import { mergeSettings, type SettingsMap } from "../shared/settings";
import type { Env } from "./env";

export const today = () => new Date().toISOString().slice(0, 10);
export const nowMs = () => Date.now();

export async function loadSettings(env: Env): Promise<SettingsMap> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const overrides: Record<string, unknown> = {};
  for (const r of results) {
    try {
      overrides[r.key] = JSON.parse(r.value);
    } catch {
      // Corrupt row: fall back to the default.
    }
  }
  return mergeSettings(overrides);
}

/** Pre-aggregated daily counter; batch it with the write it describes. */
export function bumpStat(env: Env, metric: string, by = 1): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO daily_stats (day, metric, value) VALUES (?1, ?2, ?3)
     ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`,
  ).bind(today(), metric, by);
}

export function audit(env: Env, actor: string, action: string, target: string, detail: unknown = ""): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
    nowMs(),
    actor,
    action,
    target,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}
