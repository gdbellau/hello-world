import type { AgentStatus, CorpState } from "../../shared/corp";
import { defaultSettings, type MissionType, type SettingsMap } from "../../shared/settings";

const TOKEN_KEY = "cabal.token";

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // Private mode etc. The player just gets a fresh corp next visit.
  }
}

let token = loadToken();
/** Replaces the session token (account sign-in/out). Callers reload afterwards. */
export function setToken(t: string): void { token = t; saveToken(t); }
/** False when the API is unreachable (e.g. `vite dev` without the Worker). */
export let online = true;

/** Authenticated JSON call to the game API. Reuse this from other client modules. */
export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as T;
}

export async function loadConfig(): Promise<SettingsMap> {
  try {
    return { ...defaultSettings(), ...(await call<SettingsMap>("/api/config")) };
  } catch {
    online = false;
    return defaultSettings();
  }
}

export interface Me {
  id: string;
  corp_name: string;
  credits: number;
  entitlements: string[];
}

export async function startSession(): Promise<Me | null> {
  if (!online) return null;
  try {
    const s = await call<{ token: string }>("/api/session", { method: "POST", body: JSON.stringify({ token }) });
    token = s.token;
    saveToken(s.token);
    return await call<Me>("/api/me");
  } catch {
    online = false;
    return null;
  }
}

export async function startMission(missionId: string, missionType: MissionType): Promise<string | null> {
  if (!online) return null;
  try {
    return (await call<{ runId: string }>("/api/missions/start", { method: "POST", body: JSON.stringify({ missionId, missionType }) })).runId;
  } catch {
    return null;
  }
}

export async function completeMission(
  runId: string,
  outcome: "win" | "loss" | "abort",
  stealth: boolean,
): Promise<{ outcome: string; reward: number; stealth: boolean } | null> {
  try {
    return await call("/api/missions/complete", { method: "POST", body: JSON.stringify({ runId, outcome, stealth }) });
  } catch {
    return null;
  }
}

// --- Corp meta-game ---------------------------------------------------------

export type { CorpState } from "../../shared/corp";

/** Refreshes the player profile (entitlements can change after a purchase). */
export async function getMe(): Promise<Me | null> {
  if (!online) return null;
  try {
    return await call<Me>("/api/me");
  } catch {
    return null;
  }
}

/** Corp state; seeds the starting roster on first call. Null when offline. */
export async function getCorp(): Promise<CorpState | null> {
  if (!online) return null;
  try {
    return await call<CorpState>("/api/corp");
  } catch {
    return null;
  }
}

/** Corp mutation. Throws an Error with the server's message on rejection. */
async function corpPost<T = CorpState>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export const renameCorp = (name: string) => corpPost("/api/corp/name", { name });
export const recruitAgent = (cls?: string) => corpPost<CorpState & { recruited: string }>("/api/corp/recruit", { cls });
export const dismissAgent = (agentId: string) => corpPost("/api/corp/dismiss", { agentId });
export const healAgent = (agentId: string) => corpPost("/api/corp/heal", { agentId });
export const installAugment = (agentId: string, augmentId: string) => corpPost("/api/corp/augment", { agentId, augmentId });
export const removeAugment = (agentId: string, slot: string) => corpPost("/api/corp/augment/remove", { agentId, slot });
export const startResearch = (projectId: string) => corpPost("/api/corp/research", { projectId });

/** Starts a run with a squad. Throws with the server's reason (locked contract, injured agent...). */
export async function startRun(missionId: string, agentIds: string[]): Promise<string> {
  return (await corpPost<{ runId: string }>("/api/missions/start", { missionId, agentIds })).runId;
}

export interface AgentRunResult {
  id: string;
  survived: boolean;
  kills: number;
  hpPct: number;
}

export interface RunResult {
  outcome: "win" | "loss" | "abort";
  reward: number;
  rp: number;
  intel: number;
  stealth: boolean;
  firstClear: boolean;
  agents: {
    id: string;
    name: string;
    survived: boolean;
    kills: number;
    xp_gained: number;
    level: number;
    leveled_up: boolean;
    status: AgentStatus;
    injured_until: number;
  }[];
  corp: CorpState;
}

/** Reports a run with per-agent results. Null if the server couldn't be reached. */
export async function completeRun(
  runId: string,
  outcome: "win" | "loss" | "abort",
  stealth: boolean,
  agents: AgentRunResult[],
): Promise<RunResult | null> {
  try {
    return await corpPost<RunResult>("/api/missions/complete", { runId, outcome, stealth, agents });
  } catch {
    return null;
  }
}
