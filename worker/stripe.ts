// Minimal Stripe client over fetch. The official SDK works on Workers too, but
// we only need one call plus webhook parsing, and this keeps bundle and CPU small.

import { hmacSha256Hex, timingSafeEqual } from "./crypto";

const TOLERANCE_SEC = 300;

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!header) return false;
  let timestamp = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = v;
    else if (k === "v1" && v) v1.push(v);
  }
  const t = Number(timestamp);
  if (!t || v1.length === 0) return false;
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_SEC) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return v1.some((sig) => timingSafeEqual(sig, expected));
}

export interface CheckoutParams {
  priceId: string;
  playerId: string;
  productId: string;
  successUrl: string;
  cancelUrl: string;
  /** Prefills (and links) the Stripe customer email to the player's account. */
  customerEmail?: string;
}

/** Form body for POST /v1/checkout/sessions. Pure, so it's unit-tested. */
export function checkoutForm(p: CheckoutParams): URLSearchParams {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": p.priceId,
    "line_items[0][quantity]": "1",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    client_reference_id: p.playerId,
    "metadata[player_id]": p.playerId,
    "metadata[product_id]": p.productId,
    // Copied onto the PaymentIntent so refunds/disputes in the dashboard show who bought what.
    "payment_intent_data[metadata][player_id]": p.playerId,
    "payment_intent_data[metadata][product_id]": p.productId,
  });
  if (p.customerEmail) form.set("customer_email", p.customerEmail);
  return form;
}

export async function createCheckoutSession(
  secretKey: string,
  p: CheckoutParams,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const res = await fetcher("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: checkoutForm(p),
  });
  const body = (await res.json()) as { id?: string; url?: string; error?: { message: string } };
  if (!res.ok || !body.id || !body.url) {
    throw new Error(`Stripe error: ${body.error?.message ?? res.status}`);
  }
  return { id: body.id, url: body.url };
}

// --- Webhook events ---------------------------------------------------------------

export type StripeAction =
  | {
      kind: "checkout";
      eventType: string;
      sessionId: string;
      playerId: string | null;
      productId: string | null;
      /** True when money has actually arrived (card) or async payment succeeded. */
      paid: boolean;
      amountCents: number;
      currency: string;
      paymentIntent: string | null;
      customerEmail: string | null;
    }
  | { kind: "checkout_failed"; sessionId: string }
  | { kind: "refund"; paymentIntent: string; chargeId: string; amountRefunded: number; fullyRefunded: boolean }
  | { kind: "dispute"; paymentIntent: string; chargeId: string; amount: number; reason: string }
  | { kind: "dispute_closed"; paymentIntent: string; won: boolean }
  | { kind: "ignored"; reason: string };

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Stripe fields like payment_intent are an id string, or an object when expanded. */
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === "object" ? str((v as Obj).id) : null);

/** Turns a (signature-verified) webhook payload into the one thing we need to do. */
export function parseStripeEvent(payload: string): StripeAction {
  let event: { type?: unknown; data?: { object?: unknown } };
  try {
    event = JSON.parse(payload);
  } catch {
    return { kind: "ignored", reason: "invalid json" };
  }
  const type = str(event?.type) ?? "";
  const o = (event?.data?.object ?? {}) as Obj;
  if (typeof o !== "object" || o === null) return { kind: "ignored", reason: "no object" };

  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const sessionId = str(o.id);
      if (!sessionId) return { kind: "ignored", reason: "no session id" };
      const meta = (o.metadata ?? {}) as Obj;
      const status = str(o.payment_status);
      const details = (o.customer_details ?? {}) as Obj;
      return {
        kind: "checkout",
        eventType: type,
        sessionId,
        playerId: str(meta.player_id) ?? str(o.client_reference_id),
        productId: str(meta.product_id),
        paid:
          type === "checkout.session.async_payment_succeeded" ||
          status === "paid" ||
          status === "no_payment_required",
        amountCents: Math.max(0, Math.round(num(o.amount_total))),
        currency: (str(o.currency) ?? "usd").toLowerCase(),
        paymentIntent: idOf(o.payment_intent),
        customerEmail: str(details.email) ?? str(o.customer_email),
      };
    }
    case "checkout.session.async_payment_failed": {
      const sessionId = str(o.id);
      return sessionId ? { kind: "checkout_failed", sessionId } : { kind: "ignored", reason: "no session id" };
    }
    case "charge.refunded": {
      const pi = idOf(o.payment_intent);
      if (!pi) return { kind: "ignored", reason: "charge without payment_intent" };
      const amount = num(o.amount);
      const refunded = num(o.amount_refunded);
      return {
        kind: "refund",
        paymentIntent: pi,
        chargeId: str(o.id) ?? "",
        amountRefunded: refunded,
        fullyRefunded: o.refunded === true || (amount > 0 && refunded >= amount),
      };
    }
    case "charge.dispute.created": {
      const pi = idOf(o.payment_intent);
      if (!pi) return { kind: "ignored", reason: "dispute without payment_intent" };
      return { kind: "dispute", paymentIntent: pi, chargeId: idOf(o.charge) ?? "", amount: num(o.amount), reason: str(o.reason) ?? "" };
    }
    case "charge.dispute.closed": {
      const pi = idOf(o.payment_intent);
      if (!pi) return { kind: "ignored", reason: "dispute without payment_intent" };
      return { kind: "dispute_closed", paymentIntent: pi, won: o.status === "won" };
    }
    default:
      return { kind: "ignored", reason: `unhandled event ${type || "?"}` };
  }
}
