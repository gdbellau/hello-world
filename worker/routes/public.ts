import { publicSettings } from "../../shared/settings";
import { requirePlayer } from "../auth";
import { signPlayerToken, verifyPlayerToken } from "../crypto";
import { bumpStat, loadSettings, nowMs, today } from "../db";
import { json, readJson } from "../http";
import type { Route } from "../router";

export const publicRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/config",
    async handler({ env }) {
      const s = await loadSettings(env);
      return json(publicSettings(s), { headers: { "Cache-Control": "public, max-age=60" } });
    },
  },
  {
    method: "POST",
    path: "/api/session",
    async handler({ req, env }) {
      const body = await readJson<{ token?: string }>(req).catch(() => ({}) as { token?: string });
      const existing = body.token ? await verifyPlayerToken(env.SESSION_SECRET, body.token) : null;
      if (existing) {
        const [r] = await env.DB.batch([
          env.DB.prepare("UPDATE players SET last_seen_at = ?1 WHERE id = ?2").bind(nowMs(), existing),
          // DAU: at most one row write per player per day (ignored after the first).
          env.DB.prepare("INSERT OR IGNORE INTO player_days (day, player_id) SELECT ?1, id FROM players WHERE id = ?2").bind(today(), existing),
        ]);
        if (r!.meta.changes > 0) return json({ token: body.token, playerId: existing });
      }
      const s = await loadSettings(env);
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO players (id, created_at, last_seen_at, credits) VALUES (?1, ?2, ?2, ?3)").bind(
          id,
          nowMs(),
          Number(s.starting_credits),
        ),
        bumpStat(env, "new_players"),
        env.DB.prepare("INSERT OR IGNORE INTO player_days (day, player_id) VALUES (?1, ?2)").bind(today(), id),
      ]);
      return json({ token: await signPlayerToken(env.SESSION_SECRET, id), playerId: id });
    },
  },
  {
    method: "GET",
    path: "/api/me",
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const player = await env.DB.prepare("SELECT id, corp_name, credits, created_at, email FROM players WHERE id = ?1").bind(id).first();
      const { results } = await env.DB.prepare(
        "SELECT entitlement FROM entitlements WHERE player_id = ?1 AND revoked_at IS NULL",
      ).bind(id).all<{ entitlement: string }>();
      return json({ ...player, entitlements: results.map((r) => r.entitlement) });
    },
  },
];
