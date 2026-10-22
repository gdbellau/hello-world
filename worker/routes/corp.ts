// Corp meta-game: HQ state, roster, recruitment, augments, R&D.
// All corp state lives in D1 and only changes through these endpoints.
import {
  AGENT_CLASSES,
  AUGMENTS_BY_ID,
  RESEARCH_BY_ID,
  SLOTS,
  agentStatus,
  canInstall,
  canResearch,
  corpBonuses,
  generateCallsign,
  generateFullName,
  healCost,
  recruitCost,
  researchCost,
  rosterCap,
  augmentPrice,
  type AgentClass,
  type CorpAgent,
  type CorpState,
  type Implants,
  type Slot,
} from "../../shared/corp";
import type { SettingsMap } from "../../shared/settings";
import { requirePlayer } from "../auth";
import type { Env } from "../env";
import { bumpStat, loadSettings, nowMs } from "../db";
import { HttpError, json, readJson } from "../http";
import type { Route } from "../router";

interface AgentRow {
  id: string;
  name: string;
  full_name: string;
  cls: string;
  level: number;
  xp: number;
  implants: string;
  injured_until: number;
  dead: number;
  kills: number;
  missions: number;
}

const AGENT_COLS = "id, name, full_name, cls, level, xp, implants, injured_until, dead, kills, missions";

function parseImplants(raw: string): Implants {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Implants = {};
    for (const slot of SLOTS) if (typeof o[slot] === "string") out[slot] = o[slot] as string;
    return out;
  } catch {
    return {};
  }
}

/** Canonical JSON (slot order) so optimistic `implants = ?` checks are reliable. */
export function serializeImplants(imp: Implants): string {
  const out: Implants = {};
  for (const slot of SLOTS) if (imp[slot]) out[slot] = imp[slot];
  return JSON.stringify(out);
}

export function toAgent(r: AgentRow): CorpAgent {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    cls: (AGENT_CLASSES as readonly string[]).includes(r.cls) ? (r.cls as AgentClass) : "ghost",
    level: r.level,
    xp: r.xp,
    implants: parseImplants(r.implants),
    injured_until: r.injured_until,
    dead: r.dead === 1,
    kills: r.kills,
    missions: r.missions,
  };
}

/** Agents for a player (living first, then the most recent dead as a memorial wall). */
export async function loadAgents(env: Env, playerId: string): Promise<CorpAgent[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${AGENT_COLS} FROM agents WHERE player_id = ?1 ORDER BY dead ASC, created_at ASC LIMIT 60`,
  ).bind(playerId).all<AgentRow>();
  return results.map(toAgent);
}

export async function loadAgent(env: Env, playerId: string, agentId: unknown): Promise<CorpAgent> {
  if (typeof agentId !== "string" || agentId.length > 64) throw new HttpError(400, "Bad agent id");
  const r = await env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?1 AND player_id = ?2`).bind(agentId, playerId).first<AgentRow>();
  if (!r) throw new HttpError(404, "Agent not found");
  return toAgent(r);
}

export async function loadResearch(env: Env, playerId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT project FROM research WHERE player_id = ?1").bind(playerId).all<{ project: string }>();
  return new Set(results.map((r) => r.project));
}

export async function loadCleared(env: Env, playerId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT r.mission_id FROM mission_runs r JOIN players p ON p.id = r.player_id
     WHERE r.player_id = ?1 AND r.outcome = 'win' AND r.started_at >= p.progress_reset_at`,
  ).bind(playerId).all<{ mission_id: string }>();
  return new Set(results.map((r) => r.mission_id));
}

interface Wallet {
  corp_name: string;
  credits: number;
  research_points: number;
  intel: number;
  roster_seeded: number;
}

async function loadWallet(env: Env, playerId: string): Promise<Wallet> {
  const w = await env.DB.prepare(
    "SELECT corp_name, credits, research_points, intel, roster_seeded FROM players WHERE id = ?1",
  ).bind(playerId).first<Wallet>();
  if (!w) throw new HttpError(401, "Unknown player");
  return w;
}

function newAgentInsert(env: Env, playerId: string, cls: AgentClass, taken: string[], now: number) {
  const id = crypto.randomUUID();
  const name = generateCallsign(Math.random, taken);
  taken.push(name);
  return {
    id,
    name,
    stmt: (guardSql = "", ...guardArgs: unknown[]) =>
      env.DB.prepare(
        `INSERT INTO agents (id, player_id, name, full_name, cls, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 ${guardSql}`,
      ).bind(id, playerId, name, generateFullName(Math.random), cls, now, ...guardArgs),
  };
}

/** Issues the starting roster once per corp. Idempotent under concurrent calls. */
async function seedRoster(env: Env, playerId: string, s: SettingsMap): Promise<void> {
  const n = Number(s.starting_agents);
  const taken: string[] = [];
  const now = nowMs();
  const guard = "WHERE (SELECT roster_seeded FROM players WHERE id = ?7) = 0";
  const inserts = Array.from({ length: n }, (_, i) => newAgentInsert(env, playerId, AGENT_CLASSES[i % AGENT_CLASSES.length]!, taken, now).stmt(guard, playerId));
  await env.DB.batch([
    ...inserts,
    env.DB.prepare("UPDATE players SET roster_seeded = 1 WHERE id = ?1").bind(playerId),
  ]);
}

export async function loadCorpState(env: Env, playerId: string, s: SettingsMap): Promise<CorpState> {
  let w = await loadWallet(env, playerId);
  if (!w.roster_seeded) {
    await seedRoster(env, playerId, s);
    w = { ...w, roster_seeded: 1 };
  }
  const [agents, research, cleared] = await Promise.all([loadAgents(env, playerId), loadResearch(env, playerId), loadCleared(env, playerId)]);
  return {
    corp_name: w.corp_name,
    credits: w.credits,
    research_points: w.research_points,
    intel: w.intel,
    agents,
    research: [...research],
    cleared: [...cleared],
    now: nowMs(),
  };
}

/** Atomically debits the player if they can afford it. */
async function spend(env: Env, playerId: string, c: { credits?: number; rp?: number; intel?: number }): Promise<boolean> {
  const credits = c.credits ?? 0;
  const rp = c.rp ?? 0;
  const intel = c.intel ?? 0;
  const r = await env.DB.prepare(
    `UPDATE players SET credits = credits - ?1, research_points = research_points - ?2, intel = intel - ?3
     WHERE id = ?4 AND credits >= ?1 AND research_points >= ?2 AND intel >= ?3`,
  ).bind(credits, rp, intel, playerId).run();
  return r.meta.changes > 0;
}

function refund(env: Env, playerId: string, c: { credits?: number; rp?: number; intel?: number }): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE players SET credits = credits + ?1, research_points = research_points + ?2, intel = intel + ?3 WHERE id = ?4",
  ).bind(c.credits ?? 0, c.rp ?? 0, c.intel ?? 0, playerId);
}

async function ctxFor(req: Request, env: Env) {
  const id = await requirePlayer(req, env);
  const s = await loadSettings(env);
  return { id, s };
}

export const corpRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/corp",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      return json(await loadCorpState(env, id, s));
    },
  },
  {
    method: "POST",
    path: "/api/corp/name",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ name?: unknown }>(req);
      const name = typeof body.name === "string" ? body.name.replace(/[^\p{L}\p{N} .&'-]/gu, "").trim() : "";
      if (name.length < 2 || name.length > 32) throw new HttpError(400, "Corp name must be 2-32 letters, digits or spaces");
      await env.DB.prepare("UPDATE players SET corp_name = ?1 WHERE id = ?2").bind(name, id).run();
      return json(await loadCorpState(env, id, s));
    },
  },
  {
    method: "POST",
    path: "/api/corp/recruit",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ cls?: unknown }>(req).catch(() => ({}) as { cls?: unknown });
      let cls: AgentClass;
      if (body.cls === undefined || body.cls === null || body.cls === "") cls = AGENT_CLASSES[Math.floor(Math.random() * AGENT_CLASSES.length)]!;
      else if ((AGENT_CLASSES as readonly unknown[]).includes(body.cls)) cls = body.cls as AgentClass;
      else throw new HttpError(400, "Bad class");

      const state = await loadCorpState(env, id, s);
      const living = state.agents.filter((a) => !a.dead);
      const b = corpBonuses(state.research);
      const cap = rosterCap(s, b);
      if (living.length >= cap) throw new HttpError(409, `Roster is full (${cap} agents)`);
      const cost = recruitCost(s, b, living.length);
      if (state.credits < cost) throw new HttpError(409, "Not enough credits");
      if (!(await spend(env, id, { credits: cost }))) throw new HttpError(409, "Not enough credits");

      const ins = newAgentInsert(env, id, cls, state.agents.map((a) => a.name), nowMs());
      const [r] = await env.DB.batch([
        ins.stmt("WHERE (SELECT COUNT(*) FROM agents WHERE player_id = ?2 AND dead = 0) < ?7", cap),
        bumpStat(env, "agents_recruited"),
        bumpStat(env, "credits_spent", cost),
      ]);
      if (!r!.meta.changes) {
        await refund(env, id, { credits: cost }).run();
        throw new HttpError(409, `Roster is full (${cap} agents)`);
      }
      return json({ ...(await loadCorpState(env, id, s)), recruited: ins.id });
    },
  },
  {
    method: "POST",
    path: "/api/corp/dismiss",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ agentId?: unknown }>(req);
      const agent = await loadAgent(env, id, body.agentId);
      if (agent.dead) throw new HttpError(409, "Agent is already dead");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM agents WHERE id = ?1 AND player_id = ?2").bind(agent.id, id),
        bumpStat(env, "agents_dismissed"),
      ]);
      return json(await loadCorpState(env, id, s));
    },
  },
  {
    method: "POST",
    path: "/api/corp/heal",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ agentId?: unknown }>(req);
      const agent = await loadAgent(env, id, body.agentId);
      const now = nowMs();
      if (agentStatus(agent, now) !== "injured") throw new HttpError(409, "Agent is not injured");
      const cost = healCost(agent.injured_until, now, s);
      if (!(await spend(env, id, { credits: cost }))) throw new HttpError(409, "Not enough credits");
      const [r] = await env.DB.batch([
        env.DB.prepare("UPDATE agents SET injured_until = 0 WHERE id = ?1 AND player_id = ?2 AND dead = 0 AND injured_until = ?3").bind(
          agent.id,
          id,
          agent.injured_until,
        ),
        bumpStat(env, "agents_healed"),
        bumpStat(env, "credits_spent", cost),
      ]);
      if (!r!.meta.changes) {
        await refund(env, id, { credits: cost }).run();
        throw new HttpError(409, "Agent changed, try again");
      }
      return json(await loadCorpState(env, id, s));
    },
  },
  {
    method: "POST",
    path: "/api/corp/augment",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ agentId?: unknown; augmentId?: unknown }>(req);
      const aug = typeof body.augmentId === "string" ? AUGMENTS_BY_ID.get(body.augmentId) : undefined;
      if (!aug) throw new HttpError(400, "Unknown augment");
      const [agent, research, wallet] = await Promise.all([loadAgent(env, id, body.agentId), loadResearch(env, id), loadWallet(env, id)]);
      const check = canInstall(agent, aug.id, research, wallet.credits, s);
      if (!check.ok) throw new HttpError(409, check.reason);
      const price = augmentPrice(aug, s);
      if (!(await spend(env, id, { credits: price }))) throw new HttpError(409, "Not enough credits");
      const oldJson = serializeImplants(agent.implants);
      const next = serializeImplants({ ...agent.implants, [aug.slot]: aug.id });
      const [r] = await env.DB.batch([
        // Optimistic: only apply over the implants we validated against.
        env.DB.prepare("UPDATE agents SET implants = ?1 WHERE id = ?2 AND player_id = ?3 AND dead = 0 AND implants = ?4").bind(next, agent.id, id, oldJson),
        bumpStat(env, "augments_bought"),
        bumpStat(env, `augment_${aug.id}`),
        bumpStat(env, "credits_spent", price),
      ]);
      if (!r!.meta.changes) {
        await refund(env, id, { credits: price }).run();
        throw new HttpError(409, "Agent changed, try again");
      }
      return json(await loadCorpState(env, id, s));
    },
  },
  {
    method: "POST",
    path: "/api/corp/augment/remove",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ agentId?: unknown; slot?: unknown }>(req);
      if (!(SLOTS as readonly unknown[]).includes(body.slot)) throw new HttpError(400, "Bad slot");
      const agent = await loadAgent(env, id, body.agentId);
      if (agent.dead) throw new HttpError(409, "Agent is dead");
      const next = { ...agent.implants };
      if (!next[body.slot as Slot]) throw new HttpError(409, "Slot is empty");
      delete next[body.slot as Slot];
      await env.DB.prepare("UPDATE agents SET implants = ?1 WHERE id = ?2 AND player_id = ?3").bind(serializeImplants(next), agent.id, id).run();
      return json(await loadCorpState(env, id, s));
    },
  },
  {
    method: "POST",
    path: "/api/corp/research",
    async handler({ req, env }) {
      const { id, s } = await ctxFor(req, env);
      const body = await readJson<{ projectId?: unknown }>(req);
      const project = typeof body.projectId === "string" ? RESEARCH_BY_ID.get(body.projectId) : undefined;
      if (!project) throw new HttpError(400, "Unknown project");
      const [research, wallet] = await Promise.all([loadResearch(env, id), loadWallet(env, id)]);
      const check = canResearch(project.id, research, wallet, s);
      if (!check.ok) throw new HttpError(409, check.reason);
      const c = researchCost(project, s);
      const cost = { credits: c.credits, rp: c.rp, intel: c.intel };
      if (!(await spend(env, id, cost))) throw new HttpError(409, "Not enough resources");
      const [r] = await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO research (player_id, project, completed_at) VALUES (?1, ?2, ?3)").bind(id, project.id, nowMs()),
        bumpStat(env, "research_completed"),
        bumpStat(env, `research_${project.id}`),
        bumpStat(env, "credits_spent", c.credits),
      ]);
      if (!r!.meta.changes) {
        await refund(env, id, cost).run();
        throw new HttpError(409, "Already researched");
      }
      return json(await loadCorpState(env, id, s));
    },
  },
];
