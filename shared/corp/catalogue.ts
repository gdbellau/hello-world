// Corp meta-game catalogue: agent classes, cyberware and the R&D tree.
// Structure and stat modifiers live here; prices and research costs are
// exposed as settings (see shared/settings/corp.ts) so the admin panel can
// tune them live. The numbers below are only the defaults for those settings.

/**
 * Mission types that get their own research-point / intel reward settings.
 * Kept here (not imported from shared/settings) to avoid an import cycle;
 * unknown types fall back to 0 RP / 0 intel.
 */
export const REWARD_MISSION_TYPES = ["assassination", "espionage", "research"] as const;

export type AgentClass = "ghost" | "razor" | "decker" | "bruiser";
export const AGENT_CLASSES: readonly AgentClass[] = ["ghost", "razor", "decker", "bruiser"];

export interface ClassDef {
  id: AgentClass;
  name: string;
  role: string;
  /** Defaults (percent of base) for the per-class settings. */
  hpPct: number;
  speedPct: number;
  damagePct: number;
  stealthPct: number;
}

export const CLASSES: Record<AgentClass, ClassDef> = {
  ghost: { id: "ghost", name: "Ghost", role: "Stealth and infiltration. Hard to spot, fragile in a firefight.", hpPct: 85, speedPct: 105, damagePct: 90, stealthPct: 140 },
  razor: { id: "razor", name: "Razor", role: "Melee assassin. Fast, lethal up close.", hpPct: 95, speedPct: 115, damagePct: 125, stealthPct: 110 },
  decker: { id: "decker", name: "Decker", role: "Netrunner. Breaches ICE and terminals, light on armour.", hpPct: 80, speedPct: 100, damagePct: 85, stealthPct: 115 },
  bruiser: { id: "bruiser", name: "Bruiser", role: "Heavy weapons tank. Soaks fire, loud.", hpPct: 140, speedPct: 85, damagePct: 120, stealthPct: 75 },
};

export type Slot = "head" | "torso" | "arms" | "legs";
export const SLOTS: readonly Slot[] = ["head", "torso", "arms", "legs"];

/** Stat modifiers an implant applies. hp is flat; the rest are percentages. */
export interface StatMods {
  hp?: number;
  speedPct?: number;
  damagePct?: number;
  stealthPct?: number;
}

export interface AugmentDef {
  id: string;
  name: string;
  slot: Slot;
  desc: string;
  mods: StatMods;
  /** Default price in credits (setting `aug_price_<id>`). */
  price: number;
  /** Research project that unlocks this augment. */
  requires?: string;
}

export const AUGMENTS: readonly AugmentDef[] = [
  // Head
  { id: "targeting_optics", name: "Targeting Optics", slot: "head", desc: "Ballistic overlay paints weak points on every target.", mods: { damagePct: 15 }, price: 1200 },
  { id: "neural_deck", name: "Neural Deck", slot: "head", desc: "Wetware co-processor. Faster threat parsing, quieter movement.", mods: { damagePct: 8, stealthPct: 12 }, price: 2400, requires: "neuroware" },
  { id: "ghost_link", name: "Ghost-Link Cortex", slot: "head", desc: "Spoofs nearby optic feeds. Guards look straight through you.", mods: { stealthPct: 30 }, price: 4800, requires: "ghost_protocol" },
  // Torso
  { id: "dermal_plating", name: "Dermal Plating", slot: "torso", desc: "Ceramic plates under the skin. Stops small-arms fire, clanks a little.", mods: { hp: 30, stealthPct: -5 }, price: 1000 },
  { id: "subdermal_weave", name: "Subdermal Weave", slot: "torso", desc: "Monofilament mesh woven through the muscle. Heavy but resilient.", mods: { hp: 60, speedPct: -5 }, price: 2600, requires: "subdermal" },
  { id: "optical_camo", name: "Optical Camo", slot: "torso", desc: "Metamaterial skin bends light around the wearer.", mods: { stealthPct: 35, hp: -10 }, price: 5200, requires: "metamaterials" },
  // Arms
  { id: "smartlink_grip", name: "Smart-link Grip", slot: "arms", desc: "Palm interface syncs with any smart weapon.", mods: { damagePct: 10 }, price: 900 },
  { id: "mantis_blades", name: "Mantis Blades", slot: "arms", desc: "Forearm-mounted monoblades. Silent and very final.", mods: { damagePct: 30, stealthPct: 5 }, price: 3400, requires: "combat_cyberware" },
  { id: "gorilla_arms", name: "Gorilla Arms", slot: "arms", desc: "Hydraulic limb replacements. Punch through doors and people.", mods: { damagePct: 20, hp: 15 }, price: 3000, requires: "combat_cyberware" },
  // Legs
  { id: "synthetic_muscles", name: "Synthetic Muscles", slot: "legs", desc: "Lab-grown myomer fibres. More stride per step.", mods: { speedPct: 10 }, price: 1100 },
  { id: "kinetic_tendons", name: "Kinetic Tendons", slot: "legs", desc: "Spring-loaded tendons with dampers for silent landings.", mods: { speedPct: 18, stealthPct: 5 }, price: 2800, requires: "myomer" },
  { id: "reflex_booster", name: "Reflex Booster", slot: "legs", desc: "Spinal accelerator. Everyone else moves in slow motion.", mods: { speedPct: 25, damagePct: 10 }, price: 5000, requires: "reflex_overclock" },
];

export const AUGMENTS_BY_ID: ReadonlyMap<string, AugmentDef> = new Map(AUGMENTS.map((a) => [a.id, a]));

/** Corp-wide bonuses granted by completed research. All additive. */
export interface ResearchEffects {
  squadSize?: number;
  rosterCap?: number;
  creditPct?: number;
  rpPct?: number;
  intelPct?: number;
  xpPct?: number;
  /** Negative shortens injuries. */
  injuryPct?: number;
  /** Negative discounts recruitment. */
  recruitPct?: number;
}

export type Branch = "cyberware" | "operations" | "finance";
export const BRANCHES: readonly { id: Branch; name: string }[] = [
  { id: "cyberware", name: "Cyberware" },
  { id: "operations", name: "Operations" },
  { id: "finance", name: "Finance & Intel" },
];

export interface ResearchDef {
  id: string;
  name: string;
  branch: Branch;
  desc: string;
  requires: string[];
  /** Defaults for settings `rd_<id>_credits`, `rd_<id>_rp`, `rd_<id>_intel`. */
  cost: { credits: number; rp: number; intel: number };
  effects?: ResearchEffects;
}

export const RESEARCH: readonly ResearchDef[] = [
  // Cyberware
  { id: "neuroware", name: "Neural Interfaces", branch: "cyberware", desc: "Unlocks the Neural Deck.", requires: [], cost: { credits: 1500, rp: 20, intel: 0 } },
  { id: "combat_cyberware", name: "Combat Cyberware", branch: "cyberware", desc: "Unlocks Mantis Blades and Gorilla Arms.", requires: [], cost: { credits: 2000, rp: 25, intel: 0 } },
  { id: "myomer", name: "Myomer Synthesis", branch: "cyberware", desc: "Unlocks Kinetic Tendons.", requires: [], cost: { credits: 1500, rp: 20, intel: 0 } },
  { id: "subdermal", name: "Subdermal Weave", branch: "cyberware", desc: "Unlocks Subdermal Weave armour.", requires: ["combat_cyberware"], cost: { credits: 2500, rp: 35, intel: 0 } },
  { id: "metamaterials", name: "Metamaterials", branch: "cyberware", desc: "Unlocks Optical Camo.", requires: ["neuroware", "subdermal"], cost: { credits: 4000, rp: 60, intel: 10 } },
  { id: "ghost_protocol", name: "Ghost Protocol", branch: "cyberware", desc: "Unlocks the Ghost-Link Cortex.", requires: ["neuroware"], cost: { credits: 4000, rp: 50, intel: 25 } },
  { id: "reflex_overclock", name: "Reflex Overclock", branch: "cyberware", desc: "Unlocks the Reflex Booster.", requires: ["myomer"], cost: { credits: 4500, rp: 60, intel: 0 } },
  // Operations
  { id: "trauma_center", name: "Trauma Center", branch: "operations", desc: "In-house surgeons. Injuries heal 50% faster.", requires: [], cost: { credits: 1800, rp: 15, intel: 0 }, effects: { injuryPct: -50 } },
  { id: "combat_sims", name: "Combat Simulators", branch: "operations", desc: "VR drills. Agents earn 50% more XP.", requires: [], cost: { credits: 2200, rp: 25, intel: 0 }, effects: { xpPct: 50 } },
  { id: "barracks", name: "Expanded Barracks", branch: "operations", desc: "Room for 4 more agents on the roster.", requires: [], cost: { credits: 3000, rp: 10, intel: 0 }, effects: { rosterCap: 4 } },
  { id: "tactical_doctrine", name: "Tactical Doctrine", branch: "operations", desc: "+1 agent per squad (where the map has room).", requires: ["combat_sims"], cost: { credits: 6000, rp: 80, intel: 20 }, effects: { squadSize: 1 } },
  // Finance & intel
  { id: "shell_companies", name: "Shell Companies", branch: "finance", desc: "Launder fees through offshore fronts. +20% contract credits.", requires: [], cost: { credits: 2500, rp: 10, intel: 10 }, effects: { creditPct: 20 } },
  { id: "headhunters", name: "Headhunter Network", branch: "finance", desc: "Recruitment costs 30% less.", requires: [], cost: { credits: 1500, rp: 5, intel: 5 }, effects: { recruitPct: -30 } },
  { id: "lab_network", name: "Black Lab Network", branch: "finance", desc: "Fence stolen research faster. +50% research points.", requires: ["shell_companies"], cost: { credits: 3500, rp: 30, intel: 15 }, effects: { rpPct: 50 } },
  { id: "data_brokers", name: "Data Brokers", branch: "finance", desc: "Resell what your deckers find. +50% intel.", requires: ["shell_companies"], cost: { credits: 3500, rp: 15, intel: 30 }, effects: { intelPct: 50 } },
];

export const RESEARCH_BY_ID: ReadonlyMap<string, ResearchDef> = new Map(RESEARCH.map((r) => [r.id, r]));
