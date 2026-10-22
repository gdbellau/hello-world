import { winRate } from "../../../worker/admin-lib";
import { bindMarkTips, statTile } from "../charts";
import { pretty } from "./audit";
import { ago, api, compact, esc, formDialog, money, post, toast, when } from "../ui";

interface PlayerRow {
  id: string;
  created_at: number;
  last_seen_at: number;
  email: string | null;
  corp_name: string;
  credits: number;
  banned: number;
}

interface Detail {
  player: PlayerRow;
  entitlements: { entitlement: string; source: string; granted_at: number; revoked_at: number | null }[];
  purchases: { stripe_session_id: string; product_id: string; product_name: string | null; amount_cents: number; currency: string; status: string; created_at: number }[];
  runs: { id: string; mission_id: string; mission_type: string; started_at: number; ended_at: number | null; outcome: string | null; stealth: number | null; reward: number | null }[];
  runTotals: Record<string, number>;
  audit: { id: number; at: number; actor: string; action: string; detail: string }[];
  activeDays: string[];
  extra: { table: string; count: number; rows: Record<string, unknown>[] }[];
}

const state = { q: "", status: "all", sort: "last_seen", page: 1 };

const statusBadge = (p: PlayerRow) =>
  p.banned ? `<span class="badge bad"><b aria-hidden="true">⛔</b> Banned</span>` : `<span class="badge ok"><b aria-hidden="true">✓</b> Active</span>`;

export async function renderPlayers(main: HTMLElement, arg?: string): Promise<void> {
  if (arg) return renderDetail(main, decodeURIComponent(arg));
  const qs = new URLSearchParams({ q: state.q, status: state.status, sort: state.sort, page: String(state.page) });
  const r = await api<{ rows: PlayerRow[]; total: number; page: number; pageSize: number }>(`/players?${qs}`);
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));

  main.innerHTML = `
    <div class="toolbar"><h1>Players</h1><span class="dim">${r.total.toLocaleString()} match${r.total === 1 ? "" : "es"}</span></div>
    <form class="filters" data-search role="search">
      <input type="search" name="q" value="${esc(state.q)}" placeholder="Search id prefix, email or corp name" aria-label="Search players" autofocus>
      <select name="status" aria-label="Status">${[
        ["all", "All players"],
        ["active", "Not banned"],
        ["banned", "Banned"],
        ["linked", "Email linked"],
      ]
        .map(([v, l]) => `<option value="${v}" ${state.status === v ? "selected" : ""}>${l}</option>`)
        .join("")}</select>
      <select name="sort" aria-label="Sort">${[
        ["last_seen", "Last seen"],
        ["created", "Newest"],
        ["credits", "Most credits"],
        ["corp", "Corp name"],
      ]
        .map(([v, l]) => `<option value="${v}" ${state.sort === v ? "selected" : ""}>Sort: ${l}</option>`)
        .join("")}</select>
      <button type="submit">Search</button>
    </form>
    <div class="card flush"><div class="scroll"><table class="data rows">
      <thead><tr><th>Corp</th><th>Email</th><th>Player ID</th><th class="n">Credits</th><th>Created</th><th>Last seen</th><th>Status</th></tr></thead>
      <tbody>${
        r.rows
          .map(
            (p) => `<tr data-open="${esc(p.id)}" tabindex="0">
          <td><a href="#players/${encodeURIComponent(p.id)}"><b>${esc(p.corp_name)}</b></a></td>
          <td>${p.email ? esc(p.email) : '<span class="dim">guest</span>'}</td>
          <td><code>${esc(p.id.slice(0, 8))}…</code></td>
          <td class="n">${p.credits.toLocaleString()}</td>
          <td>${esc(new Date(p.created_at).toLocaleDateString())}</td>
          <td>${esc(ago(p.last_seen_at))}</td>
          <td>${statusBadge(p)}</td></tr>`,
          )
          .join("") || `<tr><td colspan="7" class="empty">No players match.</td></tr>`
      }</tbody></table></div></div>
    <nav class="pager" aria-label="Pages">
      <button type="button" class="ghost sm" data-page="${r.page - 1}" ${r.page <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="dim">Page ${r.page} of ${pages}</span>
      <button type="button" class="ghost sm" data-page="${r.page + 1}" ${r.page >= pages ? "disabled" : ""}>Next →</button>
    </nav>`;

  const form = main.querySelector<HTMLFormElement>("[data-search]")!;
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(form);
    Object.assign(state, { q: String(f.get("q") ?? ""), status: String(f.get("status")), sort: String(f.get("sort")), page: 1 });
    void renderPlayers(main);
  };
  form.querySelectorAll("select").forEach((s) => (s.onchange = () => form.requestSubmit()));
  main.querySelectorAll<HTMLButtonElement>("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        state.page = Number(b.dataset.page);
        void renderPlayers(main);
      }),
  );
  main.querySelectorAll<HTMLElement>("[data-open]").forEach((tr) => {
    const go = () => (location.hash = `#players/${encodeURIComponent(tr.dataset.open!)}`);
    tr.onclick = (e) => {
      if (!(e.target as HTMLElement).closest("a")) go();
    };
    tr.onkeydown = (e) => e.key === "Enter" && go();
  });
}

const fmtCell = (v: unknown) =>
  typeof v === "number" && v > 1e12 && v < 1e13 ? when(v) : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");

async function renderDetail(main: HTMLElement, id: string): Promise<void> {
  const [d, products] = await Promise.all([api<Detail>(`/players/${encodeURIComponent(id)}`), api<{ entitlement: string }[]>("/products").catch(() => [])]);
  const p = d.player;
  const active = d.entitlements.filter((e) => !e.revoked_at);
  const spent = d.purchases.filter((x) => x.status === "paid").reduce((a, x) => a + x.amount_cents, 0);
  const wr = winRate(d.runTotals.win ?? 0, d.runTotals.loss ?? 0);
  const runs = Object.values(d.runTotals).reduce((a, b) => a + b, 0);

  // 30-day activity strip (oldest -> newest).
  const daySet = new Set(d.activeDays);
  const strip: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const on = daySet.has(day);
    strip.push(`<span class="cell${on ? " on" : ""}" tabindex="0" data-tt="${day}" data-tv="${on ? "Active" : "Not seen"}" data-tl=""></span>`);
  }

  main.innerHTML = `
    <div class="toolbar"><a class="back" href="#players">← Players</a></div>
    <section class="card player-head">
      <div>
        <h1>${esc(p.corp_name)} ${statusBadge(p)}</h1>
        <p class="dim"><code class="sel">${esc(p.id)}</code> · ${p.email ? esc(p.email) : "guest (no email linked)"}</p>
        <p class="dim">Created ${esc(when(p.created_at))} · last seen ${esc(ago(p.last_seen_at))}</p>
      </div>
      <div class="actions">
        <button type="button" data-act="credits">Adjust credits</button>
        <button type="button" data-act="grant">Grant entitlement</button>
        <button type="button" class="ghost" data-act="rename">Rename corp</button>
        <button type="button" class="ghost ${p.banned ? "" : "danger-text"}" data-act="ban">${p.banned ? "Unban" : "Ban"}</button>
        <button type="button" class="ghost danger-text" data-act="reset">Reset progress</button>
      </div>
    </section>
    <section class="tiles">
      ${statTile({ label: "Credits", value: compact(p.credits), sub: p.credits.toLocaleString() })}
      ${statTile({ label: "Mission runs", value: compact(runs), sub: `${d.runTotals.win ?? 0} won · ${d.runTotals.loss ?? 0} lost · ${d.runTotals.abort ?? 0} aborted` })}
      ${statTile({ label: "Win rate", value: wr === null ? "–" : `${wr.toFixed(0)}%`, sub: "wins vs. wins + losses" })}
      ${statTile({ label: "Spent", value: money(spent), sub: `${d.purchases.length} purchase${d.purchases.length === 1 ? "" : "s"}` })}
      ${statTile({ label: "Active days (30d)", value: String(d.activeDays.length), sub: "UTC days with a session" })}
    </section>
    <section class="card"><h3>Activity, last 30 days</h3><div class="strip" role="img" aria-label="${d.activeDays.length} active days in the last 30">${strip.join("")}</div></section>
    <div class="grid">
      <section class="card"><h3>Entitlements</h3>
        <div class="scroll"><table class="data"><thead><tr><th>Key</th><th>Source</th><th>Granted</th><th>Status</th><th></th></tr></thead><tbody>${
          d.entitlements
            .map(
              (e) => `<tr><td><code>${esc(e.entitlement)}</code></td><td><span class="tag">${esc(e.source)}</span></td><td>${esc(when(e.granted_at))}</td>
              <td>${e.revoked_at ? `<span class="dim">revoked ${esc(ago(e.revoked_at))}</span>` : "active"}</td>
              <td>${e.revoked_at ? "" : `<button type="button" class="ghost sm danger-text" data-revoke="${esc(e.entitlement)}">Revoke</button>`}</td></tr>`,
            )
            .join("") || `<tr><td colspan="5" class="empty">None.</td></tr>`
        }</tbody></table></div></section>
      <section class="card"><h3>Purchases</h3>
        <div class="scroll"><table class="data"><thead><tr><th>Product</th><th class="n">Amount</th><th>Status</th><th>When</th></tr></thead><tbody>${
          d.purchases
            .map(
              (x) => `<tr><td>${esc(x.product_name ?? x.product_id)}<div class="dim"><code>${esc(x.stripe_session_id.slice(0, 24))}…</code></div></td>
              <td class="n">${esc(money(x.amount_cents))} ${esc(x.currency.toUpperCase())}</td><td>${esc(x.status)}</td><td>${esc(when(x.created_at))}</td></tr>`,
            )
            .join("") || `<tr><td colspan="4" class="empty">None.</td></tr>`
        }</tbody></table></div></section>
      <section class="card wide"><h3>Recent missions</h3>
        <div class="scroll"><table class="data"><thead><tr><th>Mission</th><th>Type</th><th>Outcome</th><th class="n">Reward</th><th>Started</th></tr></thead><tbody>${
          d.runs
            .map(
              (r) => `<tr><td>${esc(r.mission_id)}</td><td>${esc(r.mission_type)}</td>
              <td>${r.outcome ? esc(r.outcome) + (r.stealth ? ' <span class="tag">stealth</span>' : "") : '<span class="dim">in progress</span>'}</td>
              <td class="n">${r.reward ? r.reward.toLocaleString() : "–"}</td><td>${esc(when(r.started_at))}</td></tr>`,
            )
            .join("") || `<tr><td colspan="5" class="empty">No missions yet.</td></tr>`
        }</tbody></table></div></section>
    </div>
    <section class="card"><h3>Admin history</h3>
      <div class="scroll"><table class="data audit"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${
        d.audit
          .map(
            (a) => `<tr><td class="nw" title="${esc(when(a.at))}">${esc(ago(a.at))}</td><td>${esc(a.actor)}</td><td><code>${esc(a.action)}</code></td><td class="detail">${pretty(a.detail)}</td></tr>`,
          )
          .join("") || `<tr><td colspan="4" class="empty">No admin actions on this player.</td></tr>`
      }</tbody></table></div></section>
    ${d.extra
      .map((x) => {
        const cols = [...new Set(x.rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "player_id").slice(0, 8);
        return `<section class="card"><h3>${esc(x.table)} <span class="dim">(${x.count})</span></h3><div class="scroll"><table class="data">
          <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${x.rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(fmtCell(r[c]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
      })
      .join("")}`;
  bindMarkTips(main);

  const url = `/players/${encodeURIComponent(p.id)}`;
  const refresh = () => renderDetail(main, id);
  const reasonField = { name: "reason", label: "Reason (audit-logged)", placeholder: "e.g. support ticket #1234" };
  const act = async (action: string, body: Record<string, unknown>, msg: string) => {
    await post(`${url}/${action}`, body);
    toast(msg);
    void refresh();
  };
  const entKeys = [...new Set(products.map((x) => x.entitlement))].filter((k) => !active.some((a) => a.entitlement === k));

  const actions: Record<string, () => Promise<boolean>> = {
    credits: () =>
      formDialog({
        title: "Adjust credits",
        body: `Current balance: <b>${p.credits.toLocaleString()}</b>. Use a negative number to deduct; the balance never goes below 0.`,
        fields: [{ name: "delta", label: "Change (+/-)", type: "number", placeholder: "e.g. 5000 or -1200" }, reasonField],
        ok: "Apply",
        submit: (v) => act("credits", { delta: Number(v.delta), reason: v.reason }, "Credits adjusted"),
      }),
    grant: () =>
      formDialog({
        title: "Grant entitlement",
        body: "Granted with source <code>admin</code>.",
        fields: [{ name: "entitlement", label: "Entitlement key", placeholder: "e.g. skin:chrome", list: entKeys }, reasonField],
        ok: "Grant",
        submit: (v) => act("grant", { entitlement: v.entitlement!.trim(), reason: v.reason }, `Granted ${v.entitlement}`),
      }),
    rename: () =>
      formDialog({
        title: "Rename corporation",
        fields: [{ name: "corp_name", label: "New corp name (1–40 characters)", value: p.corp_name }, reasonField],
        ok: "Rename",
        submit: (v) => act("rename", { corp_name: v.corp_name, reason: v.reason }, "Renamed"),
      }),
    ban: () =>
      formDialog({
        title: p.banned ? "Unban player" : "Ban player",
        body: p.banned ? "The player can sign in and play again." : "The player is blocked from every authenticated API call until unbanned.",
        fields: [reasonField],
        ok: p.banned ? "Unban" : "Ban",
        danger: !p.banned,
        submit: (v) => act("ban", { banned: !p.banned, reason: v.reason }, p.banned ? "Unbanned" : "Banned"),
      }),
    reset: () =>
      formDialog({
        title: "Reset progress",
        body: "Resets credits to the current <code>starting_credits</code> and closes any open mission runs. Entitlements and purchases are kept. This cannot be undone.",
        fields: [{ name: "confirm", label: "Type RESET to confirm", placeholder: "RESET" }, reasonField],
        ok: "Reset progress",
        danger: true,
        submit: (v) => act("reset", { confirm: v.confirm, reason: v.reason }, "Progress reset"),
      }),
  };
  main.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => void actions[b.dataset.act!]!()));
  main.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach(
    (b) =>
      (b.onclick = () =>
        void formDialog({
          title: `Revoke ${b.dataset.revoke}`,
          body: "The player loses this entitlement immediately. A Stripe refund is not issued.",
          fields: [reasonField],
          ok: "Revoke",
          danger: true,
          submit: (v) => act("revoke", { entitlement: b.dataset.revoke, reason: v.reason }, `Revoked ${b.dataset.revoke}`),
        })),
  );
}
