export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "thecabal.cloudflareaccess.com"
  ACCESS_AUD: string; // Application Audience (AUD) tag
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Resend API key for sign-in emails. Unset locally: links are logged (and returned on localhost). */
  RESEND_API_KEY?: string;
  /** Verified sender, e.g. "THE CABAL <login@mail.example.com>". */
  EMAIL_FROM?: string;
  /** Canonical public origin for links in emails, e.g. "https://thecabal.example". Falls back to the request origin. */
  APP_ORIGIN?: string;
  /** Local dev only: identity used for /admin when the request is to localhost. */
  DEV_ADMIN_EMAIL?: string;
}
