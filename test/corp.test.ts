import { describe, expect, it } from "vitest";
import {
  AUGMENTS,
  AUGMENTS_BY_ID,
  RESEARCH,
  RESEARCH_BY_ID,
  agentStats,
  agentStatus,
  availableSkins,
  canInstall,
  canResearch,
  contractRewards,
  contractStates,
  corpBonuses,
  districtFor,
  generateCallsign,
  generateFullName,
  healCost,
  injuryMinutes,
  isUnlocked,
  levelForXp,
  recruitCost,
  rosterCap,
  seededRng,
  squadCap,
  xpForLevel,
  xpGain,
} from "../shared/corp";
import { SETTINGS, defaultSettings, missionReward, validateSetting } from "../shared/settings";

const s = defaultSettings();
const rich = { credits: 1e9, research_points: 1e9, intel: 1e9 };

describe("catalogue", () => {
  it("augment and research ids are unique and references resolve", () => {
    expect(new Set(AUGMENTS.map((a) => a.id)).size).toBe(AUGMENTS.length);
    expect(new Set(RESEARCH.map((r) => r.id)).size).toBe(RESEARCH.length);
    for (const a of AUGMENTS) if (a.requires) expect(RESEARCH_BY_ID.has(a.requires)).toBe(true);
    for (const r of RESEARCH) for (const p of r.requires) expect(RESEARCH_BY_ID.has(p)).toBe(true);
  });

  it("research tree has no cycles", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string) => {
      if (done.has(id)) return;
      expect(visiting.has(id)).toBe(false);
      visiting.add(id);
      for (const p of RESEARCH_BY_ID.get(id)!.requires) visit(p);
      visiting.delete(id);
      done.add(id);
    };
    RESEARCH.forEach((r) => visit(r.id));
  });

  it("every augment price and research cost is an admin setting with a valid default", () => {
    const keys = new Set(SETTINGS.map((x) => x.key));
    for (const a of AUGMENTS) expect(keys.has(`aug_price_${a.id}`)).toBe(true);
    for (const r of RESEARCH) for (const k of ["credits", "rp", "intel"]) expect(keys.has(`rd_${r.id}_${k}`)).toBe(true);
    for (const x of SETTINGS.filter((d) => d.category.startsWith("Corp"))) expect(validateSetting(x.key, x.default)).toBe(x.default);
  });
});

describe("agent stats", () => {
  it("applies class percentages to the base settings", () => {
    const st = agentStats({ cls: "bruiser", level: 1, implants: {} }, s);
    expect(st.hp).toBe(Math.round(Number(s.agent_hp) * 1.4));
    expect(st.speed).toBeCloseTo(Number(s.agent_speed) * 0.85, 2);
    expect(st.damageMul).toBeCloseTo(1.2, 2);
    expect(st.stealthMul).toBeCloseTo(0.75, 2);
  });

  it("stacks implants and levels", () => {
    const base = agentStats({ cls: "ghost", level: 1, implants: {} }, s);
    const aug = agentStats(
      { cls: "ghost", level: 1, implants: { torso: "dermal_plating", legs: "synthetic_muscles", head: "targeting_optics" } },
      s,
    );
    expect(aug.hp).toBe(base.hp + 30);
    expect(aug.speed).toBeCloseTo(base.speed * 1.1, 1);
    expect(aug.damageMul).toBeCloseTo(base.damageMul * 1.15, 2);
    expect(aug.stealthMul).toBeCloseTo(base.stealthMul * 0.95, 2);
    const lv5 = agentStats({ cls: "ghost", level: 5, implants: {} }, s);
    expect(lv5.hp).toBe(Math.round(Number(s.agent_hp) * 0.85 * (1 + (4 * Number(s.level_hp_pct)) / 100)));
    expect(lv5.damageMul).toBeGreaterThan(base.damageMul);
  });

  it("ignores implants in the wrong slot or unknown ids", () => {
    const base = agentStats({ cls: "razor", level: 1, implants: {} }, s);
    const bad = agentStats({ cls: "razor", level: 1, implants: { head: "dermal_plating", arms: "nope" } }, s);
    expect(bad).toEqual(base);
  });

  it("follows settings overrides", () => {
    const st = agentStats({ cls: "decker", level: 1, implants: {} }, { ...s, class_decker_hp_pct: 200, agent_hp: 50 });
    expect(st.hp).toBe(100);
  });
});

describe("xp curve", () => {
  it("is monotonic and matches the configured base", () => {
    expect(xpForLevel(1, s)).toBe(0);
    expect(xpForLevel(2, s)).toBe(Number(s.xp_level_base));
    for (let l = 2; l < 10; l++) expect(xpForLevel(l + 1, s)).toBeGreaterThan(xpForLevel(l, s));
  });

  it("levelForXp inverts xpForLevel and respects the cap", () => {
    for (let l = 1; l <= 10; l++) {
      expect(levelForXp(xpForLevel(l, s), s)).toBe(l);
      if (l > 1) expect(levelForXp(xpForLevel(l, s) - 1, s)).toBe(l - 1);
    }
    expect(levelForXp(1e12, s)).toBe(Number(s.agent_max_level));
  });

  it("xpGain rewards survival, wins, stealth, kills and R&D, and clamps kills", () => {
    const b0 = corpBonuses([]);
    const lossDead = xpGain({ survived: false, won: false, stealth: false, kills: 2 }, s, b0);
    expect(lossDead).toBe(2 * Number(s.xp_per_kill));
    const ghostWin = xpGain({ survived: true, won: true, stealth: true, kills: 0 }, s, b0);
    expect(ghostWin).toBe(Number(s.xp_per_mission) + Number(s.xp_win_bonus) + Number(s.xp_stealth_bonus));
    const sims = xpGain({ survived: true, won: true, stealth: true, kills: 0 }, s, corpBonuses(["combat_sims"]));
    expect(sims).toBe(Math.round(ghostWin * 1.5));
    const cheat = xpGain({ survived: false, won: false, stealth: false, kills: 1e6 }, s, b0);
    expect(cheat).toBe(Number(s.max_kills_per_mission) * Number(s.xp_per_kill));
  });
});

describe("research", () => {
  it("checks prerequisites, duplicates and every currency", () => {
    expect(canResearch("metamaterials", new Set(), rich, s)).toMatchObject({ ok: false, reason: expect.stringMatching(/Requires/) });
    expect(canResearch("metamaterials", new Set(["neuroware", "combat_cyberware", "subdermal"]), rich, s).ok).toBe(true);
    expect(canResearch("neuroware", new Set(["neuroware"]), rich, s)).toMatchObject({ ok: false, reason: "Already researched" });
    expect(canResearch("neuroware", new Set(), { ...rich, credits: 0 }, s)).toMatchObject({ ok: false, reason: "Not enough credits" });
    expect(canResearch("neuroware", new Set(), { ...rich, research_points: 0 }, s)).toMatchObject({ ok: false, reason: "Not enough research points" });
    expect(canResearch("ghost_protocol", new Set(["neuroware"]), { ...rich, intel: 0 }, s)).toMatchObject({ ok: false, reason: "Not enough intel" });
    expect(canResearch("bogus", new Set(), rich, s).ok).toBe(false);
  });

  it("bonuses sum and feed caps, costs and rewards", () => {
    const b = corpBonuses(["barracks", "tactical_doctrine", "headhunters", "shell_companies"]);
    expect(rosterCap(s, b)).toBe(Number(s.roster_max) + 4);
    expect(squadCap(s, b)).toBe(Number(s.squad_size) + 1);
    expect(squadCap({ ...s, squad_size: 6 }, b)).toBe(6);
    expect(recruitCost(s, b, 3)).toBe(Math.round(Number(s.recruit_cost) * 0.7));
    expect(recruitCost(s, b, 0)).toBe(0); // free when wiped
    expect(recruitCost({ ...s, recruit_free_when_empty: false }, corpBonuses([]), 0)).toBe(Number(s.recruit_cost));
    const base = missionReward("assassination", false, s);
    expect(contractRewards("assassination", base, false, s, b).credits).toBe(Math.round(base * 1.2));
  });

  it("gates augments behind research and validates installs", () => {
    const agent = { dead: false, implants: {} };
    expect(canInstall(agent, "mantis_blades", new Set(), 1e9, s)).toMatchObject({ ok: false, reason: expect.stringMatching(/Combat Cyberware/) });
    expect(canInstall(agent, "mantis_blades", new Set(["combat_cyberware"]), 1e9, s).ok).toBe(true);
    expect(canInstall(agent, "targeting_optics", new Set(), 0, s)).toMatchObject({ ok: false, reason: "Not enough credits" });
    expect(canInstall({ dead: true, implants: {} }, "targeting_optics", new Set(), 1e9, s).ok).toBe(false);
    expect(canInstall({ dead: false, implants: { head: "targeting_optics" } }, "targeting_optics", new Set(), 1e9, s).ok).toBe(false);
    expect(AUGMENTS_BY_ID.get("mantis_blades")!.slot).toBe("arms");
  });
});

describe("rewards, injuries and status", () => {
  it("first clear and per-type RP / intel", () => {
    const b = corpBonuses([]);
    const r = contractRewards("research", 1000, false, s, b);
    expect(r).toEqual({ credits: 1000, rp: Number(s.reward_rp_research), intel: Number(s.reward_intel_research) });
    const first = contractRewards("research", 1000, true, s, b);
    expect(first.credits).toBe(Math.round(1000 * (1 + Number(s.first_clear_bonus_pct) / 100)));
    expect(contractRewards("espionage", 0, false, s, b).intel).toBe(Number(s.reward_intel_espionage));
    expect(contractRewards("unknown-type", 0, false, s, b)).toEqual({ credits: 0, rp: 0, intel: 0 });
  });

  it("injury durations", () => {
    const b = corpBonuses([]);
    expect(injuryMinutes({ survived: true, hpPct: 100 }, s, b)).toBe(0);
    expect(injuryMinutes({ survived: true, hpPct: 10 }, s, b)).toBe(Number(s.injury_minutes_wounded));
    expect(injuryMinutes({ survived: false, hpPct: 0 }, s, b)).toBe(Number(s.injury_minutes_downed));
    expect(injuryMinutes({ survived: false, hpPct: 0 }, s, corpBonuses(["trauma_center"]))).toBe(Math.round(Number(s.injury_minutes_downed) / 2));
    expect(healCost(10 * 60000, 0, s)).toBe(10 * Number(s.heal_cost_per_minute));
    expect(healCost(0, 5, s)).toBe(0);
  });

  it("agent status", () => {
    expect(agentStatus({ dead: true, injured_until: 0 }, 1)).toBe("dead");
    expect(agentStatus({ dead: false, injured_until: 100 }, 50)).toBe("injured");
    expect(agentStatus({ dead: false, injured_until: 100 }, 100)).toBe("ready");
  });
});

describe("names", () => {
  it("is deterministic for a seed and fits the HUD", () => {
    const a = generateCallsign(seededRng(42));
    expect(generateCallsign(seededRng(42))).toBe(a);
    expect(a).toMatch(/^[A-Z0-9-]{2,10}$/);
    expect(generateFullName(seededRng(7))).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("avoids callsigns already on the roster", () => {
    const rng = seededRng(1);
    const taken: string[] = [];
    for (let i = 0; i < 80; i++) {
      const c = generateCallsign(rng, taken);
      expect(taken).not.toContain(c);
      expect(c.length).toBeLessThanOrEqual(10);
      taken.push(c);
    }
  });
});

describe("world and campaign", () => {
  it("unlocks contracts in order", () => {
    const ids = ["a", "b", "c"];
    expect(contractStates(ids, new Set())).toEqual(["available", "locked", "locked"]);
    expect(contractStates(ids, new Set(["a"]))).toEqual(["cleared", "available", "locked"]);
    expect(isUnlocked(ids, "b", new Set())).toBe(false);
    expect(isUnlocked(ids, "b", new Set(["a"]))).toBe(true);
    expect(isUnlocked(ids, "a", new Set())).toBe(true);
    expect(isUnlocked(ids, "zzz", new Set(["a", "b", "c"]))).toBe(false);
  });

  it("assigns every mission a stable district", () => {
    expect(districtFor("neon-tower-01").id).toBe("neon-row");
    expect(districtFor("some-new-mission")).toBe(districtFor("some-new-mission"));
  });
});

describe("skins", () => {
  it("default + skin entitlements + founder for supporters", () => {
    expect(availableSkins([])).toEqual(["default"]);
    expect(availableSkins(["skin:chrome", "dlc:orbital", "supporter", "skin:yakuza"])).toEqual(["default", "chrome", "yakuza", "founder"]);
    expect(availableSkins(["skin:"])).toEqual(["default"]);
  });
});
