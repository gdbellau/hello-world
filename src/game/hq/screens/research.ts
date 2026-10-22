// R&D tree.

import { BRANCHES, RESEARCH, RESEARCH_BY_ID, AUGMENTS, canResearch, researchCost } from "../../../../shared/corp";
import { startResearch } from "../../api";
import { h, mount, fmtInt } from "../dom";
import { rerender } from "../nav";
import { S, act, researched } from "../state";
import { btn, costChips, pageHead } from "../widgets";

export function renderResearch(main: HTMLElement): void {
  const done = researched();
  mount(
    main,
    pageHead(
      "RESEARCH & DEVELOPMENT",
      h(
        "span",
        null,
        `${done.size}/${RESEARCH.length} projects complete · `,
        h("b", { class: "cyan" }, `${fmtInt(S.corp.research_points)} RP`),
        " · ",
        h("b", { class: "magenta" }, `${fmtInt(S.corp.intel)} INTEL`),
        " — research theft yields RP, espionage yields intel.",
      ),
    ),
    h(
      "div",
      { class: "grid branches" },
      BRANCHES.map((br) =>
        h(
          "section",
          { class: "branch" },
          h("h2", { class: "section" }, br.name.toUpperCase()),
          RESEARCH.filter((r) => r.branch === br.id).map((r) => {
            const isDone = done.has(r.id);
            const check = canResearch(r.id, done, S.corp, S.cfg);
            const prereqMet = r.requires.every((p) => done.has(p));
            const unlocks = AUGMENTS.filter((a) => a.requires === r.id).map((a) => a.name);
            return h(
              "article",
              { class: `card project ${isDone ? "done" : prereqMet ? "open" : "locked"}` },
              h("header", null, h("b", null, r.name), h("span", { class: `chip ${isDone ? "ready" : prereqMet ? "avail" : "locked"}` }, isDone ? "COMPLETE" : prereqMet ? "AVAILABLE" : "LOCKED")),
              h("p", null, r.desc),
              unlocks.length ? h("small", { class: "dim" }, `Unlocks: ${unlocks.join(", ")}`) : null,
              r.requires.length
                ? h(
                    "small",
                    { class: "reqs" },
                    "Requires: ",
                    r.requires.map((p, i) => [i ? ", " : "", h("span", { class: done.has(p) ? "met" : "unmet" }, RESEARCH_BY_ID.get(p)?.name ?? p)]),
                  )
                : null,
              isDone
                ? null
                : h(
                    "footer",
                    null,
                    costChips(researchCost(r, S.cfg)),
                    btn("RESEARCH", () => void act(() => startResearch(r.id), `${r.name} complete`, rerender), {
                      variant: "small",
                      disabled: S.offline || !check.ok,
                      title: S.offline ? "Offline" : check.ok ? undefined : check.reason,
                    }),
                  ),
            );
          }),
        ),
      ),
    ),
  );
}
