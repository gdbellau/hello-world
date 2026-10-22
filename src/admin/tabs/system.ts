import { meter } from "../charts";
import { api, compact, esc, when } from "../ui";

interface Health {
  ok: boolean;
  now: number;
  db: { ok: boolean; latencyMs: number; error?: string };
  migrations: { id: number; name: string; applied_at: string }[];
  settings: { schema: number; overrides: number | null };
  configured: Record<string, boolean>;
  tables: { table: string; rows: number }[];
  load: { window: { from: string; to: string }; avg: Record<string, number>; estimate: { requests: number; rowsWritten: number } };
  freeTier: { workerRequestsPerDay: number; d1RowsReadPerDay: number; d1RowsWrittenPerDay: number; d1StorageBytes: number };
}

const LABELS: Record<string, [string, string]> = {
  sessionSecret: ["Session secret", "SESSION_SECRET — signs player tokens. Required."],
  access: ["Cloudflare Access", "ACCESS_TEAM_DOMAIN + ACCESS_AUD — the Worker verifies the Access JWT on /admin."],
  stripe: ["Stripe API key", "STRIPE_SECRET_KEY — needed to create checkout sessions."],
  stripeWebhook: ["Stripe webhook secret", "STRIPE_WEBHOOK_SECRET — needed to fulfil purchases."],
  resend: ["Resend (email)", "RESEND_API_KEY — magic-link login emails."],
  devAdminBypass: ["Dev admin bypass", "DEV_ADMIN_EMAIL — only honoured on localhost. Leave unset in production."],
};

const pill = (ok: boolean, yes = "Configured", no = "Not set", warn = false) =>
  ok
    ? `<span class="badge ${warn ? "warn" : "ok"}"><b aria-hidden="true">${warn ? "!" : "✓"}</b> ${yes}</span>`
    : `<span class="badge ${warn ? "ok" : "off"}"><b aria-hidden="true">${warn ? "✓" : "–"}</b> ${no}</span>`;

export async function renderSystem(main: HTMLElement): Promise<void> {
  const h = await api<Health>("/health");
  const totalRows = h.tables.reduce((a, t) => a + Math.max(t.rows, 0), 0);
  const est = h.load.estimate;
  const ft = h.freeTier;

  main.innerHTML = `
    <div class="toolbar"><h1>System</h1><span class="dim">Checked ${esc(when(h.now))}</span><button type="button" class="ghost sm push" data-refresh>Re-check</button></div>
    <section class="tiles">
      <div class="tile"><div class="tile-l">Database (D1)</div><div class="tile-v">${h.db.ok ? "Reachable" : "Down"}</div>
        <div class="tile-d">${h.db.ok ? `<span class="badge ok"><b aria-hidden="true">✓</b> ${h.db.latencyMs} ms round-trip</span>` : `<span class="badge bad"><b aria-hidden="true">✕</b> ${esc(h.db.error)}</span>`}</div></div>
      <div class="tile"><div class="tile-l">Migrations applied</div><div class="tile-v">${h.migrations.length}</div>
        <div class="tile-d dim">${h.migrations.length ? esc(h.migrations[h.migrations.length - 1]!.name) : "d1_migrations table not found"}</div></div>
      <div class="tile"><div class="tile-l">Settings</div><div class="tile-v">${h.settings.schema}</div>
        <div class="tile-d dim">${h.settings.overrides ?? "?"} overridden in D1</div></div>
      <div class="tile"><div class="tile-l">Rows stored</div><div class="tile-v">${compact(totalRows)}</div>
        <div class="tile-d dim">across ${h.tables.length} tables</div></div>
    </section>

    <div class="grid">
      <section class="card"><h3>Configuration</h3>
        <p class="dim">Booleans only — secret values never leave the Worker.</p>
        <table class="data"><tbody>${Object.entries(h.configured)
          .map(([k, v]) => {
            const [label, hint] = LABELS[k] ?? [k, ""];
            return `<tr><td><b>${esc(label)}</b><div class="dim">${esc(hint)}</div></td><td class="n">${k === "devAdminBypass" ? pill(v, "Set", "Unset", true) : pill(v)}</td></tr>`;
          })
          .join("")}</tbody></table>
      </section>

      <section class="card"><h3>Free-tier budget</h3>
        <p class="dim">Daily averages from counters for ${esc(h.load.window.from)} – ${esc(h.load.window.to)}: ${compact(h.load.avg.dau ?? 0)} DAU,
          ${compact(h.load.avg.missions_started ?? 0)} missions/day. Estimates, not meters — check the Cloudflare dashboard for actuals.</p>
        <table class="data budget"><thead><tr><th>Resource</th><th class="n">Estimate / day</th><th class="n">Free limit</th><th>Headroom</th></tr></thead><tbody>
          <tr><td>Worker requests</td><td class="n">${compact(est.requests)}</td><td class="n">${compact(ft.workerRequestsPerDay)}</td><td>${meter(est.requests, ft.workerRequestsPerDay, "Worker requests vs free limit")}</td></tr>
          <tr><td>D1 rows written</td><td class="n">${compact(est.rowsWritten)}</td><td class="n">${compact(ft.d1RowsWrittenPerDay)}</td><td>${meter(est.rowsWritten, ft.d1RowsWrittenPerDay, "D1 rows written vs free limit")}</td></tr>
          <tr><td>D1 storage</td><td class="n">≈ ${(totalRows * 200 / 1024 ** 2).toFixed(1)} MB</td><td class="n">5 GB</td><td>${meter((totalRows * 200) / 1024 ** 2, 5 * 1024, "D1 storage vs free limit")}<div class="dim">${compact(totalRows)} rows at ~200 B/row</div></td></tr>
          <tr><td>D1 rows read</td><td class="n" colspan="2"><span class="dim">5M / day limit</span></td><td><span class="dim">Mostly settings loads and admin pages; see Cloudflare analytics.</span></td></tr>
        </tbody></table>
      </section>

      <section class="card"><h3>Tables</h3>
        <table class="data"><thead><tr><th>Table</th><th class="n">Rows</th></tr></thead><tbody>${h.tables
          .map((t) => `<tr><td><code>${esc(t.table)}</code></td><td class="n">${t.rows < 0 ? "?" : t.rows.toLocaleString()}</td></tr>`)
          .join("")}</tbody></table>
      </section>

      <section class="card"><h3>Migrations</h3>
        <table class="data"><thead><tr><th>#</th><th>Name</th><th>Applied</th></tr></thead><tbody>${
          h.migrations.map((m) => `<tr><td>${m.id}</td><td><code>${esc(m.name)}</code></td><td>${esc(m.applied_at)}</td></tr>`).join("") ||
          `<tr><td colspan="3" class="empty">No d1_migrations table.</td></tr>`
        }</tbody></table>
      </section>
    </div>`;
  main.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () => void renderSystem(main);
}
