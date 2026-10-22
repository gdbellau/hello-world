// Player accounts: email magic-link login, account linking, purchase restore.
//
// Identity model: every device starts as an anonymous player (POST /api/session).
// Verifying an email either attaches it to the current anonymous player, or, when
// the email already belongs to another player, signs the device in as that player
// and merges the anonymous player's entitlements into it (paid items are never lost).
import { optionalPlayer, requirePlayer } from "../auth";
import { randomToken, sha256Hex, signPlayerToken } from "../crypto";
import { audit, bumpStat, loadSettings, nowMs } from "../db";
import { isLocalHost, isLoginTokenShape, loginEmail, normaliseEmail, sendEmail } from "../email";
import type { Env } from "../env";
import { HttpError, json, readJson } from "../http";
import type { Route } from "../router";

const HOUR_MS = 3_600_000;
const GENERIC_SENT = "If that address can receive mail, a sign-in link is on its way. Check your inbox (and spam).";

/** Fixed-window counter in D1: one upsert per bucket. Returns the statement; read `count` from the result. */
function hitStmt(env: Env, bucket: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(bucket, now - (now % HOUR_MS));
}

async function newAnonymousPlayer(env: Env, email: string | null = null): Promise<{ id: string; token: string }> {
  const s = await loadSettings(env);
  const id = crypto.randomUUID();
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO players (id, created_at, last_seen_at, credits, email, email_verified_at) VALUES (?1, ?2, ?2, ?3, ?4, ?5)",
    ).bind(id, now, Number(s.starting_credits), email, email ? now : null),
    bumpStat(env, "new_players"),
    ...(email ? [bumpStat(env, "accounts_linked")] : []),
  ]);
  return { id, token: await signPlayerToken(env.SESSION_SECRET, id) };
}

interface PlayerRow {
  id: string;
  email: string | null;
  token_version: number;
  banned: number;
}

export const accountRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/account",
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const s = await loadSettings(env);
      const [player, ents, purchases] = await env.DB.batch([
        env.DB.prepare("SELECT id, email, email_verified_at, corp_name FROM players WHERE id = ?1").bind(id),
        env.DB.prepare("SELECT entitlement FROM entitlements WHERE player_id = ?1 AND revoked_at IS NULL").bind(id),
        env.DB.prepare(
          `SELECT p.product_id AS productId, COALESCE(pr.name, p.product_id) AS name, p.amount_cents AS amountCents,
                  p.currency, p.status, p.created_at AS createdAt
           FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id
           WHERE p.player_id = ?1 ORDER BY p.created_at DESC LIMIT 50`,
        ).bind(id),
      ]);
      const p = player!.results[0] as { id: string; email: string | null; corp_name: string } | undefined;
      return json(
        {
          playerId: id,
          email: p?.email ?? null,
          linked: Boolean(p?.email),
          corpName: p?.corp_name ?? null,
          accountsEnabled: s.accounts_enabled,
          loginLinkTtlMinutes: s.login_link_ttl_minutes,
          entitlements: (ents!.results as { entitlement: string }[]).map((r) => r.entitlement),
          purchases: purchases!.results,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  },
  {
    method: "POST",
    path: "/api/account/request-link",
    async handler({ req, env, url }) {
      const s = await loadSettings(env);
      if (!s.accounts_enabled) throw new HttpError(503, "Sign-in is temporarily unavailable");
      const body = await readJson<{ email?: unknown }>(req);
      const email = normaliseEmail(body.email);
      if (!email) throw new HttpError(400, "Enter a valid email address");

      const now = nowMs();
      const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
      const [byEmail, byIp] = await env.DB.batch([
        hitStmt(env, `login:email:${await sha256Hex(email)}`, now),
        hitStmt(env, `login:ip:${ip}`, now),
      ]);
      const emailCount = (byEmail!.results[0] as { count: number } | undefined)?.count ?? 1;
      const ipCount = (byIp!.results[0] as { count: number } | undefined)?.count ?? 1;
      // Same response whether limited, unknown or known: no account enumeration.
      if (emailCount > Number(s.login_rate_limit_per_hour) || ipCount > Number(s.login_ip_rate_limit_per_hour)) {
        console.log(`login link rate-limited (email ${emailCount}, ip ${ipCount})`);
        return json({ ok: true, message: GENERIC_SENT });
      }

      const token = randomToken();
      const ttl = Number(s.login_link_ttl_minutes);
      await env.DB.prepare(
        "INSERT INTO login_tokens (token_hash, email, created_at, expires_at, ip) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(await sha256Hex(token), email, now, now + ttl * 60_000, ip).run();

      // Opportunistic cleanup keeps the tables tiny without a cron (≈1 in 20 requests).
      if (Math.random() < 0.05) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - 2 * HOUR_MS),
          env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?1").bind(now - 24 * HOUR_MS),
        ]);
      }

      const origin = (env.APP_ORIGIN || url.origin).replace(/\/+$/, "");
      const link = `${origin}/?login=${token}`;
      if (env.RESEND_API_KEY && env.EMAIL_FROM) {
        await sendEmail(env, loginEmail(email, String(s.login_email_subject), link, ttl));
        return json({ ok: true, message: GENERIC_SENT });
      }
      console.log(`[dev] no RESEND_API_KEY; sign-in link for ${email}: ${link}`);
      return json({ ok: true, message: GENERIC_SENT, ...(isLocalHost(url) ? { devLink: link } : {}) });
    },
  },
  {
    method: "POST",
    path: "/api/account/verify",
    async handler({ req, env }) {
      const s = await loadSettings(env);
      if (!s.accounts_enabled) throw new HttpError(503, "Sign-in is temporarily unavailable");
      const body = await readJson<{ token?: unknown }>(req);
      const bad = new HttpError(400, "This sign-in link is invalid, expired or already used. Request a new one.");
      if (!isLoginTokenShape(body.token)) throw bad;
      // The device's current (usually anonymous) player. Optional so a link opened
      // on a brand-new device still works.
      const currentId = await optionalPlayer(req, env);
      const now = nowMs();

      // Atomic consume: only one request can flip used_at, and only before expiry.
      const consumed = await env.DB.prepare(
        "UPDATE login_tokens SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING email",
      ).bind(await sha256Hex(body.token), now).first<{ email: string }>();
      if (!consumed) throw bad;
      const email = consumed.email;

      const [ownerRes, curRes] = await env.DB.batch([
        env.DB.prepare("SELECT id, email, token_version, banned FROM players WHERE email = ?1").bind(email),
        env.DB.prepare("SELECT id, email, token_version, banned FROM players WHERE id = ?1").bind(currentId ?? ""),
      ]);
      const owner = ownerRes!.results[0] as PlayerRow | undefined;
      const cur = curRes!.results[0] as PlayerRow | undefined;

      if (owner) {
        if (owner.banned) throw new HttpError(403, "Account suspended");
        let merged = false;
        let moved = 0;
        // Merge only a device-only (anonymous) player. Two real accounts are never merged.
        if (cur && cur.id !== owner.id && !cur.email) {
          const count = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM entitlements WHERE player_id = ?1 AND revoked_at IS NULL",
          ).bind(cur.id).first<{ n: number }>();
          moved = count?.n ?? 0;
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO entitlements (player_id, entitlement, source, granted_at)
               SELECT ?1, entitlement, source, granted_at FROM entitlements WHERE player_id = ?2 AND revoked_at IS NULL
               ON CONFLICT(player_id, entitlement) DO UPDATE SET revoked_at = NULL WHERE entitlements.revoked_at IS NOT NULL`,
            ).bind(owner.id, cur.id),
            env.DB.prepare("UPDATE entitlements SET revoked_at = ?2 WHERE player_id = ?1 AND revoked_at IS NULL").bind(cur.id, now),
            // Purchases follow the entitlements so a later refund revokes from the right player.
            env.DB.prepare("UPDATE purchases SET player_id = ?1 WHERE player_id = ?2").bind(owner.id, cur.id),
            // Retire the device identity: its old token stops working.
            env.DB.prepare("UPDATE players SET merged_into = ?1, token_version = token_version + 1 WHERE id = ?2").bind(owner.id, cur.id),
            env.DB.prepare("UPDATE players SET last_seen_at = ?2 WHERE id = ?1").bind(owner.id, now),
            audit(env, "system", "account.merge", owner.id, { from: cur.id, entitlements: moved }),
            bumpStat(env, "account_merges"),
            bumpStat(env, "logins"),
          ]);
          merged = true;
        } else {
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET last_seen_at = ?2 WHERE id = ?1").bind(owner.id, now),
            bumpStat(env, "logins"),
          ]);
        }
        return json({
          token: await signPlayerToken(env.SESSION_SECRET, owner.id, owner.token_version ?? 0),
          playerId: owner.id,
          email,
          merged,
          mergedEntitlements: moved,
          switched: owner.id !== cur?.id,
        });
      }

      // New email. Attach it to the current anonymous player...
      if (cur && !cur.email) {
        const r = await env.DB.prepare(
          "UPDATE players SET email = ?1, email_verified_at = ?2, last_seen_at = ?2 WHERE id = ?3 AND email IS NULL",
        ).bind(email, now, cur.id).run().catch(() => null); // UNIQUE race: someone claimed it a moment ago.
        if (!r || r.meta.changes === 0) throw new HttpError(409, "That link raced another sign-in. Request a new one.");
        await env.DB.batch([bumpStat(env, "accounts_linked"), bumpStat(env, "logins")]);
        return json({
          token: await signPlayerToken(env.SESSION_SECRET, cur.id, cur.token_version ?? 0),
          playerId: cur.id,
          email,
          merged: false,
          mergedEntitlements: 0,
          switched: false,
        });
      }

      // ...or (no session, or the device is signed in to a different account) start a fresh account.
      const fresh = await newAnonymousPlayer(env, email);
      return json({ token: fresh.token, playerId: fresh.id, email, merged: false, mergedEntitlements: 0, switched: true });
    },
  },
  {
    method: "POST",
    path: "/api/account/logout",
    // Tokens are stateless, so logging out bumps token_version: every token for
    // this account (all devices) stops working. The device gets a fresh anonymous
    // player so it keeps playing; signing back in is one email away.
    async handler({ req, env }) {
      const id = await requirePlayer(req, env);
      const p = await env.DB.prepare("SELECT email FROM players WHERE id = ?1").bind(id).first<{ email: string | null }>();
      if (!p?.email) {
        throw new HttpError(400, "This device isn't signed in to an account. Signing out would lose its progress.");
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE players SET token_version = token_version + 1 WHERE id = ?1").bind(id),
        bumpStat(env, "logouts"),
      ]);
      const fresh = await newAnonymousPlayer(env);
      return json({ token: fresh.token, playerId: fresh.id });
    },
  },
];
