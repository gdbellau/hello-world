// Accounts and store client: login, purchase restore, cosmetics.
import type { SettingDef } from "./types";

export const ACCOUNT_SETTINGS: SettingDef[] = [
  // --- Accounts --------------------------------------------------------------
  { key: "accounts_enabled", category: "Accounts", label: "Email sign-in enabled", description: "Kill switch for magic-link sign-in. Existing sessions keep working.", type: "boolean", default: true, public: true },
  { key: "login_link_ttl_minutes", category: "Accounts", label: "Login link lifetime (min)", description: "How long an emailed sign-in link stays valid. Links are single-use.", type: "integer", default: 15, min: 5, max: 1440, public: true },
  { key: "login_rate_limit_per_hour", category: "Accounts", label: "Login emails per address / hour", description: "Sign-in emails sent to one address per hour. Extra requests are silently dropped.", type: "integer", default: 5, min: 1, max: 100, public: false },
  { key: "login_ip_rate_limit_per_hour", category: "Accounts", label: "Login requests per IP / hour", description: "Sign-in link requests accepted from one IP address per hour.", type: "integer", default: 20, min: 1, max: 1000, public: false },
  { key: "login_email_subject", category: "Accounts", label: "Login email subject", description: "Subject line of the sign-in email.", type: "string", default: "Your CABAL uplink code", public: false },

  // --- Store -------------------------------------------------------------------
  { key: "require_account_for_purchase", category: "Store", label: "Require account to purchase", description: "Players must link an email before checkout, so purchases survive a cleared browser.", type: "boolean", default: true, public: true },
  { key: "store_currency_display", category: "Store", label: "Price display", description: "How currencies are shown: symbol, narrowSymbol, code or name.", type: "string", default: "symbol", public: true },
];
