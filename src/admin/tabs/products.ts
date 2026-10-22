import { PRODUCT_KINDS, productErrors, type ProductInput } from "../../../worker/admin-lib";
import { ApiError, api, esc, money, post, toast } from "../ui";

interface Product {
  id: string;
  name: string;
  description: string;
  kind: string;
  price_cents: number;
  currency: string;
  stripe_price_id: string | null;
  entitlement: string;
  active: number;
  sort: number;
  purchases: number;
  revenue_cents: number;
  refunds: number;
  refunded_cents: number;
}

const blank: Product = {
  id: "",
  name: "",
  description: "",
  kind: "cosmetic",
  price_cents: 0,
  currency: "usd",
  stripe_price_id: "",
  entitlement: "",
  active: 0,
  sort: 100,
  purchases: 0,
  revenue_cents: 0,
  refunds: 0,
  refunded_cents: 0,
};

const stripeLink = (id: string | null) =>
  id && /^price_[A-Za-z0-9]+$/.test(id)
    ? `<a class="ext" href="https://dashboard.stripe.com/prices/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">Open in Stripe ↗</a>`
    : "";

function card(p: Product, isNew = false): string {
  const f = (name: string, label: string, input: string, hint = "") =>
    `<div class="fld" data-f="${name}"><label>${label}</label>${input}<div class="ferr" role="alert"></div>${hint ? `<div class="dim">${hint}</div>` : ""}</div>`;
  const selling = p.active && p.stripe_price_id;
  return `<form class="card product${isNew ? " new" : ""}" data-id="${esc(p.id)}" novalidate>
    <div class="product-head">
      <div>
        <h3>${isNew ? "New product" : esc(p.name)} ${
          isNew ? "" : selling ? '<span class="badge ok"><b aria-hidden="true">✓</b> Selling</span>' : p.active ? '<span class="badge warn"><b aria-hidden="true">!</b> Active, no Stripe price</span>' : '<span class="badge">Inactive</span>'
        }</h3>
        ${isNew ? "" : `<code class="dim">${esc(p.id)}</code>`}
      </div>
      ${
        isNew
          ? ""
          : `<dl class="pstats"><div><dt>Sold</dt><dd>${p.purchases.toLocaleString()}</dd></div><div><dt>Revenue</dt><dd>${money(p.revenue_cents)}</dd></div>
             <div><dt>Refunds</dt><dd>${p.refunds ? `${p.refunds} · ${money(p.refunded_cents)}` : "0"}</dd></div></dl>`
      }
    </div>
    <div class="fields">
      ${isNew ? f("id", "ID (slug)", `<input name="id" placeholder="new-product-slug">`) : ""}
      ${f("name", "Name", `<input name="name" value="${esc(p.name)}">`)}
      ${f("kind", "Kind", `<select name="kind">${PRODUCT_KINDS.map((k) => `<option ${k === p.kind ? "selected" : ""}>${k}</option>`).join("")}</select>`)}
      ${f("price_cents", "Price (cents)", `<input name="price_cents" type="number" min="0" step="1" value="${p.price_cents}">`, `= ${money(p.price_cents)}`)}
      ${f("currency", "Currency", `<input name="currency" value="${esc(p.currency)}" maxlength="3">`)}
      ${f("stripe_price_id", "Stripe Price ID", `<input name="stripe_price_id" value="${esc(p.stripe_price_id ?? "")}" placeholder="price_…">`, stripeLink(p.stripe_price_id))}
      ${f("entitlement", "Entitlement", `<input name="entitlement" value="${esc(p.entitlement)}" placeholder="skin:chrome">`)}
      ${f("sort", "Sort", `<input name="sort" type="number" step="1" value="${p.sort}">`)}
      <div class="fld"><label>Active</label><label class="switch"><input name="active" type="checkbox" ${p.active ? "checked" : ""}><span aria-hidden="true"></span><span class="sr">Active</span></label></div>
      ${f("description", "Description", `<textarea name="description" rows="2">${esc(p.description)}</textarea>`)}
    </div>
    <div class="row end"><button type="submit">${isNew ? "Create product" : "Save"}</button></div>
  </form>`;
}

export async function renderProducts(main: HTMLElement): Promise<void> {
  const rows = await api<Product[]>("/products");
  const totalRev = rows.reduce((a, p) => a + p.revenue_cents, 0);
  main.innerHTML = `
    <div class="toolbar"><h1>Products</h1><span class="dim">${rows.length} products · ${money(totalRev)} all-time revenue</span></div>
    <p class="dim lead">Prices are in minor units (cents). A product only sells when it is <b>active</b>, has a Stripe Price ID, and the
      <code>store_enabled</code> setting is on. Stripe charges the Price's amount, so keep both in sync.</p>
    <div class="products">${rows.map((p) => card(p)).join("")}${card(blank, true)}</div>`;

  main.querySelectorAll<HTMLFormElement>("form.product").forEach((form) => {
    const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "";
    const read = (): [string, ProductInput] => [
      form.dataset.id || val("id").trim(),
      {
        name: val("name"),
        description: val("description"),
        kind: val("kind"),
        price_cents: Number(val("price_cents")),
        currency: val("currency").trim(),
        stripe_price_id: val("stripe_price_id").trim() || null,
        entitlement: val("entitlement").trim(),
        sort: Number(val("sort")),
        active: (form.elements.namedItem("active") as HTMLInputElement).checked,
      },
    ];
    const show = (errs: Record<string, string>) => {
      form.querySelectorAll<HTMLElement>("[data-f]").forEach((fld) => {
        const msg = errs[fld.dataset.f!] ?? "";
        fld.querySelector(".ferr")!.textContent = msg;
        fld.querySelector("input,select,textarea")?.toggleAttribute("aria-invalid", !!msg);
      });
    };
    form.addEventListener("input", (e) => {
      const [id, p] = read();
      const errs = productErrors(id, p);
      const name = (e.target as HTMLInputElement).name;
      // Live feedback only for the field being edited (plus any already-shown error).
      const shown = [...form.querySelectorAll<HTMLElement>("[data-f]")].filter((f) => f.querySelector(".ferr")!.textContent).map((f) => f.dataset.f!);
      show(Object.fromEntries(Object.entries(errs).filter(([k]) => k === name || shown.includes(k))));
      if (name === "price_cents") {
        const hint = form.querySelector('[data-f="price_cents"] .dim');
        if (hint) hint.textContent = `= ${money(Number(val("price_cents")) || 0)}`;
      }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const [id, p] = read();
      const errs = productErrors(id, p);
      show(errs);
      if (Object.keys(errs).length) return toast("Fix the highlighted fields", true);
      try {
        await post(`/products/${id}`, p, "PUT");
        toast(`Saved ${id}`);
        void renderProducts(main);
      } catch (ex) {
        if (ex instanceof ApiError && ex.body.fields) show(ex.body.fields as Record<string, string>);
        toast((ex as Error).message, true);
      }
    };
  });
}
