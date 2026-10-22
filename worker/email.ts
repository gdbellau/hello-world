// Tiny Resend client (https://resend.com/docs/api-reference/emails/send-email).
// Free tier: 3,000 emails/month, 100/day. No SDK, just one fetch.

/** The subset of Env this module needs (kept free of Workers types so tests can import it). */
export interface EmailConfig {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends via Resend. Returns false (and logs) on failure; callers must not leak this to the client. */
export async function sendEmail(env: EmailConfig, msg: Email, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  try {
    const res = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) {
      console.error("Resend error", res.status, (await res.text()).slice(0, 500));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend fetch failed", e);
    return false;
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function loginEmail(to: string, subject: string, link: string, ttlMinutes: number): Email {
  const text =
    `Operative,\n\nUse this one-time link to sign in to THE CABAL:\n\n${link}\n\n` +
    `It expires in ${ttlMinutes} minutes and works once. If you didn't ask for it, ignore this email.\n`;
  const html = `<!doctype html><html><body style="margin:0;background:#07061a;font-family:Menlo,Consolas,monospace;color:#d8f9ff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07061a;padding:32px 12px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;border:1px solid #00f0ff;padding:24px">
<tr><td style="color:#ff2bd6;font-size:13px;letter-spacing:3px">THE CABAL // SECURE UPLINK</td></tr>
<tr><td style="padding:16px 0;font-size:15px;line-height:1.5">Use this one-time link to sign in. It expires in ${ttlMinutes} minutes.</td></tr>
<tr><td style="padding:8px 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#00f0ff;color:#07061a;padding:12px 20px;text-decoration:none;font-weight:bold;letter-spacing:2px">SIGN IN</a></td></tr>
<tr><td style="font-size:12px;color:#8a8fb0;word-break:break-all">${esc(link)}</td></tr>
<tr><td style="padding-top:16px;font-size:12px;color:#8a8fb0">Didn't request this? Ignore it; nothing happens.</td></tr>
</table></td></tr></table></body></html>`;
  return { to, subject, text, html };
}

/** Trimmed, lower-cased email, or null when it isn't a plausible address. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  // Deliberately strict: no quotes, spaces, control chars or IP-literal domains.
  if (!/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/.test(e)) return null;
  const [local, domain] = e.split("@") as [string, string];
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (domain.split(".").some((l) => !l || l.startsWith("-") || l.endsWith("-"))) return null;
  return e;
}

/** Login tokens are 32 random bytes, base64url (43 chars). */
export const isLoginTokenShape = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(t);

export const isLocalHost = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";
