// Reusable pieces for the HQ screens.

import {
  AUGMENTS_BY_ID,
  CLASSES,
  SLOTS,
  agentStats,
  agentStatus,
  healCost,
  levelForXp,
  xpForLevel,
  type AgentClass,
  type AgentStats,
  type CorpAgent,
  type StatMods,
} from "../../../shared/corp";
import { h, fmtCredits, fmtDuration, fmtInt, type Child } from "./dom";
import { S, serverNow } from "./state";

export function btn(
  label: Child,
  onClick: () => void,
  /** variant: space-separated modifiers, e.g. "primary", "ghost", "small", "small danger". */
  opts: { variant?: string; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  return h(
    "button",
    {
      class: `btn ${opts.variant ?? "primary"}`,
      disabled: opts.disabled,
      title: opts.title,
      onclick: (ev: Event) => {
        ev.stopPropagation();
        onClick();
      },
    },
    label,
  );
}

export const CLASS_CODE: Record<AgentClass, string> = { ghost: "GH", razor: "RZ", decker: "DK", bruiser: "BR" };

export function classBadge(cls: AgentClass): HTMLElement {
  return h("span", { class: `cls cls-${cls}`, title: CLASSES[cls].name }, CLASS_CODE[cls]);
}

function statCell(label: string, value: string, delta = 0): HTMLElement {
  return h(
    "span",
    { class: `stat${delta > 0 ? " up" : delta < 0 ? " down" : ""}` },
    h("i", null, label),
    value,
  );
}

/** HP / SPD / DMG / STL line, highlighting changes against `base` when given. */
export function statLine(st: AgentStats, base?: AgentStats): HTMLElement {
  const d = (k: keyof AgentStats) => (base ? Math.sign(Math.round((st[k] - base[k]) * 100)) : 0);
  return h(
    "div",
    { class: "stats" },
    statCell("HP", fmtInt(st.hp), d("hp")),
    statCell("SPD", st.speed.toFixed(1), d("speed")),
    statCell("DMG", `×${st.damageMul.toFixed(2)}`, d("damageMul")),
    statCell("STL", `×${st.stealthMul.toFixed(2)}`, d("stealthMul")),
  );
}

export function modsText(m: StatMods): string {
  const parts: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);
  if (m.hp) parts.push(`${sign(m.hp)} HP`);
  if (m.speedPct) parts.push(`${sign(m.speedPct)}% SPD`);
  if (m.damagePct) parts.push(`${sign(m.damagePct)}% DMG`);
  if (m.stealthPct) parts.push(`${sign(m.stealthPct)}% STL`);
  return parts.join(" · ");
}

export function xpBar(a: CorpAgent): HTMLElement {
  const max = Number(S.cfg.agent_max_level);
  const lv = Math.max(a.level, levelForXp(a.xp, S.cfg));
  if (lv >= max) return h("div", { class: "xp" }, h("b", { style: "width:100%" }), h("span", null, "MAX LEVEL"));
  const lo = xpForLevel(lv, S.cfg);
  const hi = xpForLevel(lv + 1, S.cfg);
  const pct = Math.max(0, Math.min(100, (100 * (a.xp - lo)) / Math.max(1, hi - lo)));
  return h("div", { class: "xp" }, h("b", { style: `width:${pct}%` }), h("span", null, `${fmtInt(a.xp)} / ${fmtInt(hi)} XP`));
}

export function statusChip(a: CorpAgent): HTMLElement {
  const st = agentStatus(a, serverNow());
  if (st === "dead") return h("span", { class: "chip dead" }, "KIA");
  if (st === "injured") return h("span", { class: "chip injured" }, `INJURED · ${fmtDuration(a.injured_until - serverNow())}`);
  return h("span", { class: "chip ready" }, "READY");
}

export function implantChips(a: CorpAgent): HTMLElement {
  return h(
    "div",
    { class: "implants" },
    SLOTS.map((slot) => {
      const aug = a.implants[slot] ? AUGMENTS_BY_ID.get(a.implants[slot]!) : undefined;
      return h("span", { class: `slot${aug ? " on" : ""}`, title: aug ? `${aug.name}: ${modsText(aug.mods)}` : `${slot}: empty` }, h("i", null, slot.toUpperCase()), aug ? aug.name : "—");
    }),
  );
}

export function agentCard(a: CorpAgent, actions: Child[] = [], opts: { compact?: boolean; selected?: boolean; onClick?: () => void } = {}): HTMLElement {
  const st = agentStatus(a, serverNow());
  return h(
    "article",
    {
      class: `card agent-card ${st}${opts.selected ? " selected" : ""}${opts.onClick ? " clickable" : ""}`,
      onclick: opts.onClick,
      tabIndex: opts.onClick ? 0 : undefined,
      onkeydown: opts.onClick ? (ev: KeyboardEvent) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), opts.onClick!()) : undefined,
    },
    h(
      "header",
      null,
      classBadge(a.cls),
      h("div", { class: "who" }, h("b", null, a.name), h("small", null, `${a.full_name} · ${CLASSES[a.cls].name}`)),
      h("span", { class: "lv" }, `LV ${a.level}`),
    ),
    !opts.compact && xpBar(a),
    statLine(agentStats(a, S.cfg)),
    !opts.compact && implantChips(a),
    h("footer", null, statusChip(a), !opts.compact && h("small", { class: "dim" }, `${a.missions} ops · ${a.kills} kills`), ...actions),
  );
}

export function costChips(c: { credits?: number; rp?: number; intel?: number }, wallet = S.corp): HTMLElement {
  const chip = (label: string, need: number, have: number) =>
    h("span", { class: `cost${have < need ? " short" : ""}` }, label === "¥" ? fmtCredits(need) : `${fmtInt(need)} ${label}`);
  return h(
    "span",
    { class: "costs" },
    c.credits ? chip("¥", c.credits, wallet.credits) : null,
    c.rp ? chip("RP", c.rp, wallet.research_points) : null,
    c.intel ? chip("INTEL", c.intel, wallet.intel) : null,
    !c.credits && !c.rp && !c.intel ? h("span", { class: "cost" }, "FREE") : null,
  );
}

export function healButton(a: CorpAgent, onHeal: () => void): HTMLElement | null {
  if (agentStatus(a, serverNow()) !== "injured") return null;
  const cost = healCost(a.injured_until, serverNow(), S.cfg);
  return btn(`RUSH ${fmtCredits(cost)}`, onHeal, { variant: "small", disabled: S.offline || S.corp.credits < cost, title: "Pay the clinic to put this agent back on duty now" });
}

export function pageHead(title: string, sub?: Child, ...right: Child[]): HTMLElement {
  return h("div", { class: "page-head" }, h("div", null, h("h1", null, title), sub ? h("p", { class: "dim" }, sub) : null), right.length ? h("div", { class: "page-actions" }, right) : null);
}
