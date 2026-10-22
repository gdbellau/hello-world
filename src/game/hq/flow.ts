// Between-missions flow: Title → HQ → (Roster / Recruit / Cyberware / R&D /
// World map / Store / Account) → Loadout → Mission → Debrief → HQ.
// main.ts owns the mission itself and hands control back via showDebrief().

import "./hq.css";
import type { SettingsMap } from "../../../shared/settings";
import type { Me } from "../api";
import { openAccount } from "../account";
import { music, sfx, type MusicTrack } from "../audio";
import { openStore } from "../store";
import { h, fmtCredits, fmtInt } from "./dom";
import { currentScreen, go, hideScreens, register, rerender, setFrame, type ScreenId } from "./nav";
import { renderHq, renderTitle } from "./screens/board";
import { renderLoadout, renderWorld } from "./screens/contracts";
import { renderDebrief, type DebriefData } from "./screens/debrief";
import { renderResearch } from "./screens/research";
import { renderAugments, renderRecruit, renderRoster } from "./screens/roster";
import { S, loadCorp, refreshMe, setCorp, type LaunchRequest } from "./state";

export type { DebriefData } from "./screens/debrief";
export type { LaunchRequest } from "./state";

const TABS: [ScreenId | "store" | "account", string][] = [
  ["hq", "HQ"],
  ["world", "CONTRACTS"],
  ["roster", "ROSTER"],
  ["recruit", "RECRUIT"],
  ["augments", "CYBERWARE"],
  ["research", "R&D"],
  ["store", "STORE"],
  ["account", "ACCOUNT"],
];

let track: MusicTrack | null = null;
function playMusic(t: MusicTrack): void {
  if (track !== t) music((track = t));
}

function frame(id: ScreenId, main: HTMLElement): HTMLElement {
  playMusic("hq");
  const c = S.corp;
  const active = id === "loadout" ? "world" : id;
  return h(
    "div",
    { class: "hq-frame" },
    h(
      "header",
      { class: "hq-bar" },
      h("button", { class: "brand", onclick: () => go("hq") }, "THE CABAL"),
      h("span", { class: "corp" }, c.corp_name),
      h(
        "div",
        { class: "wallet" },
        h("span", { class: "credits", title: "Credits" }, fmtCredits(c.credits)),
        h("span", { class: "rp", title: "Research points" }, `${fmtInt(c.research_points)} RP`),
        h("span", { class: "intel", title: "Intel" }, `${fmtInt(c.intel)} INT`),
      ),
    ),
    h(
      "nav",
      { class: "hq-nav" },
      TABS.map(([tid, label]) =>
        h(
          "button",
          {
            class: tid === active ? "on" : "",
            "aria-current": tid === active ? "page" : undefined,
            onclick: () => {
              if (tid === "store") (sfx("ui_click"), openStore());
              else if (tid === "account") (sfx("ui_click"), openAccount());
              else go(tid);
            },
          },
          label,
        ),
      ),
    ),
    S.offline ? h("div", { class: "offline-bar" }, "OFFLINE // corporate servers unreachable. Missions are playable; nothing is saved.") : null,
    main,
  );
}

let started = false;

/** Loads the corp and shows the title screen. */
export async function initFlow(cfg: SettingsMap, me: Me | null, launch: (req: LaunchRequest) => void): Promise<void> {
  await loadCorp(cfg, me);
  S.launch = (req) => {
    hideScreens();
    launch(req);
  };
  register("title", renderTitle, true);
  register("hq", renderHq);
  register("roster", renderRoster);
  register("recruit", renderRecruit);
  register("augments", renderAugments);
  register("research", renderResearch);
  register("world", renderWorld);
  let meFetchedAt = 0;
  register("loadout", (main, arg) => {
    // Entitlements (skins) may have changed in the store since boot.
    if (!S.offline && Date.now() - meFetchedAt > 15000) {
      meFetchedAt = Date.now();
      void refreshMe().then(() => currentScreen() === "loadout" && rerender());
    }
    renderLoadout(main, arg);
  });
  register("debrief", renderDebrief);
  setFrame(frame);
  playMusic("title");
  go("title", undefined, false);
  if (!started) {
    started = true;
    // Injury timers tick down while you browse.
    setInterval(() => {
      const id = currentScreen();
      if (id === "roster" || id === "loadout" || id === "hq" || id === "augments") rerender();
    }, 30000);
  }
}

/** main.ts switches music for missions; let the HQ resume its own track after. */
export function setMissionMusic(t: MusicTrack): void {
  playMusic(t);
}

/** Called by main.ts when a mission ends. */
export function showDebrief(d: DebriefData): void {
  if (d.result) setCorp(d.result.corp);
  else if (S.offline && d.outcome === "win" && !S.corp.cleared.includes(d.missionId)) S.corp.cleared.push(d.missionId);
  go("debrief", d, false);
}
