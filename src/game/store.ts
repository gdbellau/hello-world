// In-game store UI. Owned by the accounts & store workstream.
// Other screens just call openStore().
import { closeShopModal, el, fmtMoney, openAccount, openShopModal, toast } from "./account";
import { getCatalog, startCheckout, type StoreCatalog, type StoreProduct } from "./account-api";

export interface OpenStoreOptions {
  /** "success" after returning from Stripe: polls until the new item shows as owned. */
  notice?: "success";
}

const SECTIONS: { kind: string; title: string; blurb: string }[] = [
  { kind: "supporter", title: "SUPPORTER", blurb: "Back the operation. Get remembered." },
  { kind: "cosmetic", title: "COSMETICS", blurb: "Look the part. Zero stat changes." },
  { kind: "expansion", title: "EXPANSIONS", blurb: "New districts, new contracts." },
  { kind: "tip", title: "TIP JAR", blurb: "Pay what you want. Keeps the servers lit." },
];

let renderSeq = 0;
let activeTab = "all";

export function openStore(opts: OpenStoreOptions = {}): void {
  const body = openShopModal({ kicker: "// CABAL EXCHANGE", title: "BLACK MARKET", variant: "store" });
  body.append(el("p", { class: "cbl-loading" }, "Decrypting catalog…"));
  void load(body, opts);
}

async function load(body: HTMLElement, opts: OpenStoreOptions): Promise<void> {
  const seq = ++renderSeq;
  let cat: StoreCatalog;
  try {
    cat = await getCatalog();
  } catch {
    body.replaceChildren(el("p", { class: "cbl-alert cbl-alert--err" }, "The exchange is unreachable right now. Try again shortly."));
    return;
  }
  if (seq !== renderSeq || !body.isConnected) return;
  render(body, cat, opts);

  if (opts.notice === "success") {
    // The webhook usually lands within a second or two of the redirect.
    const before = new Set(cat.owned);
    for (const wait of [1500, 3000, 5000, 8000]) {
      await new Promise((r) => setTimeout(r, wait));
      if (seq !== renderSeq || !body.isConnected) return;
      try {
        const next = await getCatalog();
        if (seq !== renderSeq || !body.isConnected) return;
        render(body, next, opts);
        if (next.owned.some((id) => !before.has(id))) {
          toast("Unlocked. Thanks for backing THE CABAL.");
          return;
        }
      } catch {
        /* keep polling */
      }
    }
  }
}

function render(body: HTMLElement, cat: StoreCatalog, opts: OpenStoreOptions): void {
  const owned = new Set(cat.owned);
  const needsAccount = cat.requireAccount && !cat.email;
  body.replaceChildren();

  // Identity strip.
  body.append(
    el(
      "div",
      { class: "cbl-statusbar" },
      el("span", { class: `cbl-dot${cat.email ? " cbl-dot--on" : ""}` }),
      el("span", { class: "cbl-statusbar-text" }, cat.email ? `LINKED · ${cat.email}` : "ANONYMOUS DEVICE"),
      el(
        "button",
        { class: "cbl-link", type: "button", onclick: () => openAccount({ onBack: () => openStore() }) },
        cat.email ? "Account" : "Sign in",
      ),
    ),
  );

  if (opts.notice === "success") {
    body.append(el("p", { class: "cbl-alert cbl-alert--ok" }, "Payment received. Items unlock as soon as Stripe confirms; this page refreshes itself."));
  }
  if (cat.banner) body.append(el("div", { class: "cbl-banner" }, el("span", {}, cat.banner)));
  if (!cat.enabled) {
    body.append(el("p", { class: "cbl-alert cbl-alert--warn" }, "STORE OFFLINE. The exchange is closed for maintenance; check back soon."));
  } else if (needsAccount) {
    body.append(
      el(
        "p",
        { class: "cbl-alert cbl-alert--info" },
        "Sign in with an email before buying, so your purchases follow you to any device. ",
        el("button", { class: "cbl-link", type: "button", onclick: () => signInFirst() }, "Sign in →"),
      ),
    );
  }

  if (!cat.products.length) {
    body.append(el("p", { class: "cbl-muted" }, "Nothing on the shelves yet."));
  }

  // Kind filter tabs over a single grid, ordered supporter → cosmetics → expansions → tip → other.
  const order = (p: StoreProduct) => {
    const i = SECTIONS.findIndex((s) => s.kind === p.kind);
    return i < 0 ? SECTIONS.length : i;
  };
  const products = [...cat.products].sort((a, b) => order(a) - order(b));
  const tabs = SECTIONS.filter((s) => products.some((p) => p.kind === s.kind));
  if (!tabs.some((t) => t.kind === activeTab)) activeTab = "all";
  const grid = el("div", { class: "cbl-grid", role: "tabpanel" });
  const blurb = el("p", { class: "cbl-muted cbl-tab-blurb" });
  const tabBar = el("div", { class: "cbl-tabs", role: "tablist", "aria-label": "Product categories" });
  const show = (kind: string) => {
    activeTab = kind;
    for (const b of tabBar.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.kind === kind));
    blurb.textContent = SECTIONS.find((s) => s.kind === kind)?.blurb ?? "Cosmetics and extra campaigns only. Nothing here changes the odds.";
    grid.replaceChildren(
      ...products.filter((p) => kind === "all" || p.kind === kind).map((p) => card(p, cat, owned.has(p.id), needsAccount)),
    );
  };
  for (const t of [{ kind: "all", title: "ALL" }, ...tabs]) {
    const n = t.kind === "all" ? products.length : products.filter((p) => p.kind === t.kind).length;
    tabBar.append(
      el(
        "button",
        { class: "cbl-tab", type: "button", role: "tab", "data-kind": t.kind, onclick: () => show(t.kind) },
        t.title,
        el("span", { class: "cbl-tab-n" }, String(n)),
      ),
    );
  }
  if (products.length) {
    body.append(tabs.length > 1 ? tabBar : "", blurb, grid);
    show(activeTab);
  }

  body.append(
    el(
      "p",
      { class: "cbl-foot" },
      "No pay-to-win: the campaign is free and complete. Payments are processed securely by Stripe; card details never touch our servers.",
    ),
  );
}

function card(p: StoreProduct, cat: StoreCatalog, owned: boolean, needsAccount: boolean): HTMLElement {
  const isTip = p.kind === "tip";
  const price = isTip
    ? el("span", { class: "cbl-price cbl-price--pwyw" }, "PAY WHAT YOU WANT")
    : el("span", { class: "cbl-price" }, fmtMoney(p.price_cents, p.currency, cat.currencyDisplay));

  let btn: HTMLButtonElement;
  if (owned && !isTip) {
    btn = el("button", { class: "cbl-btn cbl-btn--owned", type: "button", disabled: true }, "✓ Owned");
  } else if (!cat.enabled) {
    btn = el("button", { class: "cbl-btn", type: "button", disabled: true }, "Offline");
  } else if (needsAccount) {
    btn = el("button", { class: "cbl-btn cbl-btn--ghost", type: "button", onclick: () => signInFirst() }, "Sign in to buy");
  } else {
    btn = el("button", { class: "cbl-btn", type: "button" }, isTip ? (owned ? "Tip again" : "Leave a tip") : "Buy");
    btn.addEventListener("click", () => void buy(p, btn));
  }

  return el(
    "article",
    { class: `cbl-card cbl-card--${isTip ? "tip" : p.kind}${owned ? " is-owned" : ""}` },
    el(
      "div",
      { class: "cbl-card-top" },
      el("span", { class: "cbl-kind" }, p.kind.toUpperCase()),
      owned ? el("span", { class: "cbl-badge" }, isTip ? "♥ THANK YOU" : "OWNED") : null,
    ),
    el("h4", {}, p.name),
    el("p", { class: "cbl-desc" }, p.description),
    el("div", { class: "cbl-card-foot" }, price, btn),
  );
}

function signInFirst(): void {
  openAccount({ reason: "Link an email to purchase. It takes one click from your inbox.", onBack: () => openStore() });
}

async function buy(p: StoreProduct, btn: HTMLButtonElement): Promise<void> {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening checkout…";
  try {
    const { url } = await startCheckout(p.id);
    // The URL comes from our Worker (Stripe-hosted checkout, possibly on a custom domain); never follow non-https.
    if (new URL(url).protocol !== "https:") throw new Error("Unexpected checkout URL");
    closeShopModal();
    location.assign(url);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    const msg = (e as Error).message;
    if (/link an email/i.test(msg)) signInFirst();
    else toast(msg || "Checkout failed", "err");
  }
}
