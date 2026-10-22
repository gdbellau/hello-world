// Post-mission debrief: outcome, rewards, per-agent XP, injuries and deaths.

import { contractStates } from "../../../../shared/corp";
import type { RunResult } from "../../api";
import { MISSION_SOURCES } from "../../missions";
import { h, mount, fmtCredits, fmtDuration, fmtInt } from "../dom";
import { go } from "../nav";
import { S, serverNow } from "../state";
import { btn } from "../widgets";

export interface DebriefData {
  missionId: string;
  missionName: string;
  outcome: "win" | "loss" | "abort";
  reason: string;
  seconds: number;
  stealth: boolean;
  /** Server verdict; null offline or if the report failed. */
  result: RunResult | null;
  /** What the client saw, used when there is no server verdict. */
  local: { id: string; name: string; survived: boolean; kills: number }[];
}

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function renderDebrief(main: HTMLElement, arg: unknown): void {
  const d = arg as DebriefData;
  const r = d.result;
  const outcome = r?.outcome ?? d.outcome;
  const title = outcome === "win" ? "CONTRACT FULFILLED" : outcome === "loss" ? "CONTRACT FAILED" : "CONTRACT ABORTED";
  const rejected = r && d.outcome === "win" && r.outcome === "abort";

  const ids = MISSION_SOURCES.map((m) => m.id);
  const idx = ids.indexOf(d.missionId);
  const nextId = ids[idx + 1];
  const nextOpen = nextId && (S.offline || contractStates(ids, new Set(S.corp.cleared))[idx + 1] !== "locked");

  const rows = r
    ? r.agents.map((a) => {
        const status =
          a.status === "dead"
            ? h("span", { class: "chip dead" }, "KIA")
            : a.status === "injured"
              ? h("span", { class: "chip injured" }, `${a.survived ? "WOUNDED" : "DOWNED"} · ${fmtDuration(a.injured_until - serverNow())}`)
              : h("span", { class: "chip ready" }, "FIT");
        return h(
          "tr",
          null,
          h("td", null, h("b", null, a.name)),
          h("td", null, fmtInt(a.kills)),
          h("td", { class: "cyan" }, `+${fmtInt(a.xp_gained)}`),
          h("td", null, `LV ${a.level}`, a.leveled_up ? h("span", { class: "chip avail" }, "LEVEL UP") : null),
          h("td", null, status),
        );
      })
    : d.local.map((a) =>
        h(
          "tr",
          null,
          h("td", null, h("b", null, a.name)),
          h("td", null, fmtInt(a.kills)),
          h("td", { class: "dim" }, "—"),
          h("td", { class: "dim" }, "—"),
          h("td", null, a.survived ? h("span", { class: "chip ready" }, "EXTRACTED") : h("span", { class: "chip dead" }, "DOWN")),
        ),
      );

  mount(
    main,
    h(
      "section",
      { class: "card debrief" },
      h("small", { class: "eyebrow" }, `DEBRIEF // ${d.missionName.toUpperCase()}`),
      h("h1", { class: outcome === "win" ? "win" : "loss" }, title),
      h("p", { class: "dim" }, `Mission time ${fmtTime(d.seconds)}${d.stealth && outcome === "win" ? " · no alarms raised" : ""}${d.reason ? ` · ${d.reason}` : ""}`),
      rejected ? h("p", { class: "motd" }, "Completion rejected by corporate audit (implausibly fast). No payment issued.") : null,
      r && outcome === "win"
        ? h(
            "div",
            { class: "rewards big" },
            h("span", { class: "cost" }, `+${fmtCredits(r.reward)}`),
            r.rp ? h("span", { class: "cost rp" }, `+${fmtInt(r.rp)} RP`) : null,
            r.intel ? h("span", { class: "cost intel" }, `+${fmtInt(r.intel)} INTEL`) : null,
            r.stealth ? h("span", { class: "chip ready" }, "GHOST BONUS") : null,
            r.firstClear ? h("span", { class: "chip avail" }, "FIRST CLEAR") : null,
          )
        : null,
      !r && !S.offline ? h("p", { class: "motd" }, "Could not reach corporate servers. This result was not recorded.") : null,
      S.offline ? h("p", { class: "dim" }, "Offline mode: no rewards or progression are saved.") : null,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "results" },
          h("thead", null, h("tr", null, h("th", null, "AGENT"), h("th", null, "KILLS"), h("th", null, "XP"), h("th", null, "LEVEL"), h("th", null, "STATUS"))),
          h("tbody", null, rows),
        ),
      ),
      h(
        "div",
        { class: "actions" },
        btn("RETURN TO HQ", () => go("hq")),
        outcome === "win" && nextOpen ? btn("NEXT CONTRACT", () => go("loadout", nextId), { variant: "ghost" }) : btn("RETRY", () => go("loadout", d.missionId), { variant: "ghost" }),
      ),
    ),
  );
}
