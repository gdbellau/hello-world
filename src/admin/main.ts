import "./admin.css";
import type { SettingDef, SettingValue } from "../../shared/settings";

const main = document.querySelector<HTMLElement>("#main")!;

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

function toast(msg: string, bad = false): void {
  const t = document.querySelector<HTMLElement>("#toast")!;
  t.textContent = msg;
  t.className = bad ? "bad" : "";
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => (t.hidden = true), 3000);
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const when = (ms: number) => new Date(ms).toLocaleString();

// --- Stats ------------------------------------------------------------------

async function renderStats(): Promise<void> {
  const s = await api<{
    days: number;
    totals: { players: number; activePlayers24h: number; revenueCents: number; purchases: number };
    missionOutcomes: { mission_type: string; outcome: string; n: number }[];
    daily: { day: string; metric: string; value: number }[];
  }>("/stats?days=30");

  const metrics = [...new Set(s.daily.map((d) => d.metric))].sort();
  const days = [...new Set(s.daily.map((d) => d.day))].sort().reverse();
  const cell = new Map(s.daily.map((d) => [`${d.day}|${d.metric}`, d.value]));
  const fmt = (m: string, v: number | undefined) => (v === undefined ? "–" : m.includes("cents") ? money(v) : v.toLocaleString());

  const outcomes = new Map<string, Record<string, number>>();
  for (const r of s.missionOutcomes) outcomes.set(r.mission_type, { ...outcomes.get(r.mission_type), [r.outcome]: r.n });

  main.innerHTML = `
    <h2>Totals</h2>
    <table class="kv">
      <tr><th>Players (all time)</th><td>${s.totals.players.toLocaleString()}</td></tr>
      <tr><th>Active players (24h)</th><td>${s.totals.activePlayers24h.toLocaleString()}</td></tr>
      <tr><th>Revenue (all time)</th><td>${money(s.totals.revenueCents)}</td></tr>
      <tr><th>Purchases (all time)</th><td>${s.totals.purchases.toLocaleString()}</td></tr>
    </table>

    <h2>Mission outcomes</h2>
    <table>
      <thead><tr><th>Type</th><th>Win</th><th>Loss</th><th>Abort</th><th>Win rate</th></tr></thead>
      <tbody>${[...outcomes]
        .map(([type, o]) => {
          const total = (o.win ?? 0) + (o.loss ?? 0);
          return `<tr><td>${esc(type)}</td><td>${o.win ?? 0}</td><td>${o.loss ?? 0}</td><td>${o.abort ?? 0}</td>
            <td>${total ? Math.round((100 * (o.win ?? 0)) / total) + "%" : "–"}</td></tr>`;
        })
        .join("") || `<tr><td colspan="5" class="dim">No missions completed yet.</td></tr>`}</tbody>
    </table>

    <h2>Daily (last ${s.days} days, UTC)</h2>
    <div class="scroll"><table>
      <thead><tr><th>Day</th>${metrics.map((m) => `<th>${esc(m)}</th>`).join("")}</tr></thead>
      <tbody>${days
        .map((d) => `<tr><td>${d}</td>${metrics.map((m) => `<td>${fmt(m, cell.get(`${d}|${m}`))}</td>`).join("")}</tr>`)
        .join("") || `<tr><td class="dim">No data yet.</td></tr>`}</tbody>
    </table></div>`;
}

// --- Settings ---------------------------------------------------------------

async function renderSettings(): Promise<void> {
  const s = await api<{
    schema: SettingDef[];
    values: Record<string, SettingValue>;
    overrides: { key: string; updated_at: number; updated_by: string }[];
  }>("/settings");
  const ov = new Map(s.overrides.map((o) => [o.key, o]));
  const cats = [...new Set(s.schema.map((d) => d.category))];

  const input = (d: SettingDef) => {
    const v = s.values[d.key];
    if (d.type === "boolean") return `<input type="checkbox" data-key="${d.key}" ${v ? "checked" : ""}>`;
    if (d.type === "string") return `<input type="text" data-key="${d.key}" value="${esc(v)}">`;
    return `<input type="number" data-key="${d.key}" value="${esc(v)}" ${d.min !== undefined ? `min="${d.min}"` : ""}
      ${d.max !== undefined ? `max="${d.max}"` : ""} step="${d.type === "integer" ? 1 : "any"}">`;
  };

  main.innerHTML = cats
    .map(
      (c) => `<h2>${esc(c)}</h2><table class="settings"><tbody>${s.schema
        .filter((d) => d.category === c)
        .map((d) => {
          const o = ov.get(d.key);
          return `<tr>
            <td><b>${esc(d.label)}</b> ${d.public ? "" : '<span class="tag">server-only</span>'}
              <div class="dim">${esc(d.description)} Default: <code>${esc(d.default)}</code>${
                d.min !== undefined ? ` · range ${d.min}–${d.max}` : ""
              }</div>
              ${o ? `<div class="mod">Modified by ${esc(o.updated_by)} · ${when(o.updated_at)}</div>` : ""}</td>
            <td class="in">${input(d)}</td>
            <td class="btns"><button data-save="${d.key}">Save</button>${
              o ? `<button class="ghost" data-reset="${d.key}">Reset</button>` : ""
            }</td></tr>`;
        })
        .join("")}</tbody></table>`,
    )
    .join("");

  main.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.save!;
      const def = s.schema.find((d) => d.key === key)!;
      const el = main.querySelector<HTMLInputElement>(`[data-key="${key}"]`)!;
      const value = def.type === "boolean" ? el.checked : def.type === "string" ? el.value : Number(el.value);
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify({ key, value }) });
        toast(`Saved ${key}`);
        void renderSettings();
      } catch (e) {
        toast((e as Error).message, true);
      }
    };
  });
  main.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Reset ${b.dataset.reset} to its default?`)) return;
      await api(`/settings/${b.dataset.reset}`, { method: "DELETE" });
      toast(`Reset ${b.dataset.reset}`);
      void renderSettings();
    };
  });
}

// --- Products ---------------------------------------------------------------

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
}

async function renderProducts(): Promise<void> {
  const rows = await api<Product[]>("/products");
  const blank: Product = { id: "", name: "", description: "", kind: "cosmetic", price_cents: 0, currency: "usd", stripe_price_id: "", entitlement: "", active: 0, sort: 100 };
  const row = (p: Product, isNew = false) => `<tr data-id="${esc(p.id)}">
    <td>${isNew ? `<input name="id" placeholder="new-product-slug">` : `<code>${esc(p.id)}</code>`}</td>
    <td><input name="name" value="${esc(p.name)}"><textarea name="description" rows="2">${esc(p.description)}</textarea></td>
    <td><select name="kind">${["cosmetic", "expansion", "supporter"].map((k) => `<option ${k === p.kind ? "selected" : ""}>${k}</option>`).join("")}</select></td>
    <td><input name="price_cents" type="number" min="0" step="1" value="${p.price_cents}" class="num"> <input name="currency" value="${esc(p.currency)}" class="cur"></td>
    <td><input name="stripe_price_id" value="${esc(p.stripe_price_id ?? "")}" placeholder="price_…"></td>
    <td><input name="entitlement" value="${esc(p.entitlement)}"></td>
    <td><input name="sort" type="number" value="${p.sort}" class="num"></td>
    <td><input name="active" type="checkbox" ${p.active ? "checked" : ""}></td>
    <td><button data-save>Save</button></td></tr>`;

  main.innerHTML = `<h2>Store catalog</h2>
    <p class="dim">Prices are in minor units (cents). A product only sells when it is <b>active</b>, has a Stripe Price ID,
    and the <code>store_enabled</code> setting is on. The Stripe Price amount is what's charged, so keep both in sync.</p>
    <div class="scroll"><table class="products">
      <thead><tr><th>ID</th><th>Name / description</th><th>Kind</th><th>Price</th><th>Stripe Price ID</th><th>Entitlement</th><th>Sort</th><th>Active</th><th></th></tr></thead>
      <tbody>${rows.map((p) => row(p)).join("")}${row(blank, true)}</tbody>
    </table></div>`;

  main.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest("tr")!;
      const f = (n: string) => tr.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
      const id = tr.dataset.id || f("id").value.trim();
      if (!/^[a-z0-9-]+$/.test(id)) return toast("ID must be lowercase letters, digits and dashes", true);
      try {
        await api(`/products/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: f("name").value,
            description: tr.querySelector<HTMLTextAreaElement>("[name=description]")!.value,
            kind: (tr.querySelector("[name=kind]") as HTMLSelectElement).value,
            price_cents: Number(f("price_cents").value),
            currency: f("currency").value,
            stripe_price_id: f("stripe_price_id").value.trim() || null,
            entitlement: f("entitlement").value.trim(),
            sort: Number(f("sort").value),
            active: f("active").checked,
          }),
        });
        toast(`Saved ${id}`);
        void renderProducts();
      } catch (e) {
        toast((e as Error).message, true);
      }
    };
  });
}

// --- Audit ------------------------------------------------------------------

async function renderAudit(): Promise<void> {
  const rows = await api<{ id: number; at: number; actor: string; action: string; target: string; detail: string }[]>("/audit?limit=200");
  main.innerHTML = `<h2>Audit log</h2><div class="scroll"><table>
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
    <tbody>${rows
      .map((r) => `<tr><td>${when(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td><td><code>${esc(r.detail)}</code></td></tr>`)
      .join("") || `<tr><td colspan="5" class="dim">Nothing yet.</td></tr>`}</tbody></table></div>`;
}

// --- Shell ------------------------------------------------------------------

const tabs: Record<string, () => Promise<void>> = {
  stats: renderStats,
  settings: renderSettings,
  products: renderProducts,
  audit: renderAudit,
};

async function show(tab: string): Promise<void> {
  document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  main.innerHTML = `<p class="dim">Loading…</p>`;
  try {
    await tabs[tab]!();
  } catch (e) {
    main.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`;
  }
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}

document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => (b.onclick = () => void show(b.dataset.tab!)));
api<{ email: string }>("/whoami")
  .then((w) => (document.querySelector("#who")!.textContent = w.email))
  .catch(() => {});
const fromHash = () => void show(location.hash.slice(1) in tabs ? location.hash.slice(1) : "stats");
addEventListener("hashchange", fromHash);
fromHash();
