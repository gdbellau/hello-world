// Minimal Stripe client over fetch. The official SDK works on Workers too, but
// we only need two calls and this keeps the bundle and CPU time small.

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
}

export async function createCheckoutSession(
  secretKey: string,
  p: CheckoutParams,
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": p.priceId,
    "line_items[0][quantity]": "1",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    client_reference_id: p.playerId,
    "metadata[player_id]": p.playerId,
    "metadata[product_id]": p.productId,
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const body = (await res.json()) as { id?: string; url?: string; error?: { message: string } };
  if (!res.ok || !body.id || !body.url) {
    throw new Error(`Stripe error: ${body.error?.message ?? res.status}`);
  }
  return { id: body.id, url: body.url };
}
