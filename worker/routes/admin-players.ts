// Admin player tools: search, detail, entitlements, credits, bans, renames, progress resets.
// Every write is audit-logged with the Access identity and a required reason.
import { addDays, ENTITLEMENT_RE } from "../admin-lib";
import { existingTables, reasonOrThrow, withCsrf } from "../admin-guard";
import { audit, loadSettings, nowMs, today } from "../db";
import { HttpError, json, readJson } from "../http";
import type { AdminCtx, Route } from "../router";

interface PlayerRow {
  id: string;
  created_at: number;
  last_seen_at: number;
  email: string | null;
  corp_name: string;
  credits: number;
  banned: number;
}

const PAGE = 25;
const SORTS: Record<string, string> = {
  last_seen: "last_seen_at DESC",
  created: "created_at DESC",
  credits: "credits DESC",
  corp: "corp_name COLLATE NOCASE ASC",
};
/** Tables this module already renders; anything else with a player_id column is shown generically. */
const KNOWN = new Set(["players", "entitlements", "purchases", "mission_runs", "player_days"]);
const ID = "(?<id>[A-Za-z0-9-]{1,64})";
const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function getPlayer(db: D1Database, id: string): Promise<PlayerRow> {
  const p = await db.prepare("SELECT * FROM players WHERE id = ?1").bind(id).first<PlayerRow>();
  if (!p) throw new HttpError(404, "Player not found");
  return p;
}

/** Generic, fail-soft view of other workstreams' per-player tables (roster, research…). */
async function extraTables(db: D1Database, id: string) {
  const tables = await existingTables(db);
  const out: { table: string; count: number; rows: Record<string, unknown>[] }[] = [];
  for (const t of [...tables].filter((t) => !KNOWN.has(t) && !t.startsWith("d1_")).sort()) {
    try {
      const cols = await db.prepare(`SELECT name FROM pragma_table_info(?1)`).bind(t).all<{ name: string }>();
      if (!cols.results.some((c) => c.name === "player_id")) continue;
      const q = `"${t.replace(/"/g, '""')}"`;
      const [count, rows] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS n FROM ${q} WHERE player_id = ?1`).bind(id),
        db.prepare(`SELECT * FROM ${q} WHERE player_id = ?1 LIMIT 20`).bind(id),
      ]);
      const n = (count!.results[0] as { n: number }).n;
      if (n > 0) out.push({ table: t, count: n, rows: rows!.results as Record<string, unknown>[] });
    } catch {
      /* fail soft: a table we can't introspect is just not shown */
    }
    if (out.length >= 8) break;
  }
  return out;
}

const routes: Route<AdminCtx>[] = [
  {
    method: "GET",
    path: "/admin/api/players",
    async handler({ env, url }) {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
      const status = url.searchParams.get("status") ?? "all";
      const sort = SORTS[url.searchParams.get("sort") ?? ""] ?? SORTS.last_seen!;
      const page = Math.max(Number(url.searchParams.get("page")) || 1, 1);
      const where: string[] = [];
      const args: unknown[] = [];
      if (q) {
        args.push(`${like(q)}%`, `%${like(q)}%`);
        where.push(`(id LIKE ?1 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\' OR corp_name LIKE ?2 ESCAPE '\\')`);
      }
      if (status === "banned") where.push("banned = 1");
      else if (status === "active") where.push("banned = 0");
      else if (status === "linked") where.push("email IS NOT NULL");
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const n = args.length;
      const [rows, total] = await env.DB.batch([
        env.DB.prepare(
          `SELECT id, created_at, last_seen_at, email, corp_name, credits, banned FROM players ${w}
           ORDER BY ${sort} LIMIT ?${n + 1} OFFSET ?${n + 2}`,
        ).bind(...args, PAGE, (page - 1) * PAGE),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM players ${w}`).bind(...args),
      ]);
      return json({ rows: rows!.results, total: (total!.results[0] as { n: number }).n, page, pageSize: PAGE });
    },
  },
  {
    method: "GET",
    path: new RegExp(`^/admin/api/players/${ID}$`),
    async handler({ env, params }) {
      const id = params.id!;
      const player = await getPlayer(env.DB, id);
      const [ents, purchases, runs, outcomes, log, days] = await env.DB.batch([
        env.DB.prepare("SELECT entitlement, source, granted_at, revoked_at FROM entitlements WHERE player_id = ?1 ORDER BY granted_at DESC").bind(id),
        env.DB.prepare(
          `SELECT pu.stripe_session_id, pu.product_id, pr.name AS product_name, pu.amount_cents, pu.currency, pu.status, pu.created_at
           FROM purchases pu LEFT JOIN products pr ON pr.id = pu.product_id WHERE pu.player_id = ?1 ORDER BY pu.created_at DESC LIMIT 50`,
        ).bind(id),
        env.DB.prepare(
          "SELECT id, mission_id, mission_type, started_at, ended_at, outcome, stealth, reward FROM mission_runs WHERE player_id = ?1 ORDER BY started_at DESC LIMIT 25",
        ).bind(id),
        env.DB.prepare("SELECT COALESCE(outcome, 'open') AS outcome, COUNT(*) AS n FROM mission_runs WHERE player_id = ?1 GROUP BY 1").bind(id),
        env.DB.prepare("SELECT id, at, actor, action, detail FROM audit_log WHERE target = ?1 ORDER BY id DESC LIMIT 25").bind(id),
        env.DB.prepare("SELECT day FROM player_days WHERE day >= ?1 AND player_id = ?2 ORDER BY day").bind(addDays(today(), -29), id),
      ]);
      return json({
        player,
        entitlements: ents!.results,
        purchases: purchases!.results,
        runs: runs!.results,
        runTotals: Object.fromEntries((outcomes!.results as { outcome: string; n: number }[]).map((r) => [r.outcome, r.n])),
        audit: log!.results,
        activeDays: (days!.results as { day: string }[]).map((d) => d.day),
        extra: await extraTables(env.DB, id),
      });
    },
  },
  {
    method: "POST",
    path: new RegExp(`^/admin/api/players/${ID}/(?<action>grant|revoke|credits|ban|rename|reset)$`),
    async handler({ req, env, admin, params }) {
      const id = params.id!;
      const action = params.action!;
      const body = await readJson<Record<string, unknown>>(req);
      const reason = reasonOrThrow(body.reason);
      const p = await getPlayer(env.DB, id);
      const now = nowMs();
      const log = (detail: Record<string, unknown>) => audit(env, admin.email, `player.${action}`, id, { ...detail, reason });

      switch (action) {
        case "grant": {
          const ent = String(body.entitlement ?? "").trim();
          if (!ENTITLEMENT_RE.test(ent)) throw new HttpError(400, "Entitlement must match a-z 0-9 : _ - (max 64)");
          const [r] = await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO entitlements (player_id, entitlement, source, granted_at) VALUES (?1, ?2, 'admin', ?3)
               ON CONFLICT(player_id, entitlement) DO UPDATE SET source = 'admin', granted_at = excluded.granted_at, revoked_at = NULL
               WHERE entitlements.revoked_at IS NOT NULL`,
            ).bind(id, ent, now),
            log({ entitlement: ent }),
          ]);
          if (!r!.meta.changes) throw new HttpError(409, `${ent} is already active`);
          return json({ ok: true });
        }
        case "revoke": {
          const ent = String(body.entitlement ?? "");
          const r = await env.DB.prepare("UPDATE entitlements SET revoked_at = ?1 WHERE player_id = ?2 AND entitlement = ?3 AND revoked_at IS NULL")
            .bind(now, id, ent)
            .run();
          if (!r.meta.changes) throw new HttpError(404, "No active entitlement with that key");
          await log({ entitlement: ent }).run();
          return json({ ok: true });
        }
        case "credits": {
          const delta = Number(body.delta);
          if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000_000) throw new HttpError(400, "delta must be a non-zero whole number");
          const after = Math.max(0, p.credits + delta);
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET credits = MAX(0, credits + ?1) WHERE id = ?2").bind(delta, id),
            log({ delta, from: p.credits, to: after }),
          ]);
          return json({ ok: true, credits: after });
        }
        case "ban": {
          if (typeof body.banned !== "boolean") throw new HttpError(400, "banned must be true or false");
          if (!!p.banned === body.banned) throw new HttpError(409, body.banned ? "Already banned" : "Not banned");
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET banned = ?1 WHERE id = ?2").bind(body.banned ? 1 : 0, id),
            audit(env, admin.email, body.banned ? "player.ban" : "player.unban", id, { reason }),
          ]);
          return json({ ok: true });
        }
        case "rename": {
          const name = String(body.corp_name ?? "").replace(/\s+/g, " ").trim();
          if (name.length < 1 || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "Corp name must be 1–40 printable characters");
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET corp_name = ?1 WHERE id = ?2").bind(name, id),
            log({ from: p.corp_name, to: name }),
          ]);
          return json({ ok: true });
        }
        case "reset": {
          if (body.confirm !== "RESET") throw new HttpError(400, 'Type RESET to confirm');
          const s = await loadSettings(env);
          const credits = Number(s.starting_credits);
          await env.DB.batch([
            // Wipes the corp (roster, research, campaign clears) but keeps purchases,
            // entitlements and mission history for stats.
            env.DB.prepare(
              `UPDATE players SET credits = ?1, research_points = 0, intel = 0, roster_seeded = 0, progress_reset_at = ?3
               WHERE id = ?2`,
            ).bind(credits, id, now),
            env.DB.prepare("DELETE FROM agents WHERE player_id = ?1").bind(id),
            env.DB.prepare("DELETE FROM research WHERE player_id = ?1").bind(id),
            // Close any runs left open so they can't be completed for a reward later.
            env.DB.prepare("UPDATE mission_runs SET ended_at = ?1, outcome = 'abort', reward = 0 WHERE player_id = ?2 AND ended_at IS NULL").bind(now, id),
            log({ fromCredits: p.credits, toCredits: credits }),
          ]);
          return json({ ok: true, credits });
        }
      }
      throw new HttpError(404, "Unknown action");
    },
  },
];

export const adminPlayerRoutes: Route<AdminCtx>[] = withCsrf(routes);
