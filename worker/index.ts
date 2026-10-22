import {
  MISSION_TYPES,
  SETTINGS,
  mergeSettings,
  missionReward,
  publicSettings,
  validateSetting,
  type MissionType,
  type SettingsMap,
} from "../shared/settings";
import { verifyAccessJwt, type AccessIdentity } from "./access";
import { signPlayerToken, verifyPlayerToken } from "./crypto";
import { createCheckoutSession, verifyStripeSignature } from "./stripe";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "thecabal.cloudflareaccess.com"
  ACCESS_AUD: string; // Application Audience (AUD) tag
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Local dev only: identity used for /admin when the request is to localhost. */
  DEV_ADMIN_EMAIL?: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const nowMs = () => Date.now();

// ---------------------------------------------------------------------------
// Data helpers

async function loadSettings(env: Env): Promise<SettingsMap> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const overrides: Record<string, unknown> = {};
  for (const r of results) {
    try {
      overrides[r.key] = JSON.parse(r.value);
    } catch {
      // Corrupt row: fall back to the default.
    }
  }
  return mergeSettings(overrides);
}

function bumpStat(env: Env, metric: string, by = 1): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO daily_stats (day, metric, value) VALUES (?1, ?2, ?3)
     ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`,
  ).bind(today(), metric, by);
}

function audit(env: Env, actor: string, action: string, target: string, detail: unknown = ""): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
    nowMs(),
    actor,
    action,
    target,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

async function requirePlayer(req: Request, env: Env): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const id = token ? await verifyPlayerToken(env.SESSION_SECRET, token) : null;
  if (!id) throw new HttpError(401, "Not signed in");
  const row = await env.DB.prepare("SELECT banned FROM players WHERE id = ?1").bind(id).first<{ banned: number }>();
  if (!row) throw new HttpError(401, "Unknown player");
  if (row.banned) throw new HttpError(403, "Account suspended");
  return id;
}

// ---------------------------------------------------------------------------
// Public game API

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/config" && method === "GET") {
    const s = await loadSettings(env);
    return json(publicSettings(s), { headers: { "Cache-Control": "public, max-age=60" } });
  }

  if (path === "/api/session" && method === "POST") {
    const body = await readJson<{ token?: string }>(req).catch(() => ({}) as { token?: string });
    const existing = body.token ? await verifyPlayerToken(env.SESSION_SECRET, body.token) : null;
    if (existing) {
      const r = await env.DB.prepare("UPDATE players SET last_seen_at = ?1 WHERE id = ?2").bind(nowMs(), existing).run();
      if (r.meta.changes > 0) return json({ token: body.token, playerId: existing });
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
    ]);
    return json({ token: await signPlayerToken(env.SESSION_SECRET, id), playerId: id });
  }

  if (path === "/api/me" && method === "GET") {
    const id = await requirePlayer(req, env);
    const player = await env.DB.prepare("SELECT id, corp_name, credits, created_at FROM players WHERE id = ?1").bind(id).first();
    const { results } = await env.DB.prepare(
      "SELECT entitlement FROM entitlements WHERE player_id = ?1 AND revoked_at IS NULL",
    ).bind(id).all<{ entitlement: string }>();
    return json({ ...player, entitlements: results.map((r) => r.entitlement) });
  }

  if (path === "/api/missions/start" && method === "POST") {
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
  }

  if (path === "/api/missions/complete" && method === "POST") {
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
  }

  if (path === "/api/store/products" && method === "GET") {
    const s = await loadSettings(env);
    const { results } = await env.DB.prepare(
      "SELECT id, name, description, kind, price_cents, currency, entitlement FROM products WHERE active = 1 ORDER BY sort",
    ).all();
    return json({ enabled: s.store_enabled, banner: s.store_banner, products: results });
  }

  if (path === "/api/store/checkout" && method === "POST") {
    const id = await requirePlayer(req, env);
    const s = await loadSettings(env);
    if (!s.store_enabled || !env.STRIPE_SECRET_KEY) throw new HttpError(503, "Store is closed");
    const body = await readJson<{ productId: string }>(req);
    const product = await env.DB.prepare(
      "SELECT id, stripe_price_id FROM products WHERE id = ?1 AND active = 1",
    ).bind(body.productId).first<{ id: string; stripe_price_id: string | null }>();
    if (!product?.stripe_price_id) throw new HttpError(404, "Product unavailable");
    const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
      priceId: product.stripe_price_id,
      playerId: id,
      productId: product.id,
      successUrl: `${url.origin}/?purchase=success`,
      cancelUrl: `${url.origin}/?purchase=cancelled`,
    });
    return json({ url: session.url });
  }

  if (path === "/api/stripe/webhook" && method === "POST") {
    return handleStripeWebhook(req, env);
  }

  throw new HttpError(404, "Not found");
}

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "Webhook not configured");
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) throw new HttpError(400, "Bad signature");

  const event = JSON.parse(payload) as {
    type: string;
    data: { object: Record<string, any> };
  };

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    if (s.payment_status !== "paid") return json({ received: true });
    const playerId: string | undefined = s.metadata?.player_id ?? s.client_reference_id;
    const productId: string | undefined = s.metadata?.product_id;
    if (!playerId || !productId) return json({ received: true, ignored: "missing metadata" });

    const product = await env.DB.prepare("SELECT entitlement FROM products WHERE id = ?1")
      .bind(productId)
      .first<{ entitlement: string }>();
    if (!product) return json({ received: true, ignored: "unknown product" });

    // Stripe retries webhooks, so the purchase insert is the idempotency key.
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO purchases (stripe_session_id, player_id, product_id, amount_cents, currency, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'paid', ?6)`,
    ).bind(s.id, playerId, productId, s.amount_total ?? 0, s.currency ?? "usd", nowMs()).run();

    if (inserted.meta.changes > 0) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO entitlements (player_id, entitlement, source, granted_at) VALUES (?1, ?2, 'stripe', ?3)
           ON CONFLICT(player_id, entitlement) DO UPDATE SET revoked_at = NULL, granted_at = excluded.granted_at`,
        ).bind(playerId, product.entitlement, nowMs()),
        bumpStat(env, "purchases"),
        bumpStat(env, "revenue_cents", Number(s.amount_total ?? 0)),
        bumpStat(env, `purchases_${productId}`),
      ]);
    }
  }
  return json({ received: true });
}

// ---------------------------------------------------------------------------
// Admin (behind Cloudflare Access)

async function requireAdmin(req: Request, env: Env, url: URL): Promise<AccessIdentity> {
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (isLocal && env.DEV_ADMIN_EMAIL) return { email: env.DEV_ADMIN_EMAIL, sub: "dev" };

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(403, "Forbidden");
  try {
    return await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
  } catch {
    throw new HttpError(403, "Forbidden");
  }
}

async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  const admin = await requireAdmin(req, env, url);
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith("/admin/api/")) {
    // Serve the admin SPA shell only to verified admins.
    const res = await env.ASSETS.fetch(new Request(new URL("/admin/", url), req));
    return new Response(res.body, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers), "Cache-Control": "no-store" },
    });
  }

  if (path === "/admin/api/whoami" && method === "GET") return json({ email: admin.email });

  if (path === "/admin/api/settings" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT key, updated_at, updated_by FROM settings").all();
    return json({ schema: SETTINGS, values: await loadSettings(env), overrides: results });
  }

  if (path === "/admin/api/settings" && method === "PUT") {
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
  }

  const resetMatch = path.match(/^\/admin\/api\/settings\/([a-z0-9_]+)$/);
  if (resetMatch && method === "DELETE") {
    const key = resetMatch[1]!;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key),
      audit(env, admin.email, "setting.reset", key),
    ]);
    return json({ key, reset: true });
  }

  if (path === "/admin/api/stats" && method === "GET") {
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
  }

  if (path === "/admin/api/products" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM products ORDER BY sort").all();
    return json(results);
  }

  const productMatch = path.match(/^\/admin\/api\/products\/([a-z0-9-]+)$/);
  if (productMatch && method === "PUT") {
    const id = productMatch[1]!;
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
  }

  if (path === "/admin/api/audit" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    const { results } = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1").bind(limit).all();
    return json(results);
  }

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, env, url);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      console.error(e);
      return json({ error: "Internal error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
