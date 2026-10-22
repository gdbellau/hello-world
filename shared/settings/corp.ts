// Corp meta-game: recruitment, progression, injuries, rewards, classes,
// augment prices and R&D costs. Per-item keys are generated from the
// catalogue in shared/corp/catalogue.ts so new items appear automatically.
import { AGENT_CLASSES, AUGMENTS, CLASSES, RESEARCH } from "../corp/catalogue";
import { REWARD_MISSION_TYPES as MISSION_TYPES } from "../corp/catalogue";
import type { SettingDef } from "./types";

const ROSTER = "Corp: Roster";
const PROG = "Corp: Progression";
const INJ = "Corp: Injuries";
const REW = "Corp: Rewards";
const CLS = "Corp: Classes";
const AUG = "Corp: Augments";
const RD = "Corp: R&D";

const DEFAULT_RP: Record<string, number> = { assassination: 5, espionage: 5, research: 30 };
const DEFAULT_INTEL: Record<string, number> = { assassination: 5, espionage: 30, research: 5 };

export const CORP_SETTINGS: SettingDef[] = [
  // --- Roster --------------------------------------------------------------
  { key: "roster_max", category: ROSTER, label: "Roster cap", description: "Maximum living agents on a roster (before R&D bonuses).", type: "integer", default: 12, min: 1, max: 50, public: true },
  { key: "starting_agents", category: ROSTER, label: "Starting agents", description: "Agents a new corporation starts with (one per class, cycling).", type: "integer", default: 4, min: 1, max: 12, public: true },
  { key: "recruit_cost", category: ROSTER, label: "Recruit cost", description: "Credits to hire a new agent.", type: "integer", default: 1500, min: 0, max: 1000000, public: true },
  { key: "recruit_free_when_empty", category: ROSTER, label: "Free recruit when roster is empty", description: "Hiring is free while the corp has no living agents, so a wiped corp can't soft-lock.", type: "boolean", default: true, public: true },
  { key: "heal_cost_per_minute", category: ROSTER, label: "Rush treatment cost / minute", description: "Credits per remaining injury minute to put an agent back on duty immediately.", type: "integer", default: 20, min: 0, max: 100000, public: true },

  // --- Progression ---------------------------------------------------------
  { key: "xp_per_mission", category: PROG, label: "XP per mission", description: "XP for every surviving agent, win or lose.", type: "integer", default: 40, min: 0, max: 100000, public: true },
  { key: "xp_win_bonus", category: PROG, label: "XP win bonus", description: "Extra XP per surviving agent on a win.", type: "integer", default: 60, min: 0, max: 100000, public: true },
  { key: "xp_per_kill", category: PROG, label: "XP per kill", description: "XP per kill (takedowns included).", type: "integer", default: 15, min: 0, max: 100000, public: true },
  { key: "xp_stealth_bonus", category: PROG, label: "XP stealth bonus", description: "Extra XP per agent on a win with no alarm.", type: "integer", default: 30, min: 0, max: 100000, public: true },
  { key: "xp_level_base", category: PROG, label: "XP for level 2", description: "XP needed to go from level 1 to 2.", type: "integer", default: 100, min: 1, max: 100000, public: true },
  { key: "xp_level_growth", category: PROG, label: "XP growth per level", description: "Each further level needs this many times the previous one.", type: "number", default: 1.4, min: 1, max: 5, public: true },
  { key: "agent_max_level", category: PROG, label: "Max agent level", description: "Level cap.", type: "integer", default: 10, min: 1, max: 100, public: true },
  { key: "level_hp_pct", category: PROG, label: "HP per level %", description: "Extra max HP per level above 1.", type: "number", default: 5, min: 0, max: 100, public: true },
  { key: "level_damage_pct", category: PROG, label: "Damage per level %", description: "Extra weapon damage per level above 1.", type: "number", default: 3, min: 0, max: 100, public: true },
  { key: "max_kills_per_mission", category: PROG, label: "Max kills credited per agent", description: "Anti-cheat clamp on client-reported kills.", type: "integer", default: 30, min: 0, max: 1000, public: false },

  // --- Injuries ------------------------------------------------------------
  { key: "injury_minutes_downed", category: INJ, label: "Downed agent recovery (min)", description: "Recovery time for an agent taken down in a mission (when permadeath is off).", type: "integer", default: 30, min: 0, max: 10080, public: true },
  { key: "injury_minutes_wounded", category: INJ, label: "Wounded agent recovery (min)", description: "Recovery time for an agent that extracted badly hurt.", type: "integer", default: 10, min: 0, max: 10080, public: true },
  { key: "injury_wounded_threshold_pct", category: INJ, label: "Wounded threshold %", description: "Agents finishing below this % of max HP count as wounded.", type: "integer", default: 35, min: 0, max: 100, public: true },

  // --- Rewards -------------------------------------------------------------
  ...MISSION_TYPES.map<SettingDef>((t) => ({
    key: `reward_rp_${t}`, category: REW, label: `Research points: ${t}`, description: `Research points for a successful ${t} contract.`,
    type: "integer", default: DEFAULT_RP[t] ?? 5, min: 0, max: 100000, public: true,
  })),
  ...MISSION_TYPES.map<SettingDef>((t) => ({
    key: `reward_intel_${t}`, category: REW, label: `Intel: ${t}`, description: `Intel for a successful ${t} contract.`,
    type: "integer", default: DEFAULT_INTEL[t] ?? 5, min: 0, max: 100000, public: true,
  })),
  { key: "first_clear_bonus_pct", category: REW, label: "First clear bonus %", description: "Extra credits, research points and intel the first time a contract is completed.", type: "integer", default: 50, min: 0, max: 1000, public: true },

  // --- Classes -------------------------------------------------------------
  ...AGENT_CLASSES.flatMap<SettingDef>((c) => {
    const d = CLASSES[c];
    const mk = (stat: string, label: string, def: number): SettingDef => ({
      key: `class_${c}_${stat}_pct`, category: CLS, label: `${d.name}: ${label} %`, description: `${d.name} ${label.toLowerCase()} as a percentage of the base agent value.`,
      type: "integer", default: def, min: 10, max: 500, public: true,
    });
    return [mk("hp", "HP", d.hpPct), mk("speed", "Speed", d.speedPct), mk("damage", "Damage", d.damagePct), mk("stealth", "Stealth", d.stealthPct)];
  }),

  // --- Augment prices ------------------------------------------------------
  ...AUGMENTS.map<SettingDef>((a) => ({
    key: `aug_price_${a.id}`, category: AUG, label: `${a.name} price`, description: `Credits to buy and install ${a.name} (${a.slot}).`,
    type: "integer", default: a.price, min: 0, max: 10000000, public: true,
  })),

  // --- Research costs ------------------------------------------------------
  ...RESEARCH.flatMap<SettingDef>((r) => [
    { key: `rd_${r.id}_credits`, category: RD, label: `${r.name}: credits`, description: `Credit cost of ${r.name}.`, type: "integer", default: r.cost.credits, min: 0, max: 10000000, public: true },
    { key: `rd_${r.id}_rp`, category: RD, label: `${r.name}: research points`, description: `Research point cost of ${r.name}.`, type: "integer", default: r.cost.rp, min: 0, max: 100000, public: true },
    { key: `rd_${r.id}_intel`, category: RD, label: `${r.name}: intel`, description: `Intel cost of ${r.name}.`, type: "integer", default: r.cost.intel, min: 0, max: 100000, public: true },
  ]),
];
