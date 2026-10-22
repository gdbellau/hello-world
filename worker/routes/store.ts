// Store: catalog, Stripe Checkout, and the webhook that owns the purchase lifecycle
// (paid → refunded / disputed → reinstated). Entitlements are only ever written
// here or by an admin grant.
import { optionalPlayer, requirePlayer } from "../auth";
import { audit, bumpStat, loadSettings, nowMs } from "../db";
import type { Env } from "../env";
import { HttpError, json, readJson } from "../http";
import type { Route } from "../router";
import { createCheckoutSession, parseStripeEvent, verifyStripeSignature, type StripeAction } from "../stripe";

interface ProductRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  price_cents: number;
  currency: string;
  entitlement: string;
}

export const storeRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/store/products",
    async handler({ req, env }) {
      const [s, playerId] = await Promise.all([loadSettings(env), optionalPlayer(req, env)]);
      const { results } = await env.DB.prepare(
        "SELECT id, name, description, kind, price_cents, currency, entitlement FROM products WHERE active = 1 ORDER BY sort",
      ).all<ProductRow>();
      let owned: string[] = [];
      let email: string | null = null;
      if (playerId) {
        const [ents, player] = await env.DB.batch([
          env.DB.prepare("SELECT entitlement FROM entitlements WHERE player_id = ?1 AND revoked_at IS NULL").bind(playerId),
          env.DB.prepare("SELECT email FROM players WHERE id = ?1").bind(playerId),
        ]);
        const have = new Set((ents!.results as { entitlement: string }[]).map((r) => r.entitlement));
        owned = results.filter((p) => have.has(p.entitlement)).map((p) => p.id);
        email = (player!.results[0] as { email: string | null } | undefined)?.email ?? null;
      }
      return json(
        {
          enabled: Boolean(s.store_enabled) && Boolean(env.STRIPE_SECRET_KEY),
          banner: s.store_banner,
          requireAccount: s.require_account_for_purchase,
          currencyDisplay: s.store_currency_display,
          signedIn: Boolean(playerId),
          email,
          owned,
          products: results,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  },
  {
    method: "POST",
    path: "/api/store/checkout",
    async handler({ req, env, url }) {
      const id = await requirePlayer(req, env);
      const s = await loadSettings(env);
      if (!s.store_enabled || !env.STRIPE_SECRET_KEY) throw new HttpError(503, "Store is closed");
      const body = await readJson<{ productId?: unknown }>(req);
      if (typeof body.productId !== "string") throw new HttpError(400, "productId is required");
      const player = await env.DB.prepare("SELECT email FROM players WHERE id = ?1").bind(id).first<{ email: string | null }>();
      if (s.require_account_for_purchase && !player?.email) {
        return json(
          { error: "Link an email to your account before purchasing, so you never lose what you buy.", code: "account_required" },
          { status: 403 },
        );
      }
      const product = await env.DB.prepare(
        "SELECT id, kind, entitlement, stripe_price_id FROM products WHERE id = ?1 AND active = 1",
      )
        .bind(body.productId)
        .first<{ id: string; kind: string; entitlement: string; stripe_price_id: string | null }>();
      if (!product?.stripe_price_id) throw new HttpError(404, "Product unavailable");
      if (product.kind !== "tip") {
        const owned = await env.DB.prepare(
          "SELECT 1 FROM entitlements WHERE player_id = ?1 AND entitlement = ?2 AND revoked_at IS NULL",
        ).bind(id, product.entitlement).first();
        if (owned) throw new HttpError(409, "You already own this");
      }
      const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
        priceId: product.stripe_price_id,
        playerId: id,
        productId: product.id,
        customerEmail: player?.email ?? undefined,
        successUrl: `${url.origin}/?purchase=success`,
        cancelUrl: `${url.origin}/?purchase=cancelled`,
      });
      return json({ url: session.url });
    },
  },
  {
    method: "POST",
    path: "/api/stripe/webhook",
    handler: ({ req, env }) => handleStripeWebhook(req, env),
  },
];

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "Webhook not configured");
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) throw new HttpError(400, "Bad signature");

  const action = parseStripeEvent(payload);
  // Every handler is idempotent: Stripe retries and may deliver out of order.
  switch (action.kind) {
    case "checkout":
      return json({ received: true, ...(await onCheckout(env, action)) });
    case "checkout_failed": {
      await env.DB.prepare(
        "UPDATE purchases SET status = 'failed', updated_at = ?2 WHERE stripe_session_id = ?1 AND status = 'pending'",
      ).bind(action.sessionId, nowMs()).run();
      return json({ received: true });
    }
    case "refund":
      return json({ received: true, ...(await onRefund(env, action)) });
    case "dispute":
      return json({ received: true, ...(await onDispute(env, action)) });
    case "dispute_closed":
      return json({ received: true, ...(await onDisputeClosed(env, action)) });
    case "ignored":
      return json({ received: true, ignored: action.reason });
  }
}

/** Follows merged_into so a checkout started on a device that later signed in lands on the account. */
async function resolvePlayer(env: Env, id: string): Promise<string | null> {
  let cur = id;
  for (let hop = 0; hop < 4; hop++) {
    const row = await env.DB.prepare("SELECT merged_into FROM players WHERE id = ?1").bind(cur).first<{ merged_into: string | null }>();
    if (!row) return null;
    if (!row.merged_into) return cur;
    cur = row.merged_into;
  }
  return cur;
}

/** Grants the entitlement only if the purchase is (still) paid: a redelivered event can't undo a refund. */
function grantIfPaid(env: Env, sessionId: string, playerId: string, entitlement: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO entitlements (player_id, entitlement, source, granted_at)
     SELECT ?1, ?2, 'stripe', ?3 WHERE EXISTS (SELECT 1 FROM purchases WHERE stripe_session_id = ?4 AND status = 'paid')
     ON CONFLICT(player_id, entitlement) DO UPDATE SET revoked_at = NULL, granted_at = excluded.granted_at
       WHERE entitlements.revoked_at IS NOT NULL`,
  ).bind(playerId, entitlement, now, sessionId);
}

/** Revokes a Stripe-granted entitlement unless another paid purchase still grants it. Admin grants are left alone. */
function revokeUnlessStillOwned(env: Env, playerId: string, entitlement: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE entitlements SET revoked_at = ?3
     WHERE player_id = ?1 AND entitlement = ?2 AND source = 'stripe' AND revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM purchases p JOIN products pr ON pr.id = p.product_id
         WHERE p.player_id = ?1 AND pr.entitlement = ?2 AND p.status = 'paid'
       )`,
  ).bind(playerId, entitlement, now);
}

async function onCheckout(env: Env, a: Extract<StripeAction, { kind: "checkout" }>): Promise<Record<string, unknown>> {
  if (!a.playerId || !a.productId) return { ignored: "missing metadata" };
  const product = await env.DB.prepare("SELECT kind, entitlement FROM products WHERE id = ?1")
    .bind(a.productId)
    .first<{ kind: string; entitlement: string }>();
  if (!product) return { ignored: "unknown product" };
  const now = nowMs();
  const resolved = await resolvePlayer(env, a.playerId);
  const playerId = resolved ?? a.playerId;
  // Money arrived for a player that no longer exists: record it, audit it, grant nothing.
  const playerExists = resolved !== null;
  const status = a.paid ? "paid" : "pending";

  // The purchase row (keyed by Checkout Session id) is the idempotency key.
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO purchases
       (stripe_session_id, player_id, product_id, amount_cents, currency, status, created_at, payment_intent, customer_email, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7)`,
  ).bind(a.sessionId, playerId, a.productId, a.amountCents, a.currency, status, now, a.paymentIntent, a.customerEmail);
  const promote = env.DB.prepare(
    `UPDATE purchases SET status = 'paid', payment_intent = COALESCE(payment_intent, ?2), amount_cents = ?3, updated_at = ?4
     WHERE stripe_session_id = ?1 AND status = 'pending'`,
  ).bind(a.sessionId, a.paymentIntent, a.amountCents, now);

  const stmts = a.paid ? [insert, promote] : [insert];
  if (a.paid && playerExists) stmts.push(grantIfPaid(env, a.sessionId, playerId, product.entitlement, now));
  // Insert, promotion and grant commit together (a D1 batch is one transaction).
  const res = await env.DB.batch(stmts);
  const inserted = res[0]!.meta.changes > 0;
  const promoted = a.paid && res[1]!.meta.changes > 0;
  const newlyPaid = a.paid && (inserted || promoted);

  if (newlyPaid) {
    await env.DB.batch([
      bumpStat(env, "purchases"),
      bumpStat(env, "revenue_cents", a.amountCents),
      bumpStat(env, `purchases_${a.productId}`),
      ...(product.kind === "tip" ? [bumpStat(env, "tips"), bumpStat(env, "tip_cents", a.amountCents)] : []),
      audit(env, "system", playerExists ? "purchase.paid" : "purchase.orphaned", playerId, {
        session: a.sessionId,
        product: a.productId,
        amount: a.amountCents,
        currency: a.currency,
        via: a.eventType,
      }),
    ]);
  }
  return { status: newlyPaid ? "fulfilled" : inserted ? "pending" : "duplicate" };
}

interface PurchaseRow {
  stripe_session_id: string;
  player_id: string;
  product_id: string;
  status: string;
  amount_cents: number;
  refunded_cents: number;
  entitlement: string | null;
}

async function findByPaymentIntent(env: Env, pi: string): Promise<PurchaseRow | null> {
  return env.DB.prepare(
    `SELECT p.stripe_session_id, p.player_id, p.product_id, p.status, p.amount_cents, p.refunded_cents, pr.entitlement
     FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id WHERE p.payment_intent = ?1`,
  ).bind(pi).first<PurchaseRow>();
}

async function onRefund(env: Env, a: Extract<StripeAction, { kind: "refund" }>): Promise<Record<string, unknown>> {
  const p = await findByPaymentIntent(env, a.paymentIntent);
  if (!p) return { ignored: "unknown payment_intent" };
  const now = nowMs();
  const delta = Math.max(0, a.amountRefunded - p.refunded_cents);

  if (a.fullyRefunded) {
    const stmts = [
      env.DB.prepare(
        `UPDATE purchases SET status = 'refunded', refunded_cents = MAX(refunded_cents, ?2), updated_at = ?3
         WHERE stripe_session_id = ?1 AND status IN ('paid', 'disputed', 'pending')`,
      ).bind(p.stripe_session_id, a.amountRefunded, now),
    ];
    if (p.entitlement) stmts.push(revokeUnlessStillOwned(env, p.player_id, p.entitlement, now));
    const res = await env.DB.batch(stmts);
    if (res[0]!.meta.changes === 0) return { status: "duplicate" };
    await env.DB.batch([
      bumpStat(env, "refunds"),
      bumpStat(env, "refunded_cents", delta),
      audit(env, "system", "purchase.refunded", p.player_id, {
        session: p.stripe_session_id,
        product: p.product_id,
        refunded: a.amountRefunded,
        revoked: (res[1]?.meta.changes ?? 0) > 0,
      }),
    ]);
    return { status: "refunded", revoked: (res[1]?.meta.changes ?? 0) > 0 };
  }

  // Partial refund: keep the item, record the money.
  const r = await env.DB.prepare(
    "UPDATE purchases SET refunded_cents = ?2, updated_at = ?3 WHERE stripe_session_id = ?1 AND refunded_cents < ?2",
  ).bind(p.stripe_session_id, a.amountRefunded, now).run();
  if (r.meta.changes === 0) return { status: "duplicate" };
  await env.DB.batch([
    bumpStat(env, "refunded_cents", delta),
    audit(env, "system", "purchase.partial_refund", p.player_id, { session: p.stripe_session_id, refunded: a.amountRefunded }),
  ]);
  return { status: "partially_refunded" };
}

async function onDispute(env: Env, a: Extract<StripeAction, { kind: "dispute" }>): Promise<Record<string, unknown>> {
  const p = await findByPaymentIntent(env, a.paymentIntent);
  if (!p) return { ignored: "unknown payment_intent" };
  const now = nowMs();
  const stmts = [
    env.DB.prepare("UPDATE purchases SET status = 'disputed', updated_at = ?2 WHERE stripe_session_id = ?1 AND status = 'paid'").bind(
      p.stripe_session_id,
      now,
    ),
  ];
  if (p.entitlement) stmts.push(revokeUnlessStillOwned(env, p.player_id, p.entitlement, now));
  const res = await env.DB.batch(stmts);
  if (res[0]!.meta.changes === 0) return { status: "duplicate" };
  await env.DB.batch([
    bumpStat(env, "disputes"),
    bumpStat(env, "disputed_cents", a.amount),
    audit(env, "system", "purchase.disputed", p.player_id, { session: p.stripe_session_id, product: p.product_id, reason: a.reason }),
  ]);
  return { status: "disputed" };
}

async function onDisputeClosed(env: Env, a: Extract<StripeAction, { kind: "dispute_closed" }>): Promise<Record<string, unknown>> {
  if (!a.won) return { status: "dispute_lost" }; // Stays disputed and revoked.
  const p = await findByPaymentIntent(env, a.paymentIntent);
  if (!p) return { ignored: "unknown payment_intent" };
  const now = nowMs();
  const stmts = [
    env.DB.prepare("UPDATE purchases SET status = 'paid', updated_at = ?2 WHERE stripe_session_id = ?1 AND status = 'disputed'").bind(
      p.stripe_session_id,
      now,
    ),
  ];
  const exists = await env.DB.prepare("SELECT 1 FROM players WHERE id = ?1").bind(p.player_id).first();
  if (p.entitlement && exists) stmts.push(grantIfPaid(env, p.stripe_session_id, p.player_id, p.entitlement, now));
  const res = await env.DB.batch(stmts);
  if (res[0]!.meta.changes === 0) return { status: "duplicate" };
  await env.DB.batch([audit(env, "system", "purchase.dispute_won", p.player_id, { session: p.stripe_session_id })]);
  return { status: "reinstated" };
}
