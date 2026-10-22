import { MISSION_TYPES, missionReward, type MissionType } from "../../shared/settings";
import { requirePlayer } from "../auth";
import { bumpStat, loadSettings, nowMs } from "../db";
import { HttpError, json, readJson } from "../http";
import type { Route } from "../router";

export const missionRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/missions/start",
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const s = await loadSettings(env);
      if (s.maintenance_mode) throw new HttpError(503, "Maintenance in progress");
      const body = await readJson<{ missionId: string; missionType: MissionType }>(req);
      if (!MISSION_TYPES.includes(body.missionType)) throw new HttpError(400, "Bad mission type");
      if (typeof body.missionId !== "string" || body.missionId.length > 64) throw new HttpError(400, "Bad mission id");
      const runId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO mission_runs (id, player_id, mission_id, mission_type, started_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).bind(runId, id, body.missionId, body.missionType, nowMs()),
        bumpStat(env, "missions_started"),
      ]);
      return json({ runId });
    },
  },
  {
    method: "POST",
    path: "/api/missions/complete",
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const body = await readJson<{ runId: string; outcome: "win" | "loss" | "abort"; stealth: boolean }>(req);
      if (!["win", "loss", "abort"].includes(body.outcome)) throw new HttpError(400, "Bad outcome");
      const run = await env.DB.prepare(
        "SELECT mission_type, started_at FROM mission_runs WHERE id = ?1 AND player_id = ?2 AND ended_at IS NULL",
      ).bind(body.runId, id).first<{ mission_type: MissionType; started_at: number }>();
      if (!run) throw new HttpError(404, "Run not found or already completed");

      const s = await loadSettings(env);
      const end = nowMs();
      const seconds = (end - run.started_at) / 1000;
      let outcome = body.outcome;
      if (outcome === "win" && seconds < Number(s.min_mission_seconds)) outcome = "abort"; // implausibly fast
      const stealth = outcome === "win" && body.stealth === true;
      const reward = outcome === "win" ? missionReward(run.mission_type, stealth, s) : 0;

      await env.DB.batch([
        env.DB.prepare("UPDATE mission_runs SET ended_at = ?1, outcome = ?2, stealth = ?3, reward = ?4 WHERE id = ?5").bind(
          end,
          outcome,
          stealth ? 1 : 0,
          reward,
          body.runId,
        ),
        env.DB.prepare("UPDATE players SET credits = credits + ?1, last_seen_at = ?2 WHERE id = ?3").bind(reward, end, id),
        bumpStat(env, `missions_${outcome}`),
        bumpStat(env, `missions_${outcome}_${run.mission_type}`),
        bumpStat(env, "credits_awarded", reward),
      ]);
      return json({ outcome, reward, stealth });
    },
  },
];
