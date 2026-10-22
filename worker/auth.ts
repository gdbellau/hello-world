import { verifyAccessJwt, type AccessIdentity } from "./access";
import { verifyPlayerTokenClaims } from "./crypto";
import type { Env } from "./env";
import { HttpError } from "./http";

export async function requirePlayer(req: Request, env: Env): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const claims = token ? await verifyPlayerTokenClaims(env.SESSION_SECRET, token) : null;
  if (!claims) throw new HttpError(401, "Not signed in");
  const row = await env.DB.prepare("SELECT banned, token_version FROM players WHERE id = ?1")
    .bind(claims.id)
    .first<{ banned: number; token_version: number | null }>();
  if (!row) throw new HttpError(401, "Unknown player");
  if (claims.version !== (row.token_version ?? 0)) throw new HttpError(401, "Session expired");
  if (row.banned) throw new HttpError(403, "Account suspended");
  return claims.id;
}

/** Like requirePlayer, but returns null instead of throwing when there is no valid session. */
export async function optionalPlayer(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("Authorization")) return null;
  try {
    return await requirePlayer(req, env);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return null;
    throw e;
  }
}

export async function requireAdmin(req: Request, env: Env, url: URL): Promise<AccessIdentity> {
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
