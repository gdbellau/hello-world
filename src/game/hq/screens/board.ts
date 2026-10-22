// Title screen and the Corp HQ board.

import { contractStates, districtFor, rivalById, RIVALS, agentStatus } from "../../../../shared/corp";
import { renameCorp } from "../../api";
import { openAccount } from "../../account";
import { sfx, unlockAudio } from "../../audio";
import { MISSION_SOURCES } from "../../missions";
import { openStore } from "../../store";
import { h, mount, fmtCredits, fmtInt } from "../dom";
import { go } from "../nav";
import { S, act, livingAgents, serverNow } from "../state";
import { btn } from "../widgets";
import { typeLabel } from "./contracts";

export function renderTitle(main: HTMLElement): void {
  const cfg = S.cfg;
  const motd = cfg.motd ? h("p", { class: "motd" }, String(cfg.motd)) : null;
  const corp = S.offline
    ? h("p", { class: "dim" }, "Offline mode. Progress is not saved.")
    : h("p", { class: "dim" }, `${S.corp.corp_name} · ${fmtCredits(S.corp.credits)}`);
  const maint = Boolean(cfg.maintenance_mode);
  mount(
    main,
    h(
      "div",
      { class: "title-screen" },
      h("div", { class: "logo", "data-text": "THE CABAL" }, "THE CABAL"),
      h("p", { class: "tagline" }, "2080 // CORPORATE OPERATIONS TERMINAL"),
      motd,
      maint ? h("p", { class: "motd" }, "Systems are offline for maintenance. Try again shortly.") : corp,
      h(
        "div",
        { class: "actions" },
        btn(
          "ENTER HQ",
          () => {
            unlockAudio();
            go("hq");
          },
          { disabled: maint },
        ),
      ),
      h("p", { class: "fine" }, "Assassination · Research theft · Corporate espionage"),
    ),
  );
}

/** Board score: grows with cleared contracts, tech and the treasury. */
export function sharePrice(): number {
  const c = S.corp;
  const levels = livingAgents().reduce((n, a) => n + a.level, 0);
  return 10 + c.cleared.length * 8 + c.research.length * 3 + c.credits / 2000 + levels * 0.5;
}

const HEADLINES = [
  (r: string) => `${r} shares slide after "routine" data-centre fire`,
  (r: string) => `${r} denies links to missing biotech researcher`,
  (r: string) => `Board of ${r} votes to expand private security budget`,
  (r: string) => `Street clinics report surge in black-market ${["optics", "dermal plating", "reflex boosters"][r.length % 3]}`,
  (r: string) => `${r} CFO seen leaving Neon Row tower under armed escort`,
];

function ticker(): HTMLElement {
  const lines = RIVALS.map((r, i) => HEADLINES[i % HEADLINES.length]!(r.name));
  const text = lines.join("   ◆   ");
  return h("div", { class: "ticker", "aria-hidden": "true" }, h("span", { class: "label" }, "NEWSFEED"), h("div", { class: "track" }, h("span", null, `${text}   ◆   ${text}`)));
}

function tile(label: string, value: string, sub?: string, cls = ""): HTMLElement {
  return h("div", { class: `tile ${cls}` }, h("small", null, label), h("b", null, value), sub ? h("span", { class: "dim" }, sub) : null);
}

function rename(): void {
  if (S.offline) return;
  const name = prompt("Rename your corporation (2-32 characters):", S.corp.corp_name);
  if (!name || name === S.corp.corp_name) return;
  void act(() => renameCorp(name), "Corporation renamed", () => go("hq", undefined, false));
}

export function renderHq(main: HTMLElement): void {
  const c = S.corp;
  const ids = MISSION_SOURCES.map((m) => m.id);
  const states = contractStates(ids, new Set(c.cleared));
  const living = livingAgents();
  const ready = living.filter((a) => agentStatus(a, serverNow()) === "ready").length;
  const nextIdx = S.offline ? 0 : states.indexOf("available");
  const next = nextIdx >= 0 ? MISSION_SOURCES[nextIdx] : undefined;

  const menu: [string, string, string, () => void][] = [
    ["◈", "CONTRACTS", "World map & open jobs", () => go("world")],
    ["◉", "ROSTER", `${living.length} agents · ${ready} ready`, () => go("roster")],
    ["✚", "RECRUIT", "Hire new operatives", () => go("recruit")],
    ["⌬", "CYBERWARE", "Install augments", () => go("augments")],
    ["⚗", "R&D", `${c.research.length} projects complete`, () => go("research")],
    ["◆", "STORE", "Skins & expansions", () => (sfx("ui_click"), openStore())],
    ["⚿", "ACCOUNT", "Sign in · restore purchases", () => (sfx("ui_click"), openAccount())],
  ];

  mount(
    main,
    h(
      "section",
      { class: "board-hero" },
      h(
        "div",
        null,
        h("small", { class: "eyebrow" }, "BOARD OF DIRECTORS // QUARTERLY OPERATIONS"),
        h("h1", { class: "corp-name" }, c.corp_name, !S.offline && h("button", { class: "link", onclick: rename, title: "Rename corporation" }, "✎")),
      ),
      h("div", { class: "share" }, h("small", null, "SHARE PRICE"), h("b", null, `${sharePrice().toFixed(2)}`), h("span", { class: "dim" }, "CBL · NEO-NASDAQ")),
    ),
    h(
      "section",
      { class: "tiles" },
      tile("CREDITS", fmtCredits(c.credits), "Treasury", "credits"),
      tile("RESEARCH", fmtInt(c.research_points), "Research points", "rp"),
      tile("INTEL", fmtInt(c.intel), "Intel dossiers", "intel"),
      tile("AGENTS", `${ready}/${living.length}`, "Ready / on roster"),
      tile("CONTRACTS", `${c.cleared.length}/${ids.length}`, "Cleared"),
    ),
    next
      ? h(
          "section",
          { class: "card next-op" },
          h("small", { class: "eyebrow" }, "PRIORITY CONTRACT"),
          h("h2", null, next.name),
          h("p", { class: "dim" }, `${typeLabel(next.type)} · ${districtFor(next.id).name} · vs ${rivalById(districtFor(next.id).rival).name}`),
          h("p", null, next.brief),
          h("div", { class: "actions" }, btn("BRIEFING & LOADOUT", () => go("loadout", next.id)), btn("WORLD MAP", () => go("world"), { variant: "ghost" })),
        )
      : h("section", { class: "card next-op" }, h("h2", null, "ALL CONTRACTS CLEARED"), h("p", { class: "dim" }, "Replay any contract from the world map while new jobs come in.")),
    h(
      "nav",
      { class: "menu" },
      menu.map(([icon, label, sub, fn]) => h("button", { class: "menu-item", onclick: fn }, h("span", { class: "icon" }, icon), h("b", null, label), h("small", null, sub))),
    ),
    ticker(),
  );
}
