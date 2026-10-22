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
/** False when the API is unreachable (e.g. `vite dev` without the Worker). */
export let online = true;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
