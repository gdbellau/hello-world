// Typed client for the account and store endpoints. UI lives in account.ts / store.ts.
import { call, setToken } from "./api";

export interface PurchaseInfo {
  productId: string;
  name: string;
  amountCents: number;
  currency: string;
  status: "pending" | "paid" | "refunded" | "disputed" | "failed" | string;
  createdAt: number;
}

export interface AccountInfo {
  playerId: string;
  email: string | null;
  linked: boolean;
  corpName: string | null;
  accountsEnabled: boolean;
  loginLinkTtlMinutes: number;
  entitlements: string[];
  purchases: PurchaseInfo[];
}

export interface StoreProduct {
  id: string;
  name: string;
  description: string;
  kind: "supporter" | "cosmetic" | "expansion" | "tip" | string;
  price_cents: number;
  currency: string;
  entitlement: string;
}

export interface StoreCatalog {
  enabled: boolean;
  banner: string;
  requireAccount: boolean;
  currencyDisplay: string;
  signedIn: boolean;
  email: string | null;
  owned: string[];
  products: StoreProduct[];
}

export interface VerifyResult {
  token: string;
  playerId: string;
  email: string;
  merged: boolean;
  mergedEntitlements: number;
  switched: boolean;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const getAccount = () => call<AccountInfo>("/api/account");
export const getCatalog = () => call<StoreCatalog>("/api/store/products");
export const requestLoginLink = (email: string) =>
  post<{ ok: true; message: string; devLink?: string }>("/api/account/request-link", { email });
export const verifyLogin = (token: string) => post<VerifyResult>("/api/account/verify", { token });
export const startCheckout = (productId: string) => post<{ url: string }>("/api/store/checkout", { productId });

// --- Session switching ----------------------------------------------------------
// Must match TOKEN_KEY in api.ts (read-only here, to detect a racing overwrite).
const TOKEN_KEY = "cabal.token";
const PENDING_KEY = "cabal.pendingLogin";
const NOTICE_KEY = "cabal.accountNotice";

const ss = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  del: (k: string) => {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

const storedToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

/** Persists a different player's token and reloads so every screen starts from that identity. */
export function switchSession(token: string, notice?: string): Promise<never> {
  ss.set(PENDING_KEY, token);
  if (notice) ss.set(NOTICE_KEY, notice);
  setToken(token);
  location.reload();
  return new Promise<never>(() => {}); // The page is going away.
}

/**
 * If a boot-time /api/session overwrote the token we just switched to (it can
 * resolve between our setToken and the reload), put ours back and reload once.
 * Returns true when a reload is under way.
 */
export function reapplyPendingSession(): boolean {
  const pending = ss.get(PENDING_KEY);
  if (!pending) return false;
  ss.del(PENDING_KEY);
  if (storedToken() === pending) return false;
  setToken(pending);
  location.reload();
  return true;
}

export function takeNotice(): string | null {
  const n = ss.get(NOTICE_KEY);
  if (n) ss.del(NOTICE_KEY);
  return n;
}

export async function logout(): Promise<never> {
  const r = await post<{ token: string }>("/api/account/logout");
  return switchSession(r.token, "Signed out on every device. This device has a fresh identity.");
}

const STALE = /^(Session expired|Unknown player|Not signed in)$/;
export const isStaleSessionError = (e: unknown) => e instanceof Error && STALE.test(e.message);

/**
 * A token invalidated elsewhere (logout everywhere, merge) can't be refreshed by
 * /api/session, so swap it for a fresh anonymous identity. Guarded against loops.
 */
export async function recoverStaleSession(): Promise<boolean> {
  const last = Number(ss.get("cabal.recoveredAt") ?? 0);
  if (Date.now() - last < 30_000) return false;
  ss.set("cabal.recoveredAt", String(Date.now()));
  try {
    const s = await call<{ token: string }>("/api/session", { method: "POST", body: "{}" });
    await switchSession(s.token, "Your session ended (signed out elsewhere). Sign in again to restore purchases.");
    return true;
  } catch {
    return false;
  }
}

export const hasStoredToken = () => Boolean(storedToken());
