import { SETTINGS, validateSetting } from "../../shared/settings";
import { audit, loadSettings, nowMs } from "../db";
import { HttpError, json, readJson } from "../http";
import type { AdminCtx, Route } from "../router";

export const adminRoutes: Route<AdminCtx>[] = [
  {
    method: "GET",
    path: "/admin/api/whoami",
    handler: async ({ admin }) => json({ email: admin.email }),
  },
  {
    method: "GET",
    path: "/admin/api/settings",
    async handler({ env }) {
      const { results } = await env.DB.prepare("SELECT key, updated_at, updated_by FROM settings").all();
      return json({ schema: SETTINGS, values: await loadSettings(env), overrides: results });
    },
  },
  {
    method: "PUT",
    path: "/admin/api/settings",
    async handler({ req, env, admin }) {
      const body = await readJson<{ key: string; value: unknown }>(req);
      let value;
      try {
        value = validateSetting(body.key, body.value);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).bind(body.key, JSON.stringify(value), nowMs(), admin.email),
        audit(env, admin.email, "setting.update", body.key, { value }),
      ]);
      return json({ key: body.key, value });
    },
  },
  {
    method: "DELETE",
    path: /^\/admin\/api\/settings\/(?<key>[a-z0-9_]+)$/,
    async handler({ env, admin, params }) {
      const key = params.key!;
      await env.DB.batch([
        env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key),
        audit(env, admin.email, "setting.reset", key),
      ]);
      return json({ key, reset: true });
    },
  },
  {
    method: "GET",
    path: "/admin/api/stats",
    async handler({ env, url }) {
      const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 365);
      const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
      const dayAgo = nowMs() - 86400_000;
      const [daily, players, active, revenue, runs] = await env.DB.batch([
        env.DB.prepare("SELECT day, metric, value FROM daily_stats WHERE day >= ?1 ORDER BY day").bind(since),
        env.DB.prepare("SELECT COUNT(*) AS n FROM players"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE last_seen_at >= ?1").bind(dayAgo),
        env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM purchases WHERE status = 'paid'"),
        env.DB.prepare(
          "SELECT mission_type, outcome, COUNT(*) AS n FROM mission_runs WHERE outcome IS NOT NULL GROUP BY mission_type, outcome",
        ),
      ]);
      return json({
        days,
        totals: {
          players: (players!.results[0] as { n: number }).n,
          activePlayers24h: (active!.results[0] as { n: number }).n,
          revenueCents: (revenue!.results[0] as { cents: number }).cents,
          purchases: (revenue!.results[0] as { n: number }).n,
        },
        missionOutcomes: runs!.results,
        daily: daily!.results,
      });
    },
  },
  {
    method: "GET",
    path: "/admin/api/products",
    async handler({ env }) {
      const { results } = await env.DB.prepare("SELECT * FROM products ORDER BY sort").all();
      return json(results);
    },
  },
  {
    method: "PUT",
    path: /^\/admin\/api\/products\/(?<id>[a-z0-9-]+)$/,
    async handler({ req, env, admin, params }) {
      const id = params.id!;
      const b = await readJson<{
        name: string;
        description?: string;
        kind: string;
        price_cents: number;
        currency?: string;
        stripe_price_id?: string | null;
        entitlement: string;
        active: boolean;
        sort?: number;
      }>(req);
      if (!b.name || !b.kind || !b.entitlement) throw new HttpError(400, "name, kind and entitlement are required");
      if (!Number.isInteger(b.price_cents) || b.price_cents < 0) throw new HttpError(400, "price_cents must be a non-negative integer");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO products (id, name, description, kind, price_cents, currency, stripe_price_id, entitlement, active, sort)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, kind = excluded.kind,
             price_cents = excluded.price_cents, currency = excluded.currency, stripe_price_id = excluded.stripe_price_id,
             entitlement = excluded.entitlement, active = excluded.active, sort = excluded.sort`,
        ).bind(
          id,
          b.name,
          b.description ?? "",
          b.kind,
          b.price_cents,
          (b.currency ?? "usd").toLowerCase(),
          b.stripe_price_id || null,
          b.entitlement,
          b.active ? 1 : 0,
          b.sort ?? 0,
        ),
        audit(env, admin.email, "product.upsert", id, b),
      ]);
      return json({ id, saved: true });
    },
  },
  {
    method: "GET",
    path: "/admin/api/audit",
    async handler({ env, url }) {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
      const { results } = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1").bind(limit).all();
      return json(results);
    },
  },
];
