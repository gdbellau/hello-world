import { SETTINGS, SETTINGS_BY_KEY, validateSetting } from "../../shared/settings";
import {
  addDays,
  buildExport,
  dayList,
  diffImport,
  estimateDailyLoad,
  fillSeries,
  FREE_TIER,
  mergeDau,
  parseImport,
  productErrors,
  totalsBetween,
  type ProductInput,
  type StatRow,
} from "../admin-lib";
import { existingTables, withCsrf } from "../admin-guard";
import { audit, loadSettings, nowMs, today } from "../db";
import { HttpError, json, readJson } from "../http";
import type { AdminCtx, Route } from "../router";

const RANGES = [7, 30, 90, 180, 365];
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const upsertSetting = (db: D1Database, key: string, value: unknown, by: string) =>
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(value), nowMs(), by);

const routes: Route<AdminCtx>[] = [
  {
    method: "GET",
    path: "/admin/api/whoami",
    handler: async ({ admin }) => json({ email: admin.email }),
  },

  // --- Settings ---------------------------------------------------------------
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
      const body = await readJson<{ key: string; value: unknown; reason?: string }>(req);
      let value;
      try {
        value = validateSetting(body.key, body.value);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const before = (await loadSettings(env))[body.key];
      await env.DB.batch([
        upsertSetting(env.DB, body.key, value, admin.email),
        audit(env, admin.email, "setting.update", body.key, { from: before, value, reason: body.reason || undefined }),
      ]);
      return json({ key: body.key, value });
    },
  },
  {
    method: "DELETE",
    path: /^\/admin\/api\/settings\/(?<key>[a-z0-9_]+)$/,
    async handler({ env, admin, params }) {
      const key = params.key!;
      if (!SETTINGS_BY_KEY.has(key)) throw new HttpError(404, `Unknown setting: ${key}`);
      await env.DB.batch([env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key), audit(env, admin.email, "setting.reset", key)]);
      return json({ key, reset: true });
    },
  },
  {
    method: "GET",
    path: "/admin/api/settings/export",
    async handler({ env, admin }) {
      return json(buildExport(await loadSettings(env), admin.email), {
        headers: { "Content-Disposition": `attachment; filename="cabal-settings-${today()}.json"` },
      });
    },
  },
  {
    // Bulk import. `dryRun` returns the diff only; otherwise every change is
    // applied atomically in one D1 batch with an audit row per key.
    method: "POST",
    path: "/admin/api/settings/batch",
    async handler({ req, env, admin }) {
      const body = await readJson<{ values?: unknown; dryRun?: boolean; reason?: string }>(req);
      let imported: Record<string, unknown>;
      try {
        imported = parseImport(body.values ?? body);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (Object.keys(imported).length > 1000) throw new HttpError(400, "Too many keys");
      const diff = diffImport(SETTINGS, await loadSettings(env), imported);
      if (body.dryRun) return json({ dryRun: true, ...diff });
      if (diff.errors.length) return json({ error: `${diff.errors.length} invalid value(s); nothing applied`, ...diff }, { status: 400 });
      if (!diff.changes.length) return json({ applied: 0, ...diff });
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
      await env.DB.batch(
        diff.changes.flatMap((c) => [
          c.action === "reset"
            ? env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(c.key)
            : upsertSetting(env.DB, c.key, c.to, admin.email),
          audit(env, admin.email, "setting.import", c.key, { from: c.from, value: c.to, reason }),
        ]),
      );
      return json({ applied: diff.changes.length, ...diff });
    },
  },

  // --- Stats ------------------------------------------------------------------
  {
    method: "GET",
    path: "/admin/api/stats",
    async handler({ env, url }) {
      const days = Number(url.searchParams.get("days") ?? 30);
      if (!RANGES.includes(days)) throw new HttpError(400, `days must be one of ${RANGES.join(", ")}`);
      const end = today();
      const since = addDays(end, -(days - 1));
      const prevSince = addDays(since, -days);
      const sinceMs = dayStartMs(since);
      const [daily, live, players, revenueAll, byProduct, outcomes, changes, config, productNames] = await env.DB.batch([
        env.DB.prepare("SELECT day, metric, value FROM daily_stats WHERE day >= ?1").bind(prevSince),
        env.DB.prepare("SELECT day, COUNT(*) AS n FROM player_days WHERE day >= ?1 GROUP BY day").bind(prevSince),
        env.DB.prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(created_at >= ?1), 0) AS new_today,
                  COALESCE(SUM(last_seen_at >= ?2), 0) AS active_24h,
                  COALESCE(SUM(banned), 0) AS banned
           FROM players`,
        ).bind(dayStartMs(end), nowMs() - 86_400_000),
        env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM purchases WHERE status = 'paid'"),
        env.DB.prepare(
          `SELECT product_id, status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
           FROM purchases WHERE created_at >= ?1 GROUP BY product_id, status`,
        ).bind(sinceMs),
        env.DB.prepare(
          `SELECT mission_type, outcome, COUNT(*) AS n FROM mission_runs
           WHERE started_at >= ?1 AND outcome IS NOT NULL GROUP BY mission_type, outcome`,
        ).bind(sinceMs),
        env.DB.prepare(
          `SELECT target AS key, COUNT(*) AS n, MAX(at) AS last FROM audit_log
           WHERE at >= ?1 AND action LIKE 'setting.%' GROUP BY target ORDER BY n DESC, last DESC LIMIT 10`,
        ).bind(sinceMs),
        env.DB.prepare("SELECT COUNT(*) AS overrides, MAX(updated_at) AS last FROM settings"),
        env.DB.prepare("SELECT id, name FROM products"),
      ]);

      const rolled = daily!.results as unknown as StatRow[];
      const rows = rolled.concat(mergeDau(rolled, live!.results as unknown as { day: string; n: number }[]));
      const dayIdx = dayList(end, days);
      const p = players!.results[0] as { total: number; new_today: number; active_24h: number; banned: number };
      const names = new Map((productNames!.results as { id: string; name: string }[]).map((r) => [r.id, r.name]));
      const prod = new Map<string, { id: string; name: string; purchases: number; revenueCents: number; refunds: number; refundedCents: number }>();
      for (const r of byProduct!.results as { product_id: string; status: string; n: number; cents: number }[]) {
        const e = prod.get(r.product_id) ?? { id: r.product_id, name: names.get(r.product_id) ?? r.product_id, purchases: 0, revenueCents: 0, refunds: 0, refundedCents: 0 };
        if (r.status === "paid") {
          e.purchases += r.n;
          e.revenueCents += r.cents;
        } else if (r.status === "refunded") {
          e.refunds += r.n;
          e.refundedCents += r.cents;
        }
        prod.set(r.product_id, e);
      }
      const cfg = config!.results[0] as { overrides: number; last: number | null };
      const ra = revenueAll!.results[0] as { cents: number; n: number };

      return json({
        days,
        range: { from: since, to: end },
        dayList: dayIdx,
        series: fillSeries(rows, dayIdx),
        totals: totalsBetween(rows, since, end),
        prevTotals: totalsBetween(rows, prevSince, addDays(since, -1)),
        players: { total: p.total, newToday: p.new_today, active24h: p.active_24h, banned: p.banned },
        allTime: { revenueCents: ra.cents, purchases: ra.n },
        missionOutcomes: outcomes!.results,
        revenueByProduct: [...prod.values()].sort((a, b) => b.revenueCents - a.revenueCents),
        settingsChanges: (changes!.results as { key: string; n: number; last: number }[]).map((c) => ({
          ...c,
          label: SETTINGS_BY_KEY.get(c.key)?.label ?? c.key,
        })),
        config: { overrides: cfg.overrides, lastChange: cfg.last, schemaSize: SETTINGS.length },
      });
    },
  },

  // --- Products ---------------------------------------------------------------
  {
    method: "GET",
    path: "/admin/api/products",
    async handler({ env }) {
      const { results } = await env.DB.prepare(
        `SELECT p.*,
                COALESCE(s.paid, 0) AS purchases, COALESCE(s.revenue, 0) AS revenue_cents,
                COALESCE(s.refunds, 0) AS refunds, COALESCE(s.refunded, 0) AS refunded_cents
         FROM products p LEFT JOIN (
           SELECT product_id,
                  SUM(status = 'paid') AS paid, SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END) AS revenue,
                  SUM(status = 'refunded') AS refunds, SUM(CASE WHEN status = 'refunded' THEN amount_cents ELSE 0 END) AS refunded
           FROM purchases GROUP BY product_id
         ) s ON s.product_id = p.id
         ORDER BY p.sort, p.id`,
      ).all();
      return json(results);
    },
  },
  {
    method: "PUT",
    path: /^\/admin\/api\/products\/(?<id>[a-z0-9-]+)$/,
    async handler({ req, env, admin, params }) {
      const id = params.id!;
      const b = await readJson<ProductInput>(req);
      const errors = productErrors(id, b);
      if (Object.keys(errors).length) return json({ error: "Invalid product", fields: errors }, { status: 400 });
      const clean = {
        name: b.name.trim(),
        description: b.description ?? "",
        kind: b.kind,
        price_cents: b.price_cents,
        currency: (b.currency ?? "usd").toLowerCase(),
        stripe_price_id: b.stripe_price_id || null,
        entitlement: b.entitlement,
        active: !!b.active,
        sort: b.sort ?? 0,
      };
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO products (id, name, description, kind, price_cents, currency, stripe_price_id, entitlement, active, sort)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, kind = excluded.kind,
             price_cents = excluded.price_cents, currency = excluded.currency, stripe_price_id = excluded.stripe_price_id,
             entitlement = excluded.entitlement, active = excluded.active, sort = excluded.sort`,
        ).bind(id, clean.name, clean.description, clean.kind, clean.price_cents, clean.currency, clean.stripe_price_id, clean.entitlement, clean.active ? 1 : 0, clean.sort),
        audit(env, admin.email, "product.upsert", id, clean),
      ]);
      return json({ id, saved: true });
    },
  },

  // --- Audit log --------------------------------------------------------------
  {
    method: "GET",
    path: "/admin/api/audit",
    async handler({ env, url }) {
      const q = url.searchParams;
      const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
      const where: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        args.push(v);
        where.push(sql.replace("?", `?${args.length}`));
      };
      if (q.get("actor")) add("actor = ?", q.get("actor"));
      if (q.get("action")) add(q.get("action")!.endsWith(".*") ? "action LIKE ?" : "action = ?", q.get("action")!.replace(/\.\*$/, ".%"));
      if (q.get("target")) add("target LIKE ?", `%${q.get("target")!.replace(/[%_]/g, "")}%`);
      const before = Number(q.get("before"));
      if (before > 0) add("id < ?", before);
      args.push(limit + 1);
      const { results } = await env.DB.prepare(
        `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?${args.length}`,
      )
        .bind(...args)
        .all<{ id: number }>();
      const more = results.length > limit;
      const rows = results.slice(0, limit);
      return json({ rows, next: more ? rows[rows.length - 1]!.id : null });
    },
  },
  {
    method: "GET",
    path: "/admin/api/audit/facets",
    async handler({ env }) {
      const [actors, actions] = await env.DB.batch([
        env.DB.prepare("SELECT actor AS v, COUNT(*) AS n FROM audit_log GROUP BY actor ORDER BY n DESC LIMIT 100"),
        env.DB.prepare("SELECT action AS v, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action LIMIT 200"),
      ]);
      return json({ actors: actors!.results, actions: actions!.results });
    },
  },

  // --- Ops --------------------------------------------------------------------
  {
    method: "GET",
    path: "/admin/api/health",
    async handler({ env }) {
      const t0 = Date.now();
      let dbOk = true;
      let dbError: string | undefined;
      try {
        await env.DB.prepare("SELECT 1").first();
      } catch (e) {
        dbOk = false;
        dbError = (e as Error).message.slice(0, 200);
      }
      const latencyMs = Date.now() - t0;
      const tables = dbOk ? await existingTables(env.DB) : new Set<string>();

      let migrations: { id: number; name: string; applied_at: string }[] = [];
      if (tables.has("d1_migrations")) {
        try {
          migrations = (await env.DB.prepare("SELECT id, name, applied_at FROM d1_migrations ORDER BY id").all<(typeof migrations)[number]>()).results;
        } catch {
          /* fail soft */
        }
      }

      // Row counts per table. COUNT(*) reads every row, so this is admin-only and on demand.
      const names = [...tables].sort();
      let counts: { table: string; rows: number }[] = [];
      if (names.length) {
        try {
          const res = await env.DB.batch(names.map((n) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${n.replace(/"/g, '""')}"`)));
          counts = names.map((n, i) => ({ table: n, rows: (res[i]!.results[0] as { n: number }).n }));
        } catch {
          counts = names.map((n) => ({ table: n, rows: -1 }));
        }
      }

      // Load estimate from the last 7 complete days of counters.
      const to = addDays(today(), -1);
      const from = addDays(to, -6);
      let avg: Record<string, number> = {};
      try {
        const [daily, live] = await env.DB.batch([
          env.DB.prepare("SELECT day, metric, value FROM daily_stats WHERE day BETWEEN ?1 AND ?2").bind(from, to),
          env.DB.prepare("SELECT day, COUNT(*) AS n FROM player_days WHERE day BETWEEN ?1 AND ?2 GROUP BY day").bind(from, to),
        ]);
        const rolled = daily!.results as unknown as StatRow[];
        const totals = totalsBetween(rolled.concat(mergeDau(rolled, live!.results as unknown as { day: string; n: number }[])), from, to);
        avg = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / 7]));
      } catch {
        /* fail soft */
      }
      const [overrides] = dbOk ? await env.DB.batch([env.DB.prepare("SELECT COUNT(*) AS n FROM settings")]) : [];
      const e = env as unknown as Record<string, unknown>;
      const set = (k: string) => typeof e[k] === "string" && (e[k] as string).length > 0;

      return json({
        ok: dbOk,
        now: nowMs(),
        db: { ok: dbOk, latencyMs, error: dbError },
        migrations,
        settings: { schema: SETTINGS.length, overrides: overrides ? (overrides.results[0] as { n: number }).n : null },
        configured: {
          sessionSecret: set("SESSION_SECRET"),
          access: set("ACCESS_TEAM_DOMAIN") && set("ACCESS_AUD"),
          stripe: set("STRIPE_SECRET_KEY"),
          stripeWebhook: set("STRIPE_WEBHOOK_SECRET"),
          resend: set("RESEND_API_KEY"),
          devAdminBypass: set("DEV_ADMIN_EMAIL"),
        },
        tables: counts,
        load: { window: { from, to }, avg, estimate: estimateDailyLoad(avg) },
        freeTier: FREE_TIER,
      });
    },
  },
];

export const adminRoutes: Route<AdminCtx>[] = withCsrf(routes);
