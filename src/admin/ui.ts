// Small DOM/format helpers shared by every admin tab.

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Every admin call carries the CSRF header; the Worker rejects writes without it. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Admin-Request": "1", ...init.headers },
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body as Record<string, unknown>);
  return body;
}

export const post = <T>(path: string, body: unknown, method = "POST") => api<T>(path, { method, body: JSON.stringify(body) });

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, bad = false): void {
  const t = document.querySelector<HTMLElement>("#toast")!;
  t.textContent = msg;
  t.className = bad ? "bad" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

// --- Formatting ---------------------------------------------------------------

export const money = (cents: number, digits = 2) =>
  `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}
export const compactMoney = (cents: number) => (Math.abs(cents) >= 1e6 ? `$${compact(cents / 100)}` : money(cents, cents % 100 ? 2 : 0));

export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");

export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-22" -> "Oct 22" */
export const shortDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** Metric-aware value formatting: anything ending in `cents` is money. */
export const isMoney = (metric: string) => /cents$/.test(metric);
export const fmtMetric = (metric: string, v: number) => (isMoney(metric) ? money(v) : Math.round(v).toLocaleString());
export const fmtMetricCompact = (metric: string, v: number) => (isMoney(metric) ? compactMoney(v) : compact(v));

/** "missions_win_espionage" -> "Missions win espionage" */
export function humanize(metric: string): string {
  const known: Record<string, string> = {
    dau: "Daily active players",
    new_players: "New players",
    revenue_cents: "Revenue",
    refunded_cents: "Refunded",
    missions_started: "Missions started",
    missions_win: "Missions won",
    missions_loss: "Missions lost",
    missions_abort: "Missions aborted",
    credits_awarded: "Credits awarded",
  };
  if (known[metric]) return known[metric]!;
  const s = metric.replace(/_cents$/, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- Dialogs ----------------------------------------------------------------

export interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "textarea";
  placeholder?: string;
  value?: string;
  hint?: string;
  list?: string[];
  required?: boolean;
}

/**
 * Modal form. Resolves with the field values, or null when cancelled.
 * `submit` may throw to show an error and keep the dialog open.
 */
export function formDialog(opts: {
  title: string;
  body?: string;
  fields: Field[];
  ok: string;
  danger?: boolean;
  submit: (v: Record<string, string>) => Promise<void>;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "dlg";
    d.innerHTML = `<form method="dialog">
      <h3>${esc(opts.title)}</h3>
      ${opts.body ? `<p class="dim">${opts.body}</p>` : ""}
      ${opts.fields
        .map((f, i) => {
          const id = `f-${i}-${f.name}`;
          const list = f.list?.length ? `<datalist id="${id}-l">${f.list.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>` : "";
          const ctl =
            f.type === "textarea"
              ? `<textarea id="${id}" name="${esc(f.name)}" rows="8" placeholder="${esc(f.placeholder)}">${esc(f.value)}</textarea>`
              : `<input id="${id}" name="${esc(f.name)}" type="${f.type ?? "text"}" placeholder="${esc(f.placeholder)}" value="${esc(f.value)}"
                  ${f.list?.length ? `list="${id}-l"` : ""} ${f.required !== false ? "required" : ""} autocomplete="off">`;
          return `<label for="${id}">${esc(f.label)}</label>${ctl}${list}${f.hint ? `<div class="dim">${esc(f.hint)}</div>` : ""}`;
        })
        .join("")}
      <p class="err" role="alert" hidden></p>
      <div class="row end">
        <button type="button" class="ghost" value="cancel">Cancel</button>
        <button type="submit" class="${opts.danger ? "danger" : ""}">${esc(opts.ok)}</button>
      </div></form>`;
    document.body.append(d);
    const form = d.querySelector("form")!;
    const err = d.querySelector<HTMLElement>(".err")!;
    let done = false;
    const close = (v: boolean) => {
      if (done) return;
      done = true;
      d.close();
      d.remove();
      resolve(v);
    };
    d.querySelector<HTMLButtonElement>("button[value=cancel]")!.onclick = () => close(false);
    d.addEventListener("cancel", () => close(false));
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const values = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v)]));
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      btn.disabled = true;
      err.hidden = true;
      try {
        await opts.submit(values);
        close(true);
      } catch (e) {
        err.textContent = (e as Error).message;
        err.hidden = false;
        btn.disabled = false;
      }
    };
    d.showModal();
  });
}

export function download(filename: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
