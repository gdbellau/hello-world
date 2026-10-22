import "./admin.css";
import { renderAudit } from "./tabs/audit";
import { renderDashboard } from "./tabs/dashboard";
import { renderPlayers } from "./tabs/players";
import { renderProducts } from "./tabs/products";
import { renderSettings, setWho } from "./tabs/settings";
import { renderSystem } from "./tabs/system";
import { hideTip } from "./charts";
import { api, esc, formDialog, post, toast } from "./ui";

const main = document.querySelector<HTMLElement>("#main")!;

const tabs: Record<string, (main: HTMLElement, arg?: string) => Promise<void>> = {
  dashboard: renderDashboard,
  players: renderPlayers,
  settings: renderSettings,
  products: renderProducts,
  audit: renderAudit,
  system: renderSystem,
};

let current = "";
async function show(tab: string, arg?: string): Promise<void> {
  hideTip();
  document.querySelectorAll<HTMLAnchorElement>("nav.tabs a").forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  // Keep the previous frame (dimmed) when re-rendering the same tab; otherwise show a loader.
  if (tab !== current) main.innerHTML = `<p class="dim loading-msg">Loading…</p>`;
  else main.classList.add("busy");
  current = tab;
  try {
    await tabs[tab]!(main, arg);
  } catch (e) {
    main.innerHTML = `<div class="callout bad" role="alert"><b>Couldn't load ${esc(tab)}.</b> ${esc((e as Error).message)}</div>`;
  } finally {
    main.classList.remove("busy");
  }
}

function fromHash(): void {
  const [tab, arg] = location.hash.slice(1).split("/") as [string, string | undefined];
  void show(tab && tab in tabs ? tab : "dashboard", arg);
}

// --- Header ops: maintenance toggle + MOTD ------------------------------------

interface Ops {
  maintenance: boolean;
  motd: string;
}

async function loadOps(): Promise<void> {
  const s = await api<{ values: Record<string, unknown> }>("/settings");
  renderOps({ maintenance: s.values.maintenance_mode === true, motd: String(s.values.motd ?? "") });
}

function renderOps(o: Ops): void {
  const el = document.querySelector<HTMLElement>("#ops")!;
  el.innerHTML = `
    <button type="button" class="mm ${o.maintenance ? "on" : ""}" role="switch" aria-checked="${o.maintenance}" data-mm
      title="${o.maintenance ? "Maintenance mode is ON: new missions are blocked" : "Game is live"}">
      <span class="dot" aria-hidden="true"></span>${o.maintenance ? "Maintenance" : "Live"}
    </button>
    <button type="button" class="motd" data-motd title="Message of the day">
      <span class="dim">MOTD</span> <span class="motd-t">${o.motd ? esc(o.motd) : "<i>none</i>"}</span>
    </button>`;
  el.querySelector<HTMLButtonElement>("[data-mm]")!.onclick = () =>
    void formDialog({
      title: o.maintenance ? "End maintenance?" : "Enter maintenance mode?",
      body: o.maintenance
        ? "Players can start missions again."
        : "Blocks new missions and shows a maintenance banner to every player. Missions in progress can still finish.",
      fields: [{ name: "reason", label: "Reason (audit-logged)", required: false, placeholder: "optional" }],
      ok: o.maintenance ? "Go live" : "Enable maintenance",
      danger: !o.maintenance,
      submit: async (v) => {
        await post("/settings", { key: "maintenance_mode", value: !o.maintenance, reason: v.reason || undefined }, "PUT");
        toast(o.maintenance ? "Game is live" : "Maintenance mode enabled");
        void loadOps();
        if (current === "settings") void show("settings");
      },
    });
  el.querySelector<HTMLButtonElement>("[data-motd]")!.onclick = () =>
    void formDialog({
      title: "Message of the day",
      body: "Shown on the title screen. Leave empty to hide.",
      fields: [{ name: "motd", label: "Message", type: "textarea", value: o.motd, required: false }],
      ok: "Save",
      submit: async (v) => {
        await post("/settings", { key: "motd", value: (v.motd ?? "").trim() }, "PUT");
        toast("MOTD saved");
        void loadOps();
        if (current === "settings") void show("settings");
      },
    });
}

// --- Theme ----------------------------------------------------------------------

const THEMES = ["auto", "light", "dark"] as const;
function applyTheme(t: string): void {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const b = document.querySelector<HTMLButtonElement>("#theme")!;
  b.textContent = t === "dark" ? "◐ Dark" : t === "light" ? "◑ Light" : "◒ Auto";
  b.setAttribute("aria-label", `Theme: ${t}. Click to change.`);
}
let theme = "auto";
try {
  theme = localStorage.getItem("admin.theme") ?? "auto";
} catch {
  /* storage blocked */
}
applyTheme(theme);
document.querySelector<HTMLButtonElement>("#theme")!.onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme as (typeof THEMES)[number]) + 1) % THEMES.length]!;
  try {
    localStorage.setItem("admin.theme", theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme); // charts use CSS custom properties, so they recolor in place
};

document.addEventListener("settings-changed", () => void loadOps());
api<{ email: string }>("/whoami")
  .then((w) => {
    document.querySelector("#who")!.textContent = w.email;
    setWho(w.email);
  })
  .catch(() => {});
loadOps().catch(() => {});
addEventListener("hashchange", fromHash);
fromHash();
