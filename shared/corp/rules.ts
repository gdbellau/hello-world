// Pure corp rules shared by the client (display, loadout) and the Worker
// (validation, rewards). Every number comes from the settings map.

import type { SettingsMap } from "../settings";
import {
  AUGMENTS_BY_ID,
  RESEARCH_BY_ID,
  SLOTS,
  type AgentClass,
  type AugmentDef,
  type ResearchDef,
  type ResearchEffects,
  type Slot,
} from "./catalogue";

export type Implants = Partial<Record<Slot, string>>;

/** A roster agent as the API returns it. */
export interface CorpAgent {
  id: string;
  name: string;
  full_name: string;
  cls: AgentClass;
  level: number;
  xp: number;
  implants: Implants;
  /** Epoch ms; the agent is injured while now < injured_until. */
  injured_until: number;
  dead: boolean;
  kills: number;
  missions: number;
}

/** GET /api/corp */
export interface CorpState {
  corp_name: string;
  credits: number;
  research_points: number;
  intel: number;
  agents: CorpAgent[];
  research: string[];
  cleared: string[];
  /** Server clock, so injury timers don't depend on the client clock. */
  now: number;
}

export type AgentStatus = "ready" | "injured" | "dead";

export function agentStatus(a: Pick<CorpAgent, "dead" | "injured_until">, now: number): AgentStatus {
  if (a.dead) return "dead";
  return a.injured_until > now ? "injured" : "ready";
}

const num = (s: SettingsMap, k: string, fallback = 0) => {
  const v = Number(s[k]);
  return Number.isFinite(v) ? v : fallback;
};

// --- Research effects -------------------------------------------------------

export type Bonuses = Required<ResearchEffects>;

export function corpBonuses(research: Iterable<string>): Bonuses {
  const b: Bonuses = { squadSize: 0, rosterCap: 0, creditPct: 0, rpPct: 0, intelPct: 0, xpPct: 0, injuryPct: 0, recruitPct: 0 };
  for (const id of research) {
    const e = RESEARCH_BY_ID.get(id)?.effects;
    if (!e) continue;
    for (const k of Object.keys(b) as (keyof Bonuses)[]) b[k] += e[k] ?? 0;
  }
  return b;
}

/** Hard cap on squad size: the Sim and the squad_size setting max out at 6. */
export const MAX_SQUAD = 6;

export function squadCap(s: SettingsMap, b: Bonuses): number {
  return Math.max(1, Math.min(MAX_SQUAD, num(s, "squad_size", 4) + b.squadSize));
}

export function rosterCap(s: SettingsMap, b: Bonuses): number {
  return Math.max(1, num(s, "roster_max", 12) + b.rosterCap);
}

export function recruitCost(s: SettingsMap, b: Bonuses, livingAgents: number): number {
  if (livingAgents === 0 && s.recruit_free_when_empty) return 0;
  return Math.max(0, Math.round((num(s, "recruit_cost") * (100 + b.recruitPct)) / 100));
}

// --- Prices -----------------------------------------------------------------

export function augmentPrice(a: AugmentDef, s: SettingsMap): number {
  return num(s, `aug_price_${a.id}`, a.price);
}

export function researchCost(r: ResearchDef, s: SettingsMap): { credits: number; rp: number; intel: number } {
  return {
    credits: num(s, `rd_${r.id}_credits`, r.cost.credits),
    rp: num(s, `rd_${r.id}_rp`, r.cost.rp),
    intel: num(s, `rd_${r.id}_intel`, r.cost.intel),
  };
}

export function augmentUnlocked(a: AugmentDef, research: ReadonlySet<string>): boolean {
  return !a.requires || research.has(a.requires);
}

export type Check = { ok: true } | { ok: false; reason: string };

export function canResearch(
  id: string,
  done: ReadonlySet<string>,
  wallet: { credits: number; research_points: number; intel: number },
  s: SettingsMap,
): Check {
  const r = RESEARCH_BY_ID.get(id);
  if (!r) return { ok: false, reason: "Unknown project" };
  if (done.has(id)) return { ok: false, reason: "Already researched" };
  const missing = r.requires.filter((p) => !done.has(p));
  if (missing.length) return { ok: false, reason: `Requires ${missing.map((m) => RESEARCH_BY_ID.get(m)?.name ?? m).join(", ")}` };
  const c = researchCost(r, s);
  if (wallet.credits < c.credits) return { ok: false, reason: "Not enough credits" };
  if (wallet.research_points < c.rp) return { ok: false, reason: "Not enough research points" };
  if (wallet.intel < c.intel) return { ok: false, reason: "Not enough intel" };
  return { ok: true };
}

export function canInstall(agent: Pick<CorpAgent, "dead" | "implants">, augId: string, research: ReadonlySet<string>, credits: number, s: SettingsMap): Check {
  const a = AUGMENTS_BY_ID.get(augId);
  if (!a) return { ok: false, reason: "Unknown augment" };
  if (agent.dead) return { ok: false, reason: "Agent is dead" };
  if (!augmentUnlocked(a, research)) return { ok: false, reason: `Requires ${RESEARCH_BY_ID.get(a.requires!)?.name ?? a.requires}` };
  if (agent.implants[a.slot] === a.id) return { ok: false, reason: "Already installed" };
  if (credits < augmentPrice(a, s)) return { ok: false, reason: "Not enough credits" };
  return { ok: true };
}

// --- XP and levels ----------------------------------------------------------

/** Total XP needed to reach `level` (level 1 needs 0). */
export function xpForLevel(level: number, s: SettingsMap): number {
  const base = num(s, "xp_level_base", 100);
  const growth = num(s, "xp_level_growth", 1.4);
  let total = 0;
  for (let l = 1; l < level; l++) total += Math.round(base * growth ** (l - 1));
  return total;
}

export function levelForXp(xp: number, s: SettingsMap): number {
  const max = Math.max(1, num(s, "agent_max_level", 10));
  let level = 1;
  while (level < max && xp >= xpForLevel(level + 1, s)) level++;
  return level;
}

export function xpGain(
  r: { survived: boolean; won: boolean; stealth: boolean; kills: number },
  s: SettingsMap,
  b: Bonuses,
): number {
  const kills = Math.max(0, Math.min(Math.floor(r.kills) || 0, num(s, "max_kills_per_mission", 30)));
  let xp = kills * num(s, "xp_per_kill");
  if (r.survived) {
    xp += num(s, "xp_per_mission");
    if (r.won) xp += num(s, "xp_win_bonus");
    if (r.won && r.stealth) xp += num(s, "xp_stealth_bonus");
  }
  return Math.max(0, Math.round((xp * (100 + b.xpPct)) / 100));
}

// --- Injuries ---------------------------------------------------------------

/** Minutes out of action after a mission, or 0 if fit. */
export function injuryMinutes(r: { survived: boolean; hpPct: number }, s: SettingsMap, b: Bonuses): number {
  let m = 0;
  if (!r.survived) m = num(s, "injury_minutes_downed");
  else if (r.hpPct < num(s, "injury_wounded_threshold_pct")) m = num(s, "injury_minutes_wounded");
  return Math.max(0, Math.round((m * Math.max(0, 100 + b.injuryPct)) / 100));
}

export function healCost(injuredUntil: number, now: number, s: SettingsMap): number {
  const minutes = Math.ceil(Math.max(0, injuredUntil - now) / 60000);
  return minutes * num(s, "heal_cost_per_minute");
}

// --- Stats ------------------------------------------------------------------

export interface AgentStats {
  hp: number;
  speed: number;
  damageMul: number;
  stealthMul: number;
}

export function implantMods(implants: Implants): Required<{ hp: number; speedPct: number; damagePct: number; stealthPct: number }> {
  const m = { hp: 0, speedPct: 0, damagePct: 0, stealthPct: 0 };
  for (const slot of SLOTS) {
    const id = implants[slot];
    const a = id ? AUGMENTS_BY_ID.get(id) : undefined;
    if (!a || a.slot !== slot) continue;
    m.hp += a.mods.hp ?? 0;
    m.speedPct += a.mods.speedPct ?? 0;
    m.damagePct += a.mods.damagePct ?? 0;
    m.stealthPct += a.mods.stealthPct ?? 0;
  }
  return m;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Mission stats for an agent: class × level × implants, all from settings. */
export function agentStats(a: Pick<CorpAgent, "cls" | "level" | "implants">, s: SettingsMap): AgentStats {
  const pct = (stat: string) => num(s, `class_${a.cls}_${stat}_pct`, 100) / 100;
  const lv = Math.max(0, a.level - 1);
  const m = implantMods(a.implants);
  const hp = num(s, "agent_hp", 100) * pct("hp") * (1 + (lv * num(s, "level_hp_pct")) / 100) + m.hp;
  const speed = num(s, "agent_speed", 3.2) * pct("speed") * (1 + m.speedPct / 100);
  const damageMul = pct("damage") * (1 + (lv * num(s, "level_damage_pct")) / 100) * (1 + m.damagePct / 100);
  const stealthMul = pct("stealth") * (1 + m.stealthPct / 100);
  return {
    hp: Math.max(1, Math.round(hp)),
    speed: round2(Math.max(0.5, speed)),
    damageMul: round2(Math.max(0.1, damageMul)),
    stealthMul: round2(Math.max(0.1, stealthMul)),
  };
}

// --- Rewards ----------------------------------------------------------------

export interface MissionRewards {
  credits: number;
  rp: number;
  intel: number;
}

/**
 * Rewards for a successful contract. `baseCredits` is the core missionReward()
 * (per-type base + stealth bonus); R&D and first-clear bonuses stack on top.
 */
export function contractRewards(type: string, baseCredits: number, firstClear: boolean, s: SettingsMap, b: Bonuses): MissionRewards {
  const first = firstClear ? num(s, "first_clear_bonus_pct") : 0;
  const scale = (v: number, pct: number) => Math.max(0, Math.round((v * (100 + pct) * (100 + first)) / 10000));
  return {
    credits: scale(baseCredits, b.creditPct),
    rp: scale(num(s, `reward_rp_${type}`), b.rpPct),
    intel: scale(num(s, `reward_intel_${type}`), b.intelPct),
  };
}

// --- Cosmetics --------------------------------------------------------------

/** Skins usable in the loadout picker for a set of entitlements. */
export function availableSkins(entitlements: readonly string[]): string[] {
  const out = ["default"];
  for (const e of entitlements) if (e.startsWith("skin:") && e.length > 5) out.push(e.slice(5));
  if (entitlements.includes("supporter")) out.push("founder");
  return [...new Set(out)];
}
