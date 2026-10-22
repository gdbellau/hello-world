// World map flavour and campaign progression. Missions are listed generically
// (any number, any type): district and rival are derived from the mission id.

export interface Rival {
  id: string;
  name: string;
  colour: string;
}

export const RIVALS: readonly Rival[] = [
  { id: "vance", name: "Arasaka-Vance", colour: "#ff3b5c" },
  { id: "helix", name: "Helix Biomedica", colour: "#39ff8c" },
  { id: "orbital", name: "Orbital Dynamics", colour: "#00f0ff" },
  { id: "kuroi", name: "Kuroi Zaibatsu", colour: "#ffe14d" },
  { id: "meridian", name: "Meridian Logistics", colour: "#b388ff" },
  { id: "sable", name: "Sable Securities", colour: "#ff9f43" },
];

export interface District {
  id: string;
  name: string;
  rival: string;
  blurb: string;
}

export const DISTRICTS: readonly District[] = [
  { id: "neon-row", name: "Neon Row", rival: "vance", blurb: "Corporate towers and the bars that serve their staff." },
  { id: "kowloon-stack", name: "Kowloon Stack", rival: "kuroi", blurb: "Forty storeys of illegal clinics and data dens." },
  { id: "helix-campus", name: "Helix Campus", rival: "helix", blurb: "Sterile labs behind smart-glass and autoturrets." },
  { id: "port-meridian", name: "Port Meridian", rival: "meridian", blurb: "Automated docks. Containers go in, nobody asks." },
  { id: "the-lift", name: "The Lift", rival: "orbital", blurb: "Base of the orbital elevator. Highest security in the sprawl." },
  { id: "undercity", name: "The Undercity", rival: "sable", blurb: "Flooded transit tunnels run by private militias." },
];

export const rivalById = (id: string) => RIVALS.find((r) => r.id === id) ?? RIVALS[0]!;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Stable district for a mission: an explicit prefix match wins, else a hash. */
export function districtFor(missionId: string): District {
  const byPrefix = DISTRICTS.find((d) => missionId.startsWith(d.id));
  if (byPrefix) return byPrefix;
  if (missionId.startsWith("neon")) return DISTRICTS[0]!;
  return DISTRICTS[hash(missionId) % DISTRICTS.length]!;
}

export type ContractState = "locked" | "available" | "cleared";

/** Campaign order: the first mission is open, each later one needs the previous cleared. */
export function contractStates(orderedIds: readonly string[], cleared: ReadonlySet<string>): ContractState[] {
  return orderedIds.map((id, i) => {
    if (cleared.has(id)) return "cleared";
    if (i === 0 || cleared.has(orderedIds[i - 1]!)) return "available";
    return "locked";
  });
}

export function isUnlocked(orderedIds: readonly string[], missionId: string, cleared: ReadonlySet<string>): boolean {
  const i = orderedIds.indexOf(missionId);
  if (i < 0) return false;
  return i === 0 || cleared.has(missionId) || cleared.has(orderedIds[i - 1]!);
}
