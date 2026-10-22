import { verifyAccessJwt, type AccessIdentity } from "./access";
import { verifyPlayerToken } from "./crypto";
import type { Env } from "./env";
import { HttpError } from "./http";

export async function requirePlayer(req: Request, env: Env): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const id = token ? await verifyPlayerToken(env.SESSION_SECRET, token) : null;
  if (!id) throw new HttpError(401, "Not signed in");
  const row = await env.DB.prepare("SELECT banned FROM players WHERE id = ?1").bind(id).first<{ banned: number }>();
  if (!row) throw new HttpError(401, "Unknown player");
  if (row.banned) throw new HttpError(403, "Account suspended");
  return id;
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
