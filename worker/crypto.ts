const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Player tokens are "<playerId>.<hmac>" so the Worker can authenticate a
// player without a D1 read.
export async function signPlayerToken(secret: string, playerId: string): Promise<string> {
  return `${playerId}.${await hmacSha256Hex(secret, `player:${playerId}`)}`;
}

export async function verifyPlayerToken(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const expected = await hmacSha256Hex(secret, `player:${id}`);
  return timingSafeEqual(expected, token.slice(dot + 1)) ? id : null;
}
