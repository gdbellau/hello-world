import { winRate } from "../../../worker/admin-lib";
import { bindMarkTips, dataTable, delta, figure, hBars, legend, lineChart, stackedBars, statTile, type LineSeries } from "../charts";
import { ago, api, compact, compactMoney, esc, fmtMetric, fmtMetricCompact, humanize, money, shortDay } from "../ui";

export interface Stats {
  days: number;
  range: { from: string; to: string };
  dayList: string[];
  series: Record<string, number[]>;
  totals: Record<string, number>;
  prevTotals: Record<string, number>;
  players: { total: number; newToday: number; active24h: number; banned: number };
  allTime: { revenueCents: number; purchases: number };
  missionOutcomes: { mission_type: string; outcome: string; n: number }[];
  revenueByProduct: { id: string; name: string; purchases: number; revenueCents: number; refunds: number; refundedCents: number }[];
  settingsChanges: { key: string; label: string; n: number; last: number }[];
  config: { overrides: number; lastChange: number | null; schemaSize: number };
}

const RANGES = [7, 30, 90];
let range = 30;
try {
  range = Number(localStorage.getItem("admin.range")) || 30;
} catch {
  /* storage unavailable */
}
let metric = "";

const zeros = (n: number) => new Array<number>(n).fill(0);

export async function renderDashboard(main: HTMLElement): Promise<void> {
  const prev = main.querySelector<HTMLElement>(".dash");
  if (prev) prev.classList.add("loading"); // refetch keeps the frame
  const s = await api<Stats>(`/stats?days=${range}`);
  const ser = (m: string) => s.series[m] ?? zeros(s.dayList.length);
  const tot = (m: string) => s.totals[m] ?? 0;
  const ptot = (m: string) => s.prevTotals[m] ?? 0;
  const vs = `vs prev ${range}d`;
  const rangeLabel = `last ${range} days`;

  const wr = winRate(tot("missions_win"), tot("missions_loss"));
  const pwr = winRate(ptot("missions_win"), ptot("missions_loss"));
  const today = s.dayList.length - 1;

  // Total players at the end of each day: walk back from today's total.
  const cumulative: number[] = [];
  let running = s.players.total;
  for (let i = s.dayList.length - 1; i >= 0; i--) {
    cumulative[i] = running;
    running -= ser("new_players")[i] ?? 0;
  }

  const tiles = [
    statTile({ label: "Players", value: compact(s.players.total), delta: delta(tot("new_players"), ptot("new_players"), `new ${vs}`), spark: cumulative }),
    statTile({ label: "Active (24h)", value: compact(s.players.active24h), sub: `${compact(ser("dau")[today] ?? 0)} so far today (UTC)`, spark: ser("dau") }),
    statTile({ label: "New today", value: compact(s.players.newToday), sub: `${compact(tot("new_players"))} in ${range}d`, spark: ser("new_players") }),
    statTile({ label: `Revenue (${range}d)`, value: compactMoney(tot("revenue_cents")), delta: delta(tot("revenue_cents"), ptot("revenue_cents"), vs), spark: ser("revenue_cents") }),
    statTile({ label: `Purchases (${range}d)`, value: compact(tot("purchases")), delta: delta(tot("purchases"), ptot("purchases"), vs), spark: ser("purchases") }),
    statTile({
      label: `Mission win rate (${range}d)`,
      value: wr === null ? "–" : `${wr.toFixed(1)}%`,
      delta: wr !== null && pwr !== null ? delta(wr, pwr, vs, true, true) : undefined,
      sub: `${compact(tot("missions_win") + tot("missions_loss"))} decided runs`,
    }),
  ].join("");

  // Mission outcomes by type (part-to-whole per type).
  const byType = new Map<string, Record<string, number>>();
  for (const r of s.missionOutcomes) byType.set(r.mission_type, { ...byType.get(r.mission_type), [r.outcome]: r.n });
  const outcomeRows = [...byType]
    .map(([type, o]) => {
      const w = o.win ?? 0;
      const l = o.loss ?? 0;
      const a = o.abort ?? 0;
      const r = winRate(w, l);
      return {
        label: type,
        total: w + l + a,
        w,
        l,
        a,
        r,
        parts: [
          { key: "win", label: "Won", value: w, color: "var(--s1)" },
          { key: "loss", label: "Lost", value: l, color: "var(--s2)" },
          { key: "abort", label: "Aborted", value: a, color: "var(--s3)" },
        ],
        end: r === null ? "–" : `${Math.round(r)}% win`,
      };
    })
    .sort((a, b) => b.total - a.total);

  const allMetrics = Object.keys(s.series).sort();
  if (!metric || !allMetrics.includes(metric)) metric = allMetrics.includes("dau") ? "dau" : (allMetrics[0] ?? "");

  const seriesTable = (ms: string[]) =>
    dataTable(
      ["Day", ...ms.map(humanize)],
      s.dayList.map((d, i) => [d, ...ms.map((m) => fmtMetric(m, ser(m)[i] ?? 0))]).reverse(),
    );

  const lastChange = s.config.lastChange ? `last change ${ago(s.config.lastChange)}` : "no changes yet";

  main.innerHTML = `<div class="dash">
    <div class="toolbar">
      <h1>Dashboard</h1>
      <div class="seg" role="group" aria-label="Date range">${RANGES.map(
        (r) => `<button type="button" data-range="${r}" aria-pressed="${r === range}">${r}d</button>`,
      ).join("")}</div>
      <span class="dim">${esc(shortDay(s.range.from))} – ${esc(shortDay(s.range.to))} UTC · config: ${s.config.overrides} of ${s.config.schemaSize} settings overridden, ${esc(lastChange)}</span>
      <button type="button" class="ghost sm push" data-refresh>Refresh</button>
    </div>
    <section class="tiles" aria-label="Key figures">${tiles}</section>
    <section class="grid">
      ${figure({
        id: "f-players",
        title: "Active & new players",
        sub: `Daily, ${rangeLabel}`,
        body: legend([
          { label: "Daily active", color: "var(--s1)", value: `avg ${compact(tot("dau") / s.days)}` },
          { label: "New players", color: "var(--s2)", value: `${compact(tot("new_players"))} total` },
        ]) + `<div class="plot" data-chart="players"></div>`,
        table: seriesTable(["dau", "new_players"]),
      })}
      ${figure({
        id: "f-missions",
        title: "Missions",
        sub: `Daily, ${rangeLabel}`,
        body: legend([
          { label: "Started", color: "var(--s-muted)", value: compact(tot("missions_started")) },
          { label: "Won", color: "var(--s1)", value: compact(tot("missions_win")) },
          { label: "Lost", color: "var(--s2)", value: compact(tot("missions_loss")) },
        ]) + `<div class="plot" data-chart="missions"></div>`,
        table: seriesTable(["missions_started", "missions_win", "missions_loss", "missions_abort"]),
      })}
      ${figure({
        id: "f-revenue",
        title: "Revenue",
        sub: `${money(tot("revenue_cents"))} over ${rangeLabel} · ${money(s.allTime.revenueCents)} all time`,
        body: `<div class="plot" data-chart="revenue"></div>`,
        table: seriesTable(["revenue_cents", "purchases"]),
      })}
      ${figure({
        id: "f-products",
        title: "Revenue by product",
        sub: `Paid purchases, ${rangeLabel}`,
        body: hBars(
          s.revenueByProduct.map((p) => ({
            label: p.name,
            value: p.revenueCents,
            display: money(p.revenueCents),
            sub: `${p.purchases} sold${p.refunds ? ` · ${p.refunds} refunded` : ""}`,
          })),
        ),
        table: dataTable(
          ["Product", "Purchases", "Revenue", "Refunds", "Refunded"],
          s.revenueByProduct.map((p) => [p.name, p.purchases, money(p.revenueCents), p.refunds, money(p.refundedCents)]),
        ),
      })}
      ${figure({
        id: "f-outcomes",
        title: "Mission outcomes by type",
        sub: `Runs started in the ${rangeLabel}`,
        body:
          (outcomeRows.length
            ? legend(
                [
                  { label: "Won", color: "var(--s1)" },
                  { label: "Lost", color: "var(--s2)" },
                  { label: "Aborted", color: "var(--s3)" },
                ],
                "rect",
              )
            : "") + stackedBars(outcomeRows),
        table: dataTable(
          ["Type", "Won", "Lost", "Aborted", "Win rate"],
          outcomeRows.map((r) => [r.label, r.w, r.l, r.a, r.r === null ? "–" : `${r.r.toFixed(1)}%`]),
        ),
      })}
      ${figure({
        id: "f-settings",
        title: "Most-changed settings",
        sub: `Audit-logged edits, ${rangeLabel}`,
        body: hBars(
          s.settingsChanges.map((c) => ({ label: c.label, value: c.n, display: `${c.n}×`, sub: `last ${ago(c.last)}` })),
          "var(--s1)",
          "No settings changed in this range.",
        ),
        table: dataTable(["Setting", "Key", "Changes", "Last"], s.settingsChanges.map((c) => [c.label, c.key, c.n, ago(c.last)]), 2),
      })}
      ${figure({
        id: "f-explore",
        wide: true,
        title: "All metrics",
        sub: `Every daily counter the game records (${allMetrics.length}). New counters appear here automatically.`,
        aside: `<label class="pick"><span class="sr">Metric</span><select data-metric>${allMetrics
          .map((m) => `<option value="${esc(m)}" ${m === metric ? "selected" : ""}>${esc(humanize(m))} · ${esc(m)}</option>`)
          .join("")}</select></label>`,
        body: allMetrics.length
          ? `<div class="explore-stats" data-explore-stats></div><div class="plot" data-chart="explore"></div>`
          : `<p class="empty">No counters recorded yet.</p>`,
        table: allMetrics.length
          ? dataTable(
              ["Metric", "Key", `Total (${range}d)`, `Prev ${range}d`, "Peak day"],
              allMetrics.map((m) => [humanize(m), m, fmtMetric(m, tot(m)), fmtMetric(m, ptot(m)), fmtMetric(m, Math.max(...ser(m)))]),
              2,
            )
          : undefined,
      })}
    </section>
  </div>`;

  const plot = (name: string) => main.querySelector<HTMLElement>(`[data-chart="${name}"]`)!;
  const line = (name: string, series: LineSeries[], m: string, label: string, area = false) =>
    lineChart(plot(name), {
      days: s.dayList,
      series,
      fmt: (v) => fmtMetric(m, v),
      fmtAxis: (v) => fmtMetricCompact(m, v),
      area,
      label: `${label}, ${rangeLabel}`,
    });

  line(
    "players",
    [
      { key: "dau", label: "Daily active", values: ser("dau"), color: "var(--s1)" },
      { key: "new_players", label: "New players", values: ser("new_players"), color: "var(--s2)" },
    ],
    "players",
    "Daily active and new players",
  );
  line(
    "missions",
    [
      { key: "missions_started", label: "Started", values: ser("missions_started"), color: "var(--s-muted)" },
      { key: "missions_win", label: "Won", values: ser("missions_win"), color: "var(--s1)" },
      { key: "missions_loss", label: "Lost", values: ser("missions_loss"), color: "var(--s2)" },
    ],
    "missions",
    "Missions started, won and lost per day",
  );
  line("revenue", [{ key: "revenue_cents", label: "Revenue", values: ser("revenue_cents"), color: "var(--s1)" }], "revenue_cents", "Revenue per day", true);

  const drawExplore = () => {
    if (!metric) return;
    const v = ser(metric);
    const peak = Math.max(...v);
    const peakDay = s.dayList[v.indexOf(peak)];
    main.querySelector<HTMLElement>("[data-explore-stats]")!.innerHTML = [
      ["Total", fmtMetric(metric, tot(metric))],
      [`Avg / day`, fmtMetric(metric, tot(metric) / s.days)],
      ["Peak", `${fmtMetric(metric, peak)}${peak > 0 && peakDay ? ` (${shortDay(peakDay)})` : ""}`],
      [`Prev ${range}d`, fmtMetric(metric, ptot(metric))],
    ]
      .map(([k, val]) => `<div><span class="dim">${esc(k)}</span><b>${esc(val)}</b></div>`)
      .join("");
    line("explore", [{ key: metric, label: humanize(metric), values: v, color: "var(--s1)" }], metric, humanize(metric), true);
  };
  drawExplore();
  bindMarkTips(main);

  main.querySelector<HTMLSelectElement>("[data-metric]")?.addEventListener("change", (e) => {
    metric = (e.target as HTMLSelectElement).value;
    drawExplore();
  });
  main.querySelectorAll<HTMLButtonElement>("[data-range]").forEach(
    (b) =>
      (b.onclick = () => {
        range = Number(b.dataset.range);
        try {
          localStorage.setItem("admin.range", String(range));
        } catch {
          /* ignore */
        }
        void renderDashboard(main);
      }),
  );
  main.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () => void renderDashboard(main);
}
