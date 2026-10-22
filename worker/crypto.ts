const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

/** URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Player tokens let the Worker authenticate a player without trusting the client.
//   version 0 (legacy): "<playerId>.<hmac('player:<id>')>"
//   version n > 0:      "<playerId>.<n>.<hmac('player:<id>:<n>')>"
// The version is compared with players.token_version in requirePlayer, so bumping
// that column (logout, merge) invalidates every token issued before it. Version 0
// keeps the original format so tokens issued before versioning stay valid.
export async function signPlayerToken(secret: string, playerId: string, version = 0): Promise<string> {
  if (!version) return `${playerId}.${await hmacSha256Hex(secret, `player:${playerId}`)}`;
  return `${playerId}.${version}.${await hmacSha256Hex(secret, `player:${playerId}:${version}`)}`;
}

export interface PlayerTokenClaims {
  id: string;
  version: number;
}

export async function verifyPlayerTokenClaims(secret: string, token: string): Promise<PlayerTokenClaims | null> {
  const parts = token.split(".");
  let id: string;
  let version = 0;
  let msg: string;
  if (parts.length === 2) {
    id = parts[0]!;
    msg = `player:${id}`;
  } else if (parts.length === 3 && /^[1-9]\d{0,8}$/.test(parts[1]!)) {
    id = parts[0]!;
    version = Number(parts[1]);
    msg = `player:${id}:${version}`;
  } else {
    return null;
  }
  if (!id) return null;
  const expected = await hmacSha256Hex(secret, msg);
  return timingSafeEqual(expected, parts[parts.length - 1]!) ? { id, version } : null;
}

/** Signature check only (no version check: that needs D1, see requirePlayer). */
export async function verifyPlayerToken(secret: string, token: string): Promise<string | null> {
  return (await verifyPlayerTokenClaims(secret, token))?.id ?? null;
}
