// Account UI: email magic-link sign-in and purchase restore.
// Owned by the accounts & store workstream. Other screens just call openAccount().
//
// Boot integration (main.ts): `await initAccountFlow();` before `startSession()`.
// It handles `?login=<token>` and `?purchase=success|cancelled`. Importing this
// module also runs it once on its own, so it works even before main.ts calls it.
import "./shop.css";
import {
  getAccount,
  hasStoredToken,
  isStaleSessionError,
  logout,
  reapplyPendingSession,
  recoverStaleSession,
  requestLoginLink,
  switchSession,
  takeNotice,
  verifyLogin,
  type AccountInfo,
} from "./account-api";

// --- Tiny DOM toolkit shared with store.ts ---------------------------------------

type Attrs = Record<string, string | boolean | ((ev: Event) => void)>;
/** Element builder. Text goes in via textContent, never innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") e.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== false && c !== undefined) e.append(c);
  return e;
}

let current: { root: HTMLElement; close: () => void } | null = null;

export function closeShopModal(): void {
  current?.close();
}

/** Opens a full-screen neon modal; only one shop/account modal is open at a time. */
export function openShopModal(opts: { kicker: string; title: string; variant: "store" | "account" }): HTMLElement {
  closeShopModal();
  const body = el("div", { class: "cbl-body" });
  const titleId = `cbl-title-${opts.variant}`;
  const closeBtn = el("button", { class: "cbl-x", type: "button", "aria-label": "Close" }, "×");
  const panel = el(
    "div",
    { class: `cbl-panel cbl-panel--${opts.variant}`, tabindex: "-1" },
    el(
      "header",
      { class: "cbl-head" },
      el("div", {}, el("div", { class: "cbl-kicker" }, opts.kicker), el("h2", { id: titleId }, opts.title)),
      closeBtn,
    ),
    body,
  );
  const root = el("div", { class: "cbl-shop cbl-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, panel);
  const prevFocus = document.activeElement as HTMLElement | null;
  const onKey = (ev: KeyboardEvent) => {
    ev.stopPropagation(); // Keep game hotkeys (space, digits) out of form fields.
    if (ev.key === "Escape") close();
  };
  const close = () => {
    root.remove();
    if (current?.root === root) current = null;
    prevFocus?.focus?.();
  };
  closeBtn.addEventListener("click", close);
  root.addEventListener("keydown", onKey);
  root.addEventListener("keyup", (ev) => ev.stopPropagation());
  root.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    if (ev.target === root) close();
  });
  root.addEventListener("mouseup", (ev) => ev.stopPropagation());
  document.body.append(root);
  current = { root, close };
  panel.focus({ preventScroll: true }); // Focus the dialog (not a button) so no ring shows on open.
  return body;
}

export function toast(msg: string, tone: "ok" | "warn" | "err" = "ok"): void {
  const t = el("div", { class: `cbl-shop cbl-toast cbl-toast--${tone}`, role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add("cbl-toast--out"), 4200);
  setTimeout(() => t.remove(), 4800);
}

export const fmtDate = (ms: number) => {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
};

export function fmtMoney(cents: number, currency: string, display = "symbol"): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: display as Intl.NumberFormatOptions["currencyDisplay"],
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

const STATUS_LABEL: Record<string, string> = {
  paid: "PAID",
  pending: "PENDING",
  refunded: "REFUNDED",
  disputed: "DISPUTED",
  failed: "FAILED",
};

const ENT_PREFIX: Record<string, string> = { skin: "Skin", dlc: "Expansion", badge: "Badge", livery: "Livery" };
/** "skin:chrome" → "Skin · Chrome". */
export function prettyEntitlement(key: string): string {
  const cap = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const i = key.indexOf(":");
  if (i < 0) return cap(key);
  const pre = key.slice(0, i);
  return `${ENT_PREFIX[pre] ?? cap(pre)} · ${cap(key.slice(i + 1))}`;
}

// --- Account modal ------------------------------------------------------------------

export interface OpenAccountOptions {
  /** Shown above the form, e.g. why sign-in is needed. */
  reason?: string;
  error?: string;
  /** Called after the modal closes via "Back to store". */
  onBack?: () => void;
}

export function openAccount(opts: OpenAccountOptions = {}): void {
  const body = openShopModal({ kicker: "// SECURE UPLINK", title: "ACCOUNT", variant: "account" });
  body.append(el("p", { class: "cbl-loading" }, "Establishing uplink…"));
  void renderAccount(body, opts);
}

async function renderAccount(body: HTMLElement, opts: OpenAccountOptions): Promise<void> {
  let info: AccountInfo;
  try {
    info = await getAccount();
  } catch (e) {
    if (isStaleSessionError(e) && (await recoverStaleSession())) return;
    body.replaceChildren(
      el("p", { class: "cbl-alert cbl-alert--err" }, "Can't reach the CABAL network right now. Try again in a moment."),
    );
    return;
  }
  body.replaceChildren();
  if (opts.error) body.append(el("p", { class: "cbl-alert cbl-alert--err" }, opts.error));
  if (opts.reason && !info.linked) body.append(el("p", { class: "cbl-alert cbl-alert--warn" }, opts.reason));

  if (info.linked) {
    body.append(
      el(
        "div",
        { class: "cbl-idcard" },
        el("span", { class: "cbl-dot cbl-dot--on" }),
        el("div", {}, el("div", { class: "cbl-label" }, "SIGNED IN AS"), el("div", { class: "cbl-email" }, info.email ?? "")),
      ),
      el("p", { class: "cbl-muted" }, "Your purchases are tied to this account and restore on any device you sign in from."),
    );
  } else {
    body.append(
      el(
        "div",
        { class: "cbl-idcard" },
        el("span", { class: "cbl-dot" }),
        el("div", {}, el("div", { class: "cbl-label" }, "IDENTITY"), el("div", { class: "cbl-email" }, "Anonymous device")),
      ),
      el(
        "p",
        { class: "cbl-muted" },
        "Link an email so purchases survive a cleared browser or a new device. Already have an account? Enter its email: this device signs in to it and anything unlocked here comes with you.",
      ),
    );
    if (info.accountsEnabled) body.append(loginForm(info.loginLinkTtlMinutes));
    else body.append(el("p", { class: "cbl-alert cbl-alert--warn" }, "Sign-in is temporarily offline."));
  }

  if (info.entitlements.length) {
    body.append(
      el("h3", {}, "UNLOCKED"),
      el("div", { class: "cbl-chips" }, ...info.entitlements.map((e) => el("span", { class: "cbl-chip", title: e }, prettyEntitlement(e)))),
    );
  }

  if (info.purchases.length) {
    body.append(
      el("h3", {}, "PURCHASE LOG"),
      el(
        "ul",
        { class: "cbl-log" },
        ...info.purchases.map((p) =>
          el(
            "li",
            {},
            el("span", { class: "cbl-log-name" }, p.name),
            el("span", { class: "cbl-log-date" }, fmtDate(p.createdAt)),
            el("span", { class: "cbl-log-amt" }, fmtMoney(p.amountCents, p.currency)),
            el("span", { class: `cbl-tag cbl-tag--${p.status}` }, STATUS_LABEL[p.status] ?? p.status.toUpperCase()),
          ),
        ),
      ),
    );
  }

  const actions = el("div", { class: "cbl-actions" });
  if (opts.onBack) {
    const back = opts.onBack;
    actions.append(el("button", { class: "cbl-btn cbl-btn--ghost", type: "button", onclick: () => back() }, "← Back to store"));
  }
  if (info.linked) {
    actions.append(
      el(
        "button",
        {
          class: "cbl-btn cbl-btn--danger",
          type: "button",
          onclick: async (ev) => {
            const b = ev.currentTarget as HTMLButtonElement;
            if (!confirm("Sign out on every device? You can sign back in with an email link.")) return;
            b.disabled = true;
            b.textContent = "Signing out…";
            try {
              await logout();
            } catch (e) {
              b.disabled = false;
              b.textContent = "Sign out everywhere";
              toast((e as Error).message, "err");
            }
          },
        },
        "Sign out everywhere",
      ),
    );
  }
  if (actions.childElementCount) body.append(actions);
}

function loginForm(ttl: number): HTMLElement {
  const input = el("input", {
    class: "cbl-input",
    type: "email",
    name: "email",
    autocomplete: "email",
    inputmode: "email",
    placeholder: "operative@domain.net",
    required: true,
    maxlength: "254",
    "aria-label": "Email address",
  });
  const btn = el("button", { class: "cbl-btn", type: "submit" }, "Send link");
  const status = el("div", { class: "cbl-status", "aria-live": "polite" });
  const form = el("form", { class: "cbl-form", novalidate: true }, el("div", { class: "cbl-row" }, input, btn), status);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      status.replaceChildren(el("p", { class: "cbl-alert cbl-alert--err" }, "That doesn't look like an email address."));
      input.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const r = await requestLoginLink(email);
      status.replaceChildren(
        el(
          "p",
          { class: "cbl-alert cbl-alert--ok" },
          `${r.message} The link works once and expires in ${ttl} minutes. You can close this window.`,
        ),
      );
      if (r.devLink) {
        status.append(el("a", { class: "cbl-btn cbl-btn--ghost cbl-devlink", href: r.devLink }, "Dev: open sign-in link"));
      }
      btn.textContent = "Resend";
    } catch (e) {
      status.replaceChildren(el("p", { class: "cbl-alert cbl-alert--err" }, (e as Error).message));
      btn.textContent = "Send link";
    } finally {
      btn.disabled = false;
    }
  });
  queueMicrotask(() => input.focus());
  return form;
}

// --- Boot flow ------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

/** Idempotent. Call at boot before startSession(); safe to call more than once. */
export function initAccountFlow(): Promise<void> {
  initPromise ??= runInit().catch((e) => console.warn("account flow", e));
  return initPromise;
}

async function runInit(): Promise<void> {
  if (reapplyPendingSession()) return new Promise<void>(() => {});
  const notice = takeNotice();
  if (notice) setTimeout(() => toast(notice), 300);

  const params = new URLSearchParams(location.search);
  const login = params.get("login");
  const purchase = params.get("purchase");
  if (login !== null || purchase !== null) {
    // Strip one-time params so a refresh or a shared URL doesn't replay them.
    params.delete("login");
    params.delete("purchase");
    const q = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
  }

  if (login) {
    try {
      const r = await verifyLogin(login);
      if (r.switched) {
        const what =
          r.merged && r.mergedEntitlements > 0
            ? `Signed in as ${r.email}. ${r.mergedEntitlements} item(s) from this device moved to your account.`
            : `Signed in as ${r.email}.`;
        return switchSession(r.token, what);
      }
      toast(`Email linked: ${r.email}. Your purchases are now safe.`);
      openAccount();
    } catch (e) {
      openAccount({ error: (e as Error).message });
    }
    return;
  }

  if (purchase === "success" || purchase === "cancelled") {
    const { openStore } = await import("./store");
    if (purchase === "success") {
      toast("Payment received. Your items unlock as soon as Stripe confirms.");
      openStore({ notice: "success" });
    } else {
      toast("Checkout cancelled. Nothing was charged.", "warn");
    }
    return;
  }

  // A token revoked elsewhere (sign out everywhere) would otherwise leave the
  // game offline; trade it for a fresh identity.
  if (hasStoredToken()) {
    try {
      await getAccount();
    } catch (e) {
      if (isStaleSessionError(e)) await recoverStaleSession();
    }
  }
}

// Self-initialise once on import so ?login / ?purchase work even before main.ts
// calls initAccountFlow(). Module scripts run after parsing, so the DOM is ready.
if (typeof window !== "undefined" && typeof document !== "undefined") void initAccountFlow();
