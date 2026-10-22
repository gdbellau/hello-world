// Roster, recruitment and cyberware screens.

import {
  AGENT_CLASSES,
  AUGMENTS,
  CLASSES,
  RESEARCH_BY_ID,
  SLOTS,
  agentStats,
  augmentPrice,
  augmentUnlocked,
  recruitCost,
  rosterCap,
  type CorpAgent,
} from "../../../../shared/corp";
import { dismissAgent, healAgent, installAugment, recruitAgent, removeAugment } from "../../api";
import { h, mount, fmtCredits } from "../dom";
import { go, rerender } from "../nav";
import { S, act, bonuses, livingAgents, researched } from "../state";
import { agentCard, btn, classBadge, costChips, healButton, modsText, pageHead, statLine } from "../widgets";

function heal(a: CorpAgent) {
  void act(() => healAgent(a.id), `${a.name} is back on duty`, rerender);
}

export function renderRoster(main: HTMLElement): void {
  const living = livingAgents();
  const dead = S.corp.agents.filter((a) => a.dead);
  const cap = rosterCap(S.cfg, bonuses());
  mount(
    main,
    pageHead("ROSTER", `${living.length}/${cap} operatives on the books`, btn("RECRUIT", () => go("recruit"))),
    living.length
      ? h(
          "div",
          { class: "grid cards" },
          living.map((a) =>
            agentCard(a, [
              h(
                "div",
                { class: "card-actions" },
                healButton(a, () => heal(a)),
                btn("CYBERWARE", () => go("augments", a.id), { variant: "small" }),
                btn(
                  "DISMISS",
                  () => {
                    if (confirm(`Dismiss ${a.name}? Their implants go with them.`)) void act(() => dismissAgent(a.id), `${a.name} dismissed`, rerender);
                  },
                  { variant: "small danger", disabled: S.offline },
                ),
              ),
            ]),
          ),
        )
      : h("div", { class: "card empty" }, h("p", null, "No operatives. Recruit a new squad to keep the corp in business."), btn("RECRUIT", () => go("recruit"))),
    dead.length ? [h("h2", { class: "section" }, "MEMORIAL WALL"), h("div", { class: "grid cards" }, dead.map((a) => agentCard(a, [], { compact: true })))] : null,
  );
}

let lastHire: string | null = null;

export function renderRecruit(main: HTMLElement): void {
  const b = bonuses();
  const living = livingAgents();
  const cap = rosterCap(S.cfg, b);
  const cost = recruitCost(S.cfg, b, living.length);
  const full = living.length >= cap;
  const broke = S.corp.credits < cost;
  const reason = S.offline ? "Offline" : full ? "Roster full" : broke ? "Not enough credits" : undefined;
  const hire = (cls?: string) =>
    void act(
      async () => {
        const r = await recruitAgent(cls);
        lastHire = r.recruited;
        return r;
      },
      "New operative signed",
      rerender,
    );
  const latest = lastHire ? S.corp.agents.find((a) => a.id === lastHire) : undefined;

  mount(
    main,
    pageHead(
      "RECRUITMENT",
      h("span", null, `Roster ${living.length}/${cap} · Hiring fee `, h("b", { class: "yellow" }, cost ? fmtCredits(cost) : "FREE"), reason ? ` · ${reason}` : ""),
      btn("HIRE RANDOM", () => hire(), { disabled: !!reason, title: reason }),
    ),
    latest ? [h("h2", { class: "section" }, "LATEST HIRE"), h("div", { class: "grid cards" }, agentCard(latest))] : null,
    h("h2", { class: "section" }, "CHOOSE A SPECIALISATION"),
    h(
      "div",
      { class: "grid cards" },
      AGENT_CLASSES.map((cls) => {
        const d = CLASSES[cls];
        return h(
          "article",
          { class: "card class-card" },
          h("header", null, classBadge(cls), h("div", { class: "who" }, h("b", null, d.name.toUpperCase()), h("small", null, "Level 1 recruit"))),
          h("p", null, d.role),
          statLine(agentStats({ cls, level: 1, implants: {} }, S.cfg)),
          h("footer", null, btn(`HIRE ${d.name.toUpperCase()}`, () => hire(cls), { disabled: !!reason, title: reason })),
        );
      }),
    ),
  );
}

let augAgent: string | null = null;

export function renderAugments(main: HTMLElement, arg: unknown): void {
  const living = livingAgents();
  if (typeof arg === "string") augAgent = arg;
  let agent = living.find((a) => a.id === augAgent) ?? living[0];
  augAgent = agent?.id ?? null;
  mount(main, pageHead("CYBERWARE CLINIC", "Implants install instantly. Replacing an implant discards the old one."));
  if (!agent) {
    mount(main, h("div", { class: "card empty" }, h("p", null, "No living agents to augment."), btn("RECRUIT", () => go("recruit"))));
    return;
  }
  const a = agent;
  const base = agentStats(a, S.cfg);
  const done = researched();
  mount(
    main,
    h(
      "div",
      { class: "picker", role: "tablist" },
      living.map((x) =>
        h(
          "button",
          { class: `pick${x.id === a.id ? " on" : ""}`, role: "tab", "aria-selected": String(x.id === a.id), onclick: () => go("augments", x.id) },
          classBadge(x.cls),
          x.name,
        ),
      ),
    ),
    agentCard(a, [], { compact: false }),
    h(
      "div",
      { class: "grid slots" },
      SLOTS.map((slot) =>
        h(
          "section",
          { class: "card slot-col" },
          h("h2", null, slot.toUpperCase()),
          AUGMENTS.filter((g) => g.slot === slot).map((g) => {
            const installed = a.implants[slot] === g.id;
            const unlocked = augmentUnlocked(g, done);
            const price = augmentPrice(g, S.cfg);
            const after = agentStats({ ...a, implants: { ...a.implants, [slot]: g.id } }, S.cfg);
            let action: HTMLElement;
            if (installed)
              action = btn(
                "REMOVE",
                () => {
                  if (confirm(`Remove ${g.name}? It will be discarded.`)) void act(() => removeAugment(a.id, slot), `${g.name} removed`, rerender);
                },
                { variant: "ghost", disabled: S.offline },
              );
            else if (!unlocked) action = h("span", { class: "chip locked" }, `R&D: ${RESEARCH_BY_ID.get(g.requires!)?.name ?? g.requires}`);
            else
              action = btn(`INSTALL ${fmtCredits(price)}`, () => void act(() => installAugment(a.id, g.id), `${g.name} installed on ${a.name}`, rerender), {
                variant: "small",
                disabled: S.offline || S.corp.credits < price,
                title: S.corp.credits < price ? "Not enough credits" : undefined,
              });
            return h(
              "div",
              { class: `aug${installed ? " installed" : ""}${unlocked ? "" : " locked"}` },
              h("div", { class: "aug-head" }, h("b", null, g.name), installed ? h("span", { class: "chip ready" }, "INSTALLED") : costChips({ credits: price })),
              h("small", { class: "mods" }, modsText(g.mods)),
              h("p", null, g.desc),
              !installed && unlocked ? statLine(after, base) : null,
              h("div", { class: "aug-actions" }, action),
            );
          }),
        ),
      ),
    ),
  );
}
