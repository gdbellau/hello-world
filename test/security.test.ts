import { beforeEach, describe, expect, it } from "vitest";
import { _resetJwksCache, verifyAccessJwt } from "../worker/access";
import { hmacSha256Hex, signPlayerToken, verifyPlayerToken } from "../worker/crypto";
import { verifyStripeSignature } from "../worker/stripe";

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

describe("player tokens", () => {
  it("round-trips and rejects tampering", async () => {
    const t = await signPlayerToken("s3cret", "abc-123");
    expect(await verifyPlayerToken("s3cret", t)).toBe("abc-123");
    expect(await verifyPlayerToken("other", t)).toBeNull();
    expect(await verifyPlayerToken("s3cret", t.replace("abc", "abd"))).toBeNull();
    expect(await verifyPlayerToken("s3cret", "garbage")).toBeNull();
  });
});

describe("stripe webhook signature", () => {
  const secret = "whsec_test";
  const body = '{"type":"checkout.session.completed"}';
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);

  it("accepts a valid signature", async () => {
    const sig = await hmacSha256Hex(secret, `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, now)).toBe(true);
  });

  it("rejects a bad signature, a modified body, and a stale timestamp", async () => {
    const sig = await hmacSha256Hex(secret, `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)}`, secret, now)).toBe(false);
    expect(await verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, secret, now)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, now + 3600_000)).toBe(false);
    expect(await verifyStripeSignature(body, null, secret, now)).toBe(false);
  });
});

describe("cloudflare access jwt", () => {
  const team = "cabal.cloudflareaccess.com";
  const aud = "aud-tag-123";
  let keys: CryptoKeyPair;
  let jwks: { keys: (JsonWebKey & { kid: string })[] };
  const fetcher = (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch;

  async function sign(claims: Record<string, unknown>, kid = "k1") {
    const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
    const p = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }
  const base = () => ({
    aud: [aud],
    iss: `https://${team}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "boss@cabal.corp",
    sub: "u1",
  });

  beforeEach(async () => {
    _resetJwksCache();
    keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" }] };
  });

  it("accepts a valid token", async () => {
    const id = await verifyAccessJwt(await sign(base()), { teamDomain: team, aud, fetcher });
    expect(id.email).toBe("boss@cabal.corp");
  });

  it("rejects wrong audience, wrong issuer, expiry, unknown key and tampering", async () => {
    const opts = { teamDomain: team, aud, fetcher };
    await expect(verifyAccessJwt(await sign({ ...base(), aud: ["other"] }), opts)).rejects.toThrow(/audience/);
    await expect(verifyAccessJwt(await sign({ ...base(), iss: "https://evil.example" }), opts)).rejects.toThrow(/issuer/);
    await expect(verifyAccessJwt(await sign({ ...base(), exp: 1 }), opts)).rejects.toThrow(/expired/);
    await expect(verifyAccessJwt(await sign(base(), "k2"), opts)).rejects.toThrow(/key/);
    const tok = await sign(base());
    const [h, , s] = tok.split(".");
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...base(), email: "intruder@x.com" })));
    await expect(verifyAccessJwt(`${h}.${forged}.${s}`, opts)).rejects.toThrow(/signature/);
  });
});
