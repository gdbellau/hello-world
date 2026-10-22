import { describe, expect, it } from "vitest";
import { SETTINGS, defaultSettings, mergeSettings, missionReward, publicSettings, validateSetting } from "../shared/settings";

describe("settings schema", () => {
  it("has unique keys and defaults that pass their own validation", () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SETTINGS) expect(validateSetting(s.key, s.default)).toBe(s.default);
  });

  it("rejects out-of-range, wrong-type and unknown values", () => {
    expect(() => validateSetting("squad_size", 99)).toThrow(/≤/);
    expect(() => validateSetting("squad_size", 2.5)).toThrow(/whole/);
    expect(() => validateSetting("store_enabled", "yes")).toThrow();
    expect(() => validateSetting("nope", 1)).toThrow(/Unknown/);
    expect(validateSetting("agent_speed", "4.5")).toBe(4.5);
  });

  it("merge ignores stale or invalid overrides", () => {
    const m = mergeSettings({ squad_size: 3, removed_key: 1, agent_hp: -5 });
    expect(m.squad_size).toBe(3);
    expect(m.agent_hp).toBe(defaultSettings().agent_hp);
    expect("removed_key" in m).toBe(false);
  });

  it("public view hides server-only settings", () => {
    const p = publicSettings(defaultSettings());
    expect("min_mission_seconds" in p).toBe(false);
    expect("squad_size" in p).toBe(true);
  });

  it("applies the stealth bonus", () => {
    const s = { ...defaultSettings(), reward_assassination: 1000, stealth_bonus_pct: 50 };
    expect(missionReward("assassination", false, s)).toBe(1000);
    expect(missionReward("assassination", true, s)).toBe(1500);
  });
});
