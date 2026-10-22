import { api, ago, esc, when } from "../ui";

interface Row {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

const filt = { actor: "", action: "", target: "" };

export function pretty(detail: string): string {
  if (!detail) return "";
  try {
    const o = JSON.parse(detail) as unknown;
    if (o && typeof o === "object" && !Array.isArray(o))
      return Object.entries(o as Record<string, unknown>)
        .map(([k, v]) => `<span class="kvp"><span class="dim">${esc(k)}</span> ${esc(typeof v === "string" ? v : JSON.stringify(v))}</span>`)
        .join("");
  } catch {
    /* plain text */
  }
  return esc(detail);
}

const isPlayerAction = (a: string) => a.startsWith("player.");

function rowsHtml(rows: Row[]): string {
  return rows
    .map(
      (r) => `<tr>
      <td title="${esc(when(r.at))}">${esc(ago(r.at))}<div class="dim">${esc(new Date(r.at).toLocaleString())}</div></td>
      <td>${esc(r.actor)}</td>
      <td><code>${esc(r.action)}</code></td>
      <td>${isPlayerAction(r.action) ? `<a href="#players/${encodeURIComponent(r.target)}"><code>${esc(r.target.slice(0, 8))}…</code></a>` : `<code>${esc(r.target)}</code>`}</td>
      <td class="detail">${pretty(r.detail)}</td></tr>`,
    )
    .join("");
}

export async function renderAudit(main: HTMLElement): Promise<void> {
  const qs = () => new URLSearchParams(Object.entries(filt).filter(([, v]) => v));
  const [facets, first] = await Promise.all([
    api<{ actors: { v: string; n: number }[]; actions: { v: string; n: number }[] }>("/audit/facets"),
    api<{ rows: Row[]; next: number | null }>(`/audit?${qs()}`),
  ]);
  const groups = [...new Set(facets.actions.map((a) => a.v.split(".")[0]!))];

  main.innerHTML = `
    <div class="toolbar"><h1>Audit log</h1><span class="dim">Every admin write, with the Access identity that made it.</span></div>
    <form class="filters" data-f>
      <select name="actor" aria-label="Actor"><option value="">Anyone</option>${facets.actors
        .map((a) => `<option value="${esc(a.v)}" ${filt.actor === a.v ? "selected" : ""}>${esc(a.v)} (${a.n})</option>`)
        .join("")}</select>
      <select name="action" aria-label="Action"><option value="">Any action</option>${groups
        .map(
          (g) => `<optgroup label="${esc(g)}"><option value="${esc(g)}.*" ${filt.action === `${g}.*` ? "selected" : ""}>${esc(g)}.* (all)</option>${facets.actions
            .filter((a) => a.v.startsWith(`${g}.`))
            .map((a) => `<option value="${esc(a.v)}" ${filt.action === a.v ? "selected" : ""}>${esc(a.v)} (${a.n})</option>`)
            .join("")}</optgroup>`,
        )
        .join("")}</select>
      <input type="search" name="target" value="${esc(filt.target)}" placeholder="Target contains…" aria-label="Target">
      <button type="submit">Filter</button>
      ${filt.actor || filt.action || filt.target ? `<button type="button" class="ghost" data-clear>Clear</button>` : ""}
    </form>
    <div class="card flush"><div class="scroll"><table class="data audit">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody data-rows>${rowsHtml(first.rows) || `<tr><td colspan="5" class="empty">No entries match.</td></tr>`}</tbody>
    </table></div></div>
    <div class="pager"><button type="button" class="ghost sm" data-more ${first.next ? "" : "hidden"}>Load older entries</button></div>`;

  const form = main.querySelector<HTMLFormElement>("[data-f]")!;
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(form);
    filt.actor = String(f.get("actor") ?? "");
    filt.action = String(f.get("action") ?? "");
    filt.target = String(f.get("target") ?? "").trim();
    void renderAudit(main);
  };
  form.querySelectorAll("select").forEach((s) => (s.onchange = () => form.requestSubmit()));
  const clear = main.querySelector<HTMLButtonElement>("[data-clear]");
  if (clear)
    clear.onclick = () => {
      Object.assign(filt, { actor: "", action: "", target: "" });
      void renderAudit(main);
    };

  let next = first.next;
  const more = main.querySelector<HTMLButtonElement>("[data-more]")!;
  more.onclick = async () => {
    if (!next) return;
    more.disabled = true;
    const q = qs();
    q.set("before", String(next));
    const page = await api<{ rows: Row[]; next: number | null }>(`/audit?${q}`);
    main.querySelector("[data-rows]")!.insertAdjacentHTML("beforeend", rowsHtml(page.rows));
    next = page.next;
    more.disabled = false;
    more.hidden = !next;
  };
}
