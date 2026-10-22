export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "thecabal.cloudflareaccess.com"
  ACCESS_AUD: string; // Application Audience (AUD) tag
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Local dev only: identity used for /admin when the request is to localhost. */
  DEV_ADMIN_EMAIL?: string;
}
