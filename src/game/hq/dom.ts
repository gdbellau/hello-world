// Tiny DOM builder for the HQ screens. Text always goes in via textContent,
// so player-supplied strings (corp names) can't inject markup.

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") el.setAttribute(k, String(v));
      else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/** Appends any mix of nodes, strings, arrays and nulls. */
export function mount(el: Node, ...children: Child[]): void {
  append(el, children);
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const fmtCredits = (n: number) => `¥${Math.round(n).toLocaleString("en-US")}`;
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  return `${hrs}h${String(m % 60).padStart(2, "0")}m`;
}

let toastTimer = 0;
export function toast(msg: string, kind: "ok" | "err" = "ok"): void {
  let t = document.querySelector<HTMLElement>("#toast");
  if (!t) {
    t = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t!.className = kind), 2600);
}
