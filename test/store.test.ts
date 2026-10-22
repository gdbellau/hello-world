import { describe, expect, it } from "vitest";
import { checkoutForm, createCheckoutSession, parseStripeEvent } from "../worker/stripe";

const ev = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: "evt_1", type, data: { object } });

describe("checkout form", () => {
  const base = {
    priceId: "price_123",
    playerId: "p-1",
    productId: "skins-chrome",
    successUrl: "https://g.example/?purchase=success",
    cancelUrl: "https://g.example/?purchase=cancelled",
  };

  it("encodes line items, metadata and payment_intent metadata", () => {
    const f = checkoutForm(base);
    expect(f.get("mode")).toBe("payment");
    expect(f.get("line_items[0][price]")).toBe("price_123");
    expect(f.get("line_items[0][quantity]")).toBe("1");
    expect(f.get("client_reference_id")).toBe("p-1");
    expect(f.get("metadata[player_id]")).toBe("p-1");
    expect(f.get("metadata[product_id]")).toBe("skins-chrome");
    expect(f.get("payment_intent_data[metadata][player_id]")).toBe("p-1");
    expect(f.has("customer_email")).toBe(false);
    expect(f.toString()).toContain("success_url=https%3A%2F%2Fg.example%2F%3Fpurchase%3Dsuccess");
  });

  it("passes customer_email when the account is linked", () => {
    expect(checkoutForm({ ...base, customerEmail: "a+b@x.io" }).get("customer_email")).toBe("a+b@x.io");
  });

  it("posts to Stripe and surfaces errors", async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_u: unknown, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }));
    }) as unknown as typeof fetch;
    expect(await createCheckoutSession("sk_test", base, ok)).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect((seen!.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
    const bad = (async () => new Response(JSON.stringify({ error: { message: "No such price" } }), { status: 400 })) as unknown as typeof fetch;
    await expect(createCheckoutSession("sk_test", base, bad)).rejects.toThrow(/No such price/);
  });
});

describe("stripe event parsing", () => {
  const session = {
    id: "cs_1",
    payment_status: "paid",
    amount_total: 499,
    currency: "EUR",
    payment_intent: "pi_1",
    client_reference_id: "p-ref",
    metadata: { player_id: "p-1", product_id: "supporter-pack" },
    customer_details: { email: "buyer@x.io" },
  };

  it("parses a paid checkout", () => {
    expect(parseStripeEvent(ev("checkout.session.completed", session))).toEqual({
      kind: "checkout",
      eventType: "checkout.session.completed",
      sessionId: "cs_1",
      playerId: "p-1",
      productId: "supporter-pack",
      paid: true,
      amountCents: 499,
      currency: "eur",
      paymentIntent: "pi_1",
      customerEmail: "buyer@x.io",
    });
  });

  it("treats an unpaid (async) completion as pending and async success as paid", () => {
    const unpaid = parseStripeEvent(ev("checkout.session.completed", { ...session, payment_status: "unpaid" }));
    expect(unpaid).toMatchObject({ kind: "checkout", paid: false });
    const later = parseStripeEvent(ev("checkout.session.async_payment_succeeded", { ...session, payment_status: "unpaid" }));
    expect(later).toMatchObject({ kind: "checkout", paid: true });
    expect(parseStripeEvent(ev("checkout.session.async_payment_failed", session))).toEqual({ kind: "checkout_failed", sessionId: "cs_1" });
  });

  it("records pay-what-you-want amounts and falls back to client_reference_id", () => {
    const tip = parseStripeEvent(
      ev("checkout.session.completed", { ...session, amount_total: 1337, metadata: { product_id: "tip-jar" }, payment_intent: { id: "pi_x" } }),
    );
    expect(tip).toMatchObject({ amountCents: 1337, playerId: "p-ref", productId: "tip-jar", paymentIntent: "pi_x" });
  });

  it("parses full and partial refunds", () => {
    expect(parseStripeEvent(ev("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 499, amount_refunded: 499, refunded: true }))).toEqual({
      kind: "refund",
      paymentIntent: "pi_1",
      chargeId: "ch_1",
      amountRefunded: 499,
      fullyRefunded: true,
    });
    expect(parseStripeEvent(ev("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 499, amount_refunded: 100, refunded: false }))).toMatchObject({
      fullyRefunded: false,
      amountRefunded: 100,
    });
  });

  it("parses disputes", () => {
    expect(parseStripeEvent(ev("charge.dispute.created", { id: "dp_1", charge: "ch_1", payment_intent: "pi_1", amount: 499, reason: "fraudulent" }))).toEqual({
      kind: "dispute",
      paymentIntent: "pi_1",
      chargeId: "ch_1",
      amount: 499,
      reason: "fraudulent",
    });
    expect(parseStripeEvent(ev("charge.dispute.closed", { payment_intent: "pi_1", status: "won" }))).toEqual({
      kind: "dispute_closed",
      paymentIntent: "pi_1",
      won: true,
    });
    expect(parseStripeEvent(ev("charge.dispute.closed", { payment_intent: "pi_1", status: "lost" }))).toMatchObject({ won: false });
  });

  it("ignores junk, unknown events and missing ids without throwing", () => {
    expect(parseStripeEvent("not json").kind).toBe("ignored");
    expect(parseStripeEvent(ev("customer.created", {})).kind).toBe("ignored");
    expect(parseStripeEvent(ev("charge.refunded", { id: "ch_1" })).kind).toBe("ignored");
    expect(parseStripeEvent(ev("checkout.session.completed", { payment_status: "paid" })).kind).toBe("ignored");
    expect(parseStripeEvent(JSON.stringify({ type: "charge.refunded", data: null })).kind).toBe("ignored");
    expect(parseStripeEvent(ev("checkout.session.completed", { ...session, amount_total: "999" }))).toMatchObject({ amountCents: 0 });
  });
});
