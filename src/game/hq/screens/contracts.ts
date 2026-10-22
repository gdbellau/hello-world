// World map, contract list and squad loadout. Handles any number of missions
// of any type using only MissionSource id/type/name/brief.

import {
  DISTRICTS,
  agentStatus,
  contractRewards,
  contractStates,
  districtFor,
  rivalById,
  squadCap,
  type ContractState,
} from "../../../../shared/corp";
import { missionReward, type MissionType } from "../../../../shared/settings";
import { startRun } from "../../api";
import { sfx } from "../../audio";
import { loadMission, MISSION_SOURCES, type MissionSource } from "../../missions";
import { h, mount, fmtCredits, fmtInt, toast } from "../dom";
import { go, rerender } from "../nav";
import { S, bonuses, livingAgents, serverNow, setSkin, skinFor, skins, toLoadout } from "../state";
import { agentCard, btn, pageHead } from "../widgets";

const TYPE_LABEL: Record<string, string> = { assassination: "ASSASSINATION", espionage: "ESPIONAGE", research: "RESEARCH THEFT", sabotage: "SABOTAGE" };
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.toUpperCase();

function states(): ContractState[] {
  const ids = MISSION_SOURCES.map((m) => m.id);
  // Offline there is no saved progress, so every contract is open.
  if (S.offline) return ids.map((id) => (S.corp.cleared.includes(id) ? "cleared" : "available"));
  return contractStates(ids, new Set(S.corp.cleared));
}

function rewardPreview(m: MissionSource): HTMLElement {
  const b = bonuses();
  const first = !S.corp.cleared.includes(m.id);
  const type = m.type as MissionType;
  const loud = contractRewards(m.type, missionReward(type, false, S.cfg), first, S.cfg, b);
  const ghost = contractRewards(m.type, missionReward(type, true, S.cfg), first, S.cfg, b);
  return h(
    "div",
    { class: "rewards" },
    h("span", { class: "cost" }, fmtCredits(loud.credits)),
    h("span", { class: "cost ghost", title: "If no alarm is raised" }, `GHOST ${fmtCredits(ghost.credits)}`),
    loud.rp ? h("span", { class: "cost rp" }, `${fmtInt(loud.rp)} RP`) : null,
    loud.intel ? h("span", { class: "cost intel" }, `${fmtInt(loud.intel)} INTEL`) : null,
    first && Number(S.cfg.first_clear_bonus_pct) > 0 ? h("span", { class: "chip avail" }, `FIRST CLEAR +${S.cfg.first_clear_bonus_pct}%`) : null,
  );
}

export function renderWorld(main: HTMLElement): void {
  const st = states();
  const cleared = new Set(S.corp.cleared);
  mount(main, pageHead("WORLD MAP", "The sprawl, 2080. Every contract you close shifts district control toward your corp."));

  mount(
    main,
    h(
      "section",
      { class: "district-map" },
      DISTRICTS.map((d) => {
        const here = MISSION_SOURCES.filter((m) => districtFor(m.id).id === d.id);
        const won = here.filter((m) => cleared.has(m.id)).length;
        const rival = rivalById(d.rival);
        const pct = here.length ? Math.round((100 * won) / here.length) : 0;
        return h(
          "div",
          { class: `district${here.length ? " active" : ""}`, style: `--rival:${rival.colour}` },
          h("b", null, d.name.toUpperCase()),
          h("small", { class: "rival" }, rival.name),
          h("p", null, d.blurb),
          h("div", { class: "control", title: `${pct}% under your control` }, h("i", { style: `width:${pct}%` })),
          h("small", { class: "dim" }, here.length ? `${won}/${here.length} contracts · ${pct}% control` : "No open contracts"),
        );
      }),
    ),
    h("h2", { class: "section" }, "CONTRACTS"),
    h(
      "div",
      { class: "grid contracts" },
      MISSION_SOURCES.map((m, i) => {
        const s = st[i]!;
        const d = districtFor(m.id);
        return h(
          "article",
          { class: `card contract ${s}` },
          h(
            "header",
            null,
            h("span", { class: "num" }, `#${String(i + 1).padStart(2, "0")}`),
            h("span", { class: `type type-${m.type}` }, typeLabel(m.type)),
            h("span", { class: `chip ${s === "cleared" ? "ready" : s === "available" ? "avail" : "locked"}` }, s.toUpperCase()),
          ),
          h("h3", null, m.name),
          h("small", { class: "dim" }, `${d.name} · vs ${rivalById(d.rival).name}`),
          h("p", null, s === "locked" ? "Clear the previous contract to unlock this briefing." : m.brief),
          s !== "locked" ? rewardPreview(m) : null,
          h("footer", null, btn(s === "cleared" ? "REPLAY" : "BRIEFING", () => go("loadout", m.id), { disabled: s === "locked", variant: s === "cleared" ? "ghost" : "primary" })),
        );
      }),
    ),
  );
}

// --- Loadout ----------------------------------------------------------------

let loadoutFor: string | null = null;
let picked: string[] = [];
let deploying = false;

export function renderLoadout(main: HTMLElement, arg: unknown): void {
  const id = typeof arg === "string" ? arg : MISSION_SOURCES[0]!.id;
  const src = MISSION_SOURCES.find((m) => m.id === id) ?? MISSION_SOURCES[0]!;
  const mission = loadMission(src.id);
  const cap = Math.min(squadCap(S.cfg, bonuses()), mission.agentSpawns.length);
  const now = serverNow();
  const ready = livingAgents().filter((a) => agentStatus(a, now) === "ready");
  if (loadoutFor !== src.id) {
    loadoutFor = src.id;
    picked = ready.slice(0, cap).map((a) => a.id);
  }
  picked = picked.filter((pid) => ready.some((a) => a.id === pid)).slice(0, cap);
  const d = districtFor(src.id);
  const skinList = skins();

  const toggle = (aid: string) => {
    sfx("select");
    if (picked.includes(aid)) picked = picked.filter((x) => x !== aid);
    else if (picked.length < cap) picked = [...picked, aid];
    else toast(`Squad is limited to ${cap} agents`, "err");
    rerender();
  };

  const deploy = async () => {
    if (deploying || !picked.length) return;
    const agents = picked.map((pid) => S.corp.agents.find((a) => a.id === pid)!);
    let runId: string | null = null;
    if (!S.offline) {
      deploying = true;
      try {
        runId = await startRun(src.id, picked);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Could not start the contract", "err");
        return;
      } finally {
        deploying = false;
      }
    }
    S.launch({ mission, squad: agents.map(toLoadout), agentIds: [...picked], runId });
  };

  mount(
    main,
    pageHead(`LOADOUT // ${src.name.toUpperCase()}`, `${typeLabel(src.type)} · ${d.name} · vs ${rivalById(d.rival).name}`, btn("◂ WORLD MAP", () => go("world"), { variant: "ghost" })),
    h(
      "div",
      { class: "loadout" },
      h(
        "section",
        { class: "card briefing" },
        h("h2", null, "BRIEFING"),
        h("p", null, src.brief),
        rewardPreview(src),
        h(
          "ul",
          { class: "help" },
          h("li", null, h("b", null, "Left-click / drag"), " select agents · ", h("b", null, "1-6"), " pick agent · ", h("b", null, "Ctrl+A"), " all"),
          h("li", null, h("b", null, "Right-click"), " move · ", h("b", null, "Right-click enemy"), " attack"),
          h("li", null, "Reach an unaware enemy for a ", h("b", null, "silent takedown"), ". Gunfire raises the alarm."),
          h("li", null, h("b", null, "Space"), " pause · ", h("b", null, "WASD / arrows"), " pan camera"),
        ),
      ),
      h(
        "section",
        { class: "card squad" },
        h("h2", null, `SQUAD ${picked.length}/${cap}`),
        picked.length
          ? h(
              "ol",
              { class: "squad-list" },
              picked.map((pid) => {
                const a = S.corp.agents.find((x) => x.id === pid)!;
                const lo = toLoadout(a);
                return h(
                  "li",
                  null,
                  h("span", { class: "sq-who" }, h("b", null, a.name), h("small", { class: "dim" }, `LV ${a.level} · ${lo.hp} HP`)),
                  h(
                    "label",
                    { class: "skin" },
                    "Skin ",
                    h(
                      "select",
                      {
                        onchange: (ev: Event) => {
                          setSkin(a.id, (ev.target as HTMLSelectElement).value);
                          sfx("ui_click");
                        },
                      },
                      skinList.map((s) => h("option", { value: s, selected: skinFor(a.id) === s }, s.toUpperCase())),
                    ),
                  ),
                  btn("✕", () => toggle(a.id), { variant: "small ghost", title: "Remove from squad" }),
                );
              }),
            )
          : h("p", { class: "dim" }, "Select agents below."),
        h(
          "div",
          { class: "actions" },
          btn(deploying ? "CONNECTING…" : "DEPLOY SQUAD", () => void deploy(), { disabled: !picked.length || deploying }),
        ),
        S.offline ? h("p", { class: "fine" }, "Offline: results will not be saved.") : null,
      ),
    ),
    h("h2", { class: "section" }, "AVAILABLE OPERATIVES"),
    h(
      "div",
      { class: "grid cards" },
      livingAgents().map((a) => {
        const isReady = agentStatus(a, now) === "ready";
        return agentCard(a, [], { compact: true, selected: picked.includes(a.id), onClick: isReady ? () => toggle(a.id) : undefined });
      }),
    ),
  );
}
