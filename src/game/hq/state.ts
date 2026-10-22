// Client-side view of the corp. The server is authoritative: every mutation
// goes through api.ts and the returned CorpState replaces ours wholesale.

import {
  AGENT_CLASSES,
  agentStats,
  availableSkins,
  corpBonuses,
  type AgentClass,
  type Bonuses,
  type CorpAgent,
  type CorpState,
} from "../../../shared/corp";
import type { SettingsMap } from "../../../shared/settings";
import { getCorp, getMe, online, type Me } from "../api";
import { sfx } from "../audio";
import { MISSION_SOURCES } from "../missions";
import type { MissionDef } from "../missions";
import { defaultLoadout, type AgentLoadout } from "../sim";
import { toast } from "./dom";

export interface LaunchRequest {
  mission: MissionDef;
  squad: AgentLoadout[];
  /** Roster ids in squad (= spawn) order. */
  agentIds: string[];
  runId: string | null;
}

export interface Store {
  cfg: SettingsMap;
  me: Me | null;
  corp: CorpState;
  offline: boolean;
  /** server clock − client clock, ms. */
  skew: number;
  launch: (req: LaunchRequest) => void;
}

export const S: Store = {
  cfg: {},
  me: null,
  corp: { corp_name: "", credits: 0, research_points: 0, intel: 0, agents: [], research: [], cleared: [], now: 0 },
  offline: true,
  skew: 0,
  launch: () => {},
};

export const serverNow = () => Date.now() + S.skew;
export const bonuses = (): Bonuses => corpBonuses(S.corp.research);
export const researched = () => new Set(S.corp.research);
export const livingAgents = () => S.corp.agents.filter((a) => !a.dead);

/** Offline: a local roster built from the Sim's default squad; nothing persists. */
function offlineCorp(cfg: SettingsMap): CorpState {
  const squad = defaultLoadout({ ...cfg, squad_size: 6 });
  return {
    corp_name: "OFFLINE CELL",
    credits: 0,
    research_points: 0,
    intel: 0,
    agents: squad.map((a, i) => ({
      id: `local-${i}`,
      name: a.name,
      full_name: "Unregistered operative",
      cls: (AGENT_CLASSES as readonly string[]).includes(a.cls) ? (a.cls as AgentClass) : "ghost",
      level: 1,
      xp: 0,
      implants: {},
      injured_until: 0,
      dead: false,
      kills: 0,
      missions: 0,
    })),
    research: [],
    cleared: [],
    now: Date.now(),
  };
}

export function setCorp(c: CorpState): void {
  S.corp = c;
  S.skew = c.now - Date.now();
}

export async function loadCorp(cfg: SettingsMap, me: Me | null): Promise<void> {
  S.cfg = cfg;
  S.me = me;
  const c = online && me ? await getCorp() : null;
  S.offline = !c;
  setCorp(c ?? offlineCorp(cfg));
}

export async function refreshMe(): Promise<void> {
  if (S.offline) return;
  const me = await getMe();
  if (me) S.me = me;
}

export const skins = () => availableSkins(S.me?.entitlements ?? []);

/**
 * Runs a server mutation: applies the returned state, plays feedback and
 * reports rejections (insufficient credits, locked research...) as a toast.
 */
export async function act(fn: () => Promise<CorpState>, okMsg: string, after?: () => void): Promise<boolean> {
  if (S.offline) {
    toast("Offline: corp operations need a connection.", "err");
    return false;
  }
  try {
    setCorp(await fn());
    sfx("purchase");
    toast(okMsg);
    after?.();
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : "Request failed", "err");
    return false;
  }
}

// --- Loadout ----------------------------------------------------------------

const SKIN_KEY = "cabal.skins";

function loadSkinPrefs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SKIN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function skinFor(agentId: string): string {
  const s = loadSkinPrefs()[agentId];
  return s && skins().includes(s) ? s : "default";
}

export function setSkin(agentId: string, skin: string): void {
  const prefs = loadSkinPrefs();
  prefs[agentId] = skin;
  try {
    localStorage.setItem(SKIN_KEY, JSON.stringify(prefs));
  } catch {
    // Cosmetic preference only.
  }
}

/** Turns a roster agent into the Sim's loadout (class × level × implants). */
export function toLoadout(a: CorpAgent): AgentLoadout {
  const st = agentStats(a, S.cfg);
  return { name: a.name, cls: a.cls, skin: skinFor(a.id), hp: st.hp, speed: st.speed, damageMul: st.damageMul, stealthMul: st.stealthMul };
}

export const missionIds = () => MISSION_SOURCES.map((m) => m.id);
