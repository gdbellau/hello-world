// Verifies the Cloudflare Access JWT that Access injects into every request it
// lets through. Access itself blocks unauthenticated traffic at the edge; this
// check is defence in depth so /admin can never be reached by bypassing Access
// (e.g. via a workers.dev URL or a misconfigured Access application).

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(segment))) as T;
}

async function getKeys(certsUrl: string, fetcher: typeof fetch, force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.url === certsUrl && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetcher(certsUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { url: certsUrl, keys: body.keys, fetchedAt: now };
  return body.keys;
}

export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; fetcher?: typeof fetch; now?: number },
): Promise<AccessIdentity> {
  const fetcher = opts.fetcher ?? fetch;
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const [h, p, sig] = parts as [string, string, string];

  const header = decodeJson<{ alg: string; kid: string }>(h);
  if (header.alg !== "RS256") throw new Error("Unexpected JWT alg");

  const issuer = `https://${opts.teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = await getKeys(certsUrl, fetcher);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Access rotates keys; refetch once before giving up.
    keys = await getKeys(certsUrl, fetcher, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("Bad JWT signature");

  const claims = decodeJson<{ aud: string | string[]; iss: string; exp: number; nbf?: number; email?: string; sub: string }>(p);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.aud)) throw new Error("JWT audience mismatch");
  if (claims.iss !== issuer) throw new Error("JWT issuer mismatch");
  if (claims.exp <= nowSec) throw new Error("JWT expired");
  if (claims.nbf !== undefined && claims.nbf > nowSec + 60) throw new Error("JWT not yet valid");
  if (!claims.email) throw new Error("JWT has no email (service tokens are not allowed)");

  return { email: claims.email, sub: claims.sub };
}

/** Test hook. */
export function _resetJwksCache(): void {
  jwksCache = null;
}
