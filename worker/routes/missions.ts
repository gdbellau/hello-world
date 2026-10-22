import {
  agentStatus,
  contractRewards,
  corpBonuses,
  injuryMinutes,
  isUnlocked,
  levelForXp,
  squadCap,
  xpGain,
  type AgentStatus,
} from "../../shared/corp";
import { missionReward, type MissionType } from "../../shared/settings";
// Mission ids, types and campaign order come from the client mission registry
// (pure data, no DOM) so the server never trusts a client-supplied type.
import { MISSION_SOURCES } from "../../src/game/missions";
import { requirePlayer } from "../auth";
import { bumpStat, loadSettings, nowMs } from "../db";
import { HttpError, json, readJson } from "../http";
import type { Route } from "../router";
import { loadAgents, loadCleared, loadCorpState, loadResearch } from "./corp";

const MISSION_ORDER = MISSION_SOURCES.map((m) => m.id);

/** Agent spawn points in a mission's ASCII map; caps the squad server-side. */
const spawnCount = (ascii: string) => ascii.split("A").length - 1;

interface AgentResult {
  id: string;
  survived: boolean;
  kills: number;
  /** Remaining HP as a percentage of max (0-100). */
  hpPct: number;
}

export interface AgentDebrief {
  id: string;
  name: string;
  survived: boolean;
  kills: number;
  xp_gained: number;
  level: number;
  leveled_up: boolean;
  status: AgentStatus;
  injured_until: number;
}

function parseResults(raw: unknown): Map<string, AgentResult> {
  const out = new Map<string, AgentResult>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw.slice(0, 12)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    const kills = Number(o.kills);
    const hp = Number(o.hpPct);
    out.set(o.id, {
      id: o.id,
      survived: o.survived !== false,
      kills: Number.isFinite(kills) ? Math.max(0, Math.floor(kills)) : 0,
      hpPct: Number.isFinite(hp) ? Math.max(0, Math.min(100, hp)) : 100,
    });
  }
  return out;
}

export const missionRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/missions/start",
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const s = await loadSettings(env);
      if (s.maintenance_mode) throw new HttpError(503, "Maintenance in progress");
      const body = await readJson<{ missionId?: unknown; agentIds?: unknown }>(req);
      const src = MISSION_SOURCES.find((m) => m.id === body.missionId);
      if (!src) throw new HttpError(400, "Unknown mission");

      const [research, cleared, agents] = await Promise.all([loadResearch(env, id), loadCleared(env, id), loadAgents(env, id)]);
      if (!isUnlocked(MISSION_ORDER, src.id, cleared)) throw new HttpError(403, "Contract locked: clear the previous contract first");

      const ids = body.agentIds;
      if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "Pick a squad");
      if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate agent in squad");
      const cap = Math.min(squadCap(s, corpBonuses(research)), spawnCount(src.ascii) || Infinity);
      if (ids.length > cap) throw new HttpError(400, `Squad is limited to ${cap} agents`);
      const now = nowMs();
      for (const agentId of ids as string[]) {
        const a = agents.find((x) => x.id === agentId);
        if (!a) throw new HttpError(404, "Agent not found");
        const st = agentStatus(a, now);
        if (st === "dead") throw new HttpError(409, `${a.name} is dead`);
        if (st === "injured") throw new HttpError(409, `${a.name} is still recovering`);
      }

      const runId = crypto.randomUUID();
      await env.DB.batch([
        // One live run per player: anything left open (closed tab, crash) is voided.
        env.DB.prepare("UPDATE mission_runs SET ended_at = ?1, outcome = 'abort', reward = 0 WHERE player_id = ?2 AND ended_at IS NULL").bind(now, id),
        env.DB.prepare(
          "INSERT INTO mission_runs (id, player_id, mission_id, mission_type, started_at, squad) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        ).bind(runId, id, src.id, src.type, now, JSON.stringify(ids)),
        bumpStat(env, "missions_started"),
      ]);
      return json({ runId, missionType: src.type });
    },
  },
  {
    method: "POST",
    path: "/api/missions/complete",
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const body = await readJson<{ runId?: unknown; outcome?: unknown; stealth?: unknown; agents?: unknown }>(req);
      if (body.outcome !== "win" && body.outcome !== "loss" && body.outcome !== "abort") throw new HttpError(400, "Bad outcome");
      if (typeof body.runId !== "string") throw new HttpError(400, "Bad run id");
      const run = await env.DB.prepare(
        "SELECT mission_id, mission_type, started_at, squad FROM mission_runs WHERE id = ?1 AND player_id = ?2 AND ended_at IS NULL",
      ).bind(body.runId, id).first<{ mission_id: string; mission_type: MissionType; started_at: number; squad: string }>();
      if (!run) throw new HttpError(404, "Run not found or already completed");

      const s = await loadSettings(env);
      const end = nowMs();
      const seconds = (end - run.started_at) / 1000;
      let outcome: "win" | "loss" | "abort" = body.outcome;
      const implausible = outcome === "win" && seconds < Number(s.min_mission_seconds);
      if (implausible) outcome = "abort";
      const won = outcome === "win";
      const stealth = won && body.stealth === true;

      const [research, cleared, agents] = await Promise.all([loadResearch(env, id), loadCleared(env, id), loadAgents(env, id)]);
      const b = corpBonuses(research);
      const firstClear = won && !cleared.has(run.mission_id);
      const rewards = won
        ? contractRewards(run.mission_type, missionReward(run.mission_type, stealth, s), firstClear, s, b)
        : { credits: 0, rp: 0, intel: 0 };

      let squad: string[] = [];
      try {
        squad = (JSON.parse(run.squad) as unknown[]).filter((x): x is string => typeof x === "string");
      } catch {
        // Pre-corp run: no squad recorded.
      }
      const results = parseResults(body.agents);
      const permadeath = s.permadeath === true;
      const stmts: D1PreparedStatement[] = [];
      const debrief: AgentDebrief[] = [];
      let lost = 0;
      let injured = 0;
      let levelups = 0;
      for (const agentId of squad) {
        const a = agents.find((x) => x.id === agentId && !x.dead);
        if (!a) continue; // dismissed or already dead
        const r = results.get(agentId) ?? { id: agentId, survived: true, kills: 0, hpPct: 100 };
        const kills = Math.min(r.kills, Number(s.max_kills_per_mission));
        if (!r.survived && permadeath) {
          lost++;
          stmts.push(
            env.DB.prepare("UPDATE agents SET dead = 1, died_at = ?1, kills = kills + ?2, missions = missions + 1 WHERE id = ?3 AND player_id = ?4").bind(
              end,
              kills,
              agentId,
              id,
            ),
          );
          debrief.push({ id: agentId, name: a.name, survived: false, kills, xp_gained: 0, level: a.level, leveled_up: false, status: "dead", injured_until: 0 });
          continue;
        }
        // A rejected (too fast) win earns nobody XP, but wounds still count.
        const gained = implausible || outcome === "abort" ? 0 : xpGain({ survived: r.survived, won, stealth, kills }, s, b);
        const xp = a.xp + gained;
        const level = Math.max(a.level, levelForXp(xp, s));
        const mins = injuryMinutes({ survived: r.survived, hpPct: r.hpPct }, s, b);
        const injuredUntil = mins ? Math.max(a.injured_until, end + mins * 60000) : a.injured_until;
        if (mins) injured++;
        if (level > a.level) levelups++;
        stmts.push(
          env.DB.prepare(
            "UPDATE agents SET xp = ?1, level = ?2, injured_until = ?3, kills = kills + ?4, missions = missions + 1 WHERE id = ?5 AND player_id = ?6 AND dead = 0",
          ).bind(xp, level, injuredUntil, kills, agentId, id),
        );
        debrief.push({
          id: agentId,
          name: a.name,
          survived: r.survived,
          kills,
          xp_gained: gained,
          level,
          leveled_up: level > a.level,
          status: injuredUntil > end ? "injured" : "ready",
          injured_until: injuredUntil,
        });
      }

      // Guarded on ended_at so a duplicate completion can't double-pay.
      const [closed] = await env.DB.batch([
        env.DB.prepare(
          "UPDATE mission_runs SET ended_at = ?1, outcome = ?2, stealth = ?3, reward = ?4, rp = ?5, intel = ?6 WHERE id = ?7 AND ended_at IS NULL",
        ).bind(end, outcome, stealth ? 1 : 0, rewards.credits, rewards.rp, rewards.intel, body.runId),
      ]);
      if (!closed!.meta.changes) throw new HttpError(404, "Run not found or already completed");

      await env.DB.batch([
        env.DB.prepare(
          "UPDATE players SET credits = credits + ?1, research_points = research_points + ?2, intel = intel + ?3, last_seen_at = ?4 WHERE id = ?5",
        ).bind(rewards.credits, rewards.rp, rewards.intel, end, id),
        ...stmts,
        bumpStat(env, `missions_${outcome}`),
        bumpStat(env, `missions_${outcome}_${run.mission_type}`),
        bumpStat(env, "credits_awarded", rewards.credits),
        ...(rewards.rp ? [bumpStat(env, "rp_awarded", rewards.rp)] : []),
        ...(rewards.intel ? [bumpStat(env, "intel_awarded", rewards.intel)] : []),
        ...(lost ? [bumpStat(env, "agents_lost", lost)] : []),
        ...(injured ? [bumpStat(env, "agents_injured", injured)] : []),
        ...(levelups ? [bumpStat(env, "agent_levelups", levelups)] : []),
        ...(firstClear ? [bumpStat(env, `mission_first_clear_${run.mission_id}`)] : []),
      ]);

      return json({
        outcome,
        reward: rewards.credits,
        rp: rewards.rp,
        intel: rewards.intel,
        stealth,
        firstClear,
        agents: debrief,
        corp: await loadCorpState(env, id, s),
      });
    },
  },
];
