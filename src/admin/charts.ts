// Hand-rolled, dependency-free charts for the admin console.
// Specs (see the dataviz method): 2px lines, hairline solid grid, <=24px bars with
// 4px rounded data-ends, 2px surface gaps/rings, legend for >=2 series, crosshair
// tooltip on lines, per-mark tooltip on bars, and a table view for every chart.
// Colors are CSS custom properties so light/dark are selected, not flipped.
// Labels are untrusted: tooltip DOM uses textContent; HTML strings go through esc().

import { esc, shortDay } from "./ui";

// --- Tooltip (one floating element for the whole page) -------------------------

export interface TipRow {
  color?: string;
  value: string;
  label: string;
}

let tipEl: HTMLDivElement | null = null;
function tip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.setAttribute("role", "status");
    tipEl.hidden = true;
    document.body.append(tipEl);
  }
  return tipEl;
}

export function showTip(clientX: number, clientY: number, title: string, rows: TipRow[]): void {
  const t = tip();
  t.replaceChildren();
  const h = document.createElement("div");
  h.className = "tip-h";
  h.textContent = title;
  t.append(h);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "tip-r";
    const key = document.createElement("i");
    if (r.color) key.style.background = r.color;
    else key.className = "none";
    const v = document.createElement("b");
    v.textContent = r.value;
    const l = document.createElement("span");
    l.textContent = r.label;
    row.append(key, v, l);
    t.append(row);
  }
  t.hidden = false;
  const w = t.offsetWidth;
  const hgt = t.offsetHeight;
  let x = clientX + 14;
  if (x + w > innerWidth - 8) x = clientX - w - 14;
  let y = clientY - hgt - 12;
  if (y < 8) y = clientY + 16;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${y}px`;
}

export function hideTip(): void {
  if (tipEl) tipEl.hidden = true;
}

/** Bars, segments and cells: any element with data-tt (title) / data-tv (value) / data-tl (label). */
export function bindMarkTips(root: HTMLElement): void {
  const show = (el: HTMLElement, x: number, y: number) =>
    showTip(x, y, el.dataset.tt ?? "", [{ value: el.dataset.tv ?? "", label: el.dataset.tl ?? "", color: el.dataset.tc }]);
  root.querySelectorAll<HTMLElement>("[data-tt]").forEach((el) => {
    el.addEventListener("pointermove", (e) => show(el, e.clientX, e.clientY));
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    });
    el.addEventListener("blur", hideTip);
  });
}

// --- Scales ---------------------------------------------------------------------

export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const s = step < 1 ? 1 : step; // counters are integers
  return { max: Math.ceil(max / s) * s, step: s };
}

// --- Line / area chart --------------------------------------------------------

export interface LineSeries {
  key: string;
  label: string;
  values: number[];
  /** CSS color, normally var(--s1)… or var(--s-muted) for context series. */
  color: string;
}

export interface LineOpts {
  days: string[];
  series: LineSeries[];
  fmt: (v: number) => string;
  fmtAxis: (v: number) => string;
  /** Soft 10% wash under a single series. */
  area?: boolean;
  height?: number;
  /** Accessible summary, e.g. "Daily active players, last 30 days". */
  label: string;
}

const observed = new WeakMap<HTMLElement, LineOpts>();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const o = observed.get(e.target as HTMLElement);
    if (o) drawLine(e.target as HTMLElement, o);
  }
});

/** Renders into `host` (a .plot element) and redraws when its width changes. */
export function lineChart(host: HTMLElement, o: LineOpts): void {
  observed.set(host, o);
  drawLine(host, o);
  ro.observe(host);
}

function drawLine(host: HTMLElement, o: LineOpts): void {
  const W = Math.max(host.clientWidth, 260);
  const H = o.height ?? 220;
  const n = o.days.length;
  const maxV = Math.max(0, ...o.series.flatMap((s) => s.values));
  const { max, step } = niceScale(maxV);
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  const tickLabels = ticks.map(o.fmtAxis);
  const left = Math.max(...tickLabels.map((t) => t.length)) * 7 + 14;
  const right = 14;
  const top = 10;
  const bottom = 26;
  const pw = W - left - right;
  const ph = H - top - bottom;
  const x = (i: number) => left + (n <= 1 ? pw / 2 : (i * pw) / (n - 1));
  const y = (v: number) => top + ph - (v / max) * ph;

  // X labels: anchored on the latest day, spaced to fit.
  const maxLabels = Math.max(2, Math.floor(pw / 64));
  const stride = Math.max(1, Math.ceil(n / maxLabels));
  const xl: string[] = [];
  for (let i = n - 1; i >= 0; i -= stride) {
    const anchor = i === n - 1 && n > 1 ? "end" : i === 0 ? "start" : "middle";
    xl.push(`<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}">${esc(shortDay(o.days[i]!))}</text>`);
  }

  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const lines = o.series
    .map((s) => {
      const d = path(s.values);
      const area =
        o.area && o.series.length === 1 && n > 1
          ? `<path d="${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="${s.color}" fill-opacity="0.1" stroke="none"/>`
          : "";
      return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join("");
  const ends = o.series
    .map((s) => `<circle cx="${x(n - 1)}" cy="${y(s.values[n - 1] ?? 0)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`)
    .join("");

  const totalText = o.series.map((s) => `${s.label}: latest ${o.fmt(s.values[n - 1] ?? 0)}`).join("; ");
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0"
      aria-label="${esc(`${o.label}. ${totalText}. Use arrow keys to read values; a table view is below.`)}">
    <g class="grid">${ticks.map((t) => `<line x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
    <line class="base" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>
    <g class="ylab">${ticks.map((t, i) => `<text x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${esc(tickLabels[i])}</text>`).join("")}</g>
    <g class="xlab">${xl.join("")}</g>
    ${lines}${ends}
    <g class="hover" visibility="hidden"><line class="cross" y1="${top}" y2="${top + ph}"/>${o.series
      .map((s) => `<circle r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`)
      .join("")}</g>
    <rect class="hit" x="${left - 6}" y="${top}" width="${pw + 12}" height="${ph}" fill="transparent"/>
  </svg>`;

  const svg = host.querySelector("svg")!;
  const hover = svg.querySelector<SVGGElement>(".hover")!;
  const cross = hover.querySelector("line")!;
  const dots = [...hover.querySelectorAll("circle")];
  let cur = -1;
  const at = (i: number, clientX?: number, clientY?: number) => {
    cur = Math.max(0, Math.min(n - 1, i));
    const cx = x(cur);
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    o.series.forEach((s, k) => {
      dots[k]!.setAttribute("cx", String(cx));
      dots[k]!.setAttribute("cy", String(y(s.values[cur] ?? 0)));
    });
    hover.setAttribute("visibility", "visible");
    const r = svg.getBoundingClientRect();
    const day = o.days[cur]!;
    showTip(clientX ?? r.left + cx, clientY ?? r.top + top + 10, `${shortDay(day)} ${day.slice(0, 4)}`, o.series.map((s) => ({ color: s.color, value: o.fmt(s.values[cur] ?? 0), label: s.label })));
  };
  const off = () => {
    hover.setAttribute("visibility", "hidden");
    hideTip();
  };
  const idxFromX = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    return n <= 1 ? 0 : Math.round(((clientX - r.left - left) / pw) * (n - 1));
  };
  svg.addEventListener("pointermove", (e) => at(idxFromX(e.clientX), e.clientX, e.clientY));
  svg.addEventListener("pointerleave", off);
  svg.addEventListener("focus", () => at(cur < 0 ? n - 1 : cur));
  svg.addEventListener("blur", off);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      at((cur < 0 ? n - 1 : cur) + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "Escape") off();
  });
}

// --- Legend -------------------------------------------------------------------

export function legend(items: { label: string; color: string; value?: string }[], kind: "line" | "rect" = "line"): string {
  return `<ul class="legend">${items
    .map((i) => `<li><i class="${kind}" style="background:${i.color}"></i>${esc(i.label)}${i.value ? ` <b>${esc(i.value)}</b>` : ""}</li>`)
    .join("")}</ul>`;
}

// --- Figure card --------------------------------------------------------------

/** A chart card: title, optional subtitle, plot body, and a collapsible table view. */
export function figure(opts: { id: string; title: string; sub?: string; body: string; table?: string; wide?: boolean; aside?: string }): string {
  return `<figure class="card${opts.wide ? " wide" : ""}" id="${opts.id}">
    <figcaption><div><h3>${esc(opts.title)}</h3>${opts.sub ? `<p class="dim">${opts.sub}</p>` : ""}</div>${opts.aside ?? ""}</figcaption>
    ${opts.body}
    ${opts.table ? `<details class="tv"><summary>Table view</summary><div class="scroll">${opts.table}</div></details>` : ""}
  </figure>`;
}

export function dataTable(head: string[], rows: (string | number)[][], numericFrom = 1): string {
  return `<table class="data"><thead><tr>${head.map((h, i) => `<th${i >= numericFrom ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i >= numericFrom ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

// --- Horizontal bars ------------------------------------------------------------

export interface BarRow {
  label: string;
  value: number;
  display: string;
  sub?: string;
}

/** Single-series horizontal bars (one color), value at the tip. */
export function hBars(rows: BarRow[], color = "var(--s1)", empty = "No data in this range."): string {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="bar-row">
        <div class="bar-l" title="${esc(r.label)}">${esc(r.label)}${r.sub ? `<span class="dim"> ${esc(r.sub)}</span>` : ""}</div>
        <div class="bar-t"><span class="bar" tabindex="0" style="width:${Math.max((r.value / max) * 100, r.value > 0 ? 1 : 0)}%;background:${color}"
          data-tt="${esc(r.label)}" data-tv="${esc(r.display)}" data-tl="${esc(r.sub ?? "")}"></span><span class="bar-v">${esc(r.display)}</span></div>
      </div>`,
    )
    .join("")}</div>`;
}

export interface StackPart {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Stacked horizontal bars (part-to-whole per row), 2px surface gaps between segments. */
export function stackedBars(rows: { label: string; parts: StackPart[]; end: string }[], empty = "No data in this range."): string {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  const max = Math.max(...rows.map((r) => r.parts.reduce((a, p) => a + p.value, 0)), 1);
  return `<div class="bars">${rows
    .map((r) => {
      const total = r.parts.reduce((a, p) => a + p.value, 0);
      return `<div class="bar-row">
        <div class="bar-l">${esc(r.label)}</div>
        <div class="bar-t"><span class="stack" style="width:${(total / max) * 100}%">${r.parts
          .filter((p) => p.value > 0)
          .map(
            (p) => `<span class="sseg" tabindex="0" style="flex:${p.value};background:${p.color}" data-tc="${p.color}"
              data-tt="${esc(r.label)}" data-tv="${esc(p.value.toLocaleString())} (${Math.round((100 * p.value) / total)}%)" data-tl="${esc(p.label)}"></span>`,
          )
          .join("")}</span><span class="bar-v">${esc(r.end)}</span></div>
      </div>`;
    })
    .join("")}</div>`;
}

// --- Stat tile & sparkline ---------------------------------------------------------

export function sparkline(values: number[], label: string): string {
  const n = values.length;
  if (n < 2) return "";
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(26 - (v / max) * 24).toFixed(2)}`);
  const last = pts[n - 1]!;
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
    <polyline points="${pts.join(" ")}" fill="none" stroke="var(--s-muted)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <line x1="${last.split(",")[0]}" y1="${last.split(",")[1]}" x2="${last.split(",")[0]}" y2="${last.split(",")[1]}" stroke="var(--s1)" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export interface Delta {
  text: string;
  dir: "up" | "down" | "flat";
  good: boolean | null;
  vs: string;
}

/** Signed change vs. a previous value; `upIsGood` picks the color meaning. */
export function delta(cur: number, prev: number, vs: string, upIsGood = true, asPoints = false): Delta | undefined {
  if (asPoints) {
    const d = cur - prev;
    const dir = Math.abs(d) < 0.05 ? "flat" : d > 0 ? "up" : "down";
    return { text: `${d > 0 ? "+" : ""}${d.toFixed(1)} pts`, dir, good: dir === "flat" ? null : (dir === "up") === upIsGood, vs };
  }
  if (!prev) return cur ? { text: "new", dir: "up", good: upIsGood, vs } : undefined;
  const pct = ((cur - prev) / prev) * 100;
  const dir = Math.abs(pct) < 0.5 ? "flat" : pct > 0 ? "up" : "down";
  return { text: `${pct > 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`, dir, good: dir === "flat" ? null : (dir === "up") === upIsGood, vs };
}

export function statTile(t: { label: string; value: string; delta?: Delta; sub?: string; spark?: number[]; hero?: boolean }): string {
  const d = t.delta;
  const arrow = d ? (d.dir === "up" ? "▲" : d.dir === "down" ? "▼" : "■") : "";
  return `<div class="tile${t.hero ? " hero" : ""}">
    <div class="tile-l">${esc(t.label)}</div>
    <div class="tile-v">${esc(t.value)}</div>
    <div class="tile-d">${
      d
        ? `<span class="delta ${d.good === null ? "flat" : d.good ? "good" : "bad"}"><span aria-hidden="true">${arrow}</span> ${esc(d.text)}</span> <span class="dim">${esc(d.vs)}</span>`
        : t.sub
          ? `<span class="dim">${esc(t.sub)}</span>`
          : "&nbsp;"
    }</div>
    ${t.spark ? sparkline(t.spark, `${t.label} trend`) : ""}
  </div>`;
}

// --- Meter --------------------------------------------------------------------

/** Usage against a limit; fill carries severity, track is a lighter step. Label + icon, never color alone. */
export function meter(used: number, limit: number, label: string): string {
  const f = limit > 0 ? used / limit : 0;
  const sev = f >= 0.8 ? "crit" : f >= 0.5 ? "warn" : "ok";
  const icon = sev === "crit" ? "✕" : sev === "warn" ? "!" : "✓";
  const word = sev === "crit" ? "Near limit" : sev === "warn" ? "Watch" : "OK";
  return `<div class="meter ${sev}" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.round(used)}" aria-label="${esc(label)}">
    <div class="meter-t"><div class="meter-f" style="width:${Math.min(f * 100, 100).toFixed(1)}%"></div></div>
    <span class="meter-s"><b aria-hidden="true">${icon}</b> ${word} · ${(f * 100).toFixed(f < 0.01 ? 2 : 1)}%</span>
  </div>`;
}
