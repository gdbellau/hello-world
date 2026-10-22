import { requirePlayer } from "../auth";
import { bumpStat, loadSettings, nowMs } from "../db";
import type { Env } from "../env";
import { HttpError, json, readJson } from "../http";
import type { Route } from "../router";
import { createCheckoutSession, verifyStripeSignature } from "../stripe";

export const storeRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/store/products",
    async handler({ env }) {
      const s = await loadSettings(env);
      const { results } = await env.DB.prepare(
        "SELECT id, name, description, kind, price_cents, currency, entitlement FROM products WHERE active = 1 ORDER BY sort",
      ).all();
      return json({ enabled: s.store_enabled, banner: s.store_banner, products: results });
    },
  },
  {
    method: "POST",
    path: "/api/store/checkout",
    async handler({ req, env, url }) {
      const id = await requirePlayer(req, env);
      const s = await loadSettings(env);
      if (!s.store_enabled || !env.STRIPE_SECRET_KEY) throw new HttpError(503, "Store is closed");
      const body = await readJson<{ productId: string }>(req);
      const product = await env.DB.prepare("SELECT id, stripe_price_id FROM products WHERE id = ?1 AND active = 1")
        .bind(body.productId)
        .first<{ id: string; stripe_price_id: string | null }>();
      if (!product?.stripe_price_id) throw new HttpError(404, "Product unavailable");
      const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
        priceId: product.stripe_price_id,
        playerId: id,
        productId: product.id,
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
