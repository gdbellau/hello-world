import "./style.css";
import type { SettingsMap } from "../../shared/settings";
import { completeRun, loadConfig, online, startSession, type AgentRunResult, type RunResult } from "./api";
import { initAccountFlow } from "./account";
import { sfx, toggleMute } from "./audio";
import { initFlow, setMissionMusic, showDebrief, type LaunchRequest } from "./hq/flow";
import { dist, screenToWorld, worldToScreen, type Vec } from "./iso";
import { render, renderAmbient, renderFx, type Camera, type RenderState } from "./render";
import { Sim } from "./sim";

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const ctx = canvas.getContext("2d")!;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const cam: Camera = { x: 0, y: 0 };
const rs: RenderState = { selected: new Set(), hoverTile: null, dragBox: null };
const keys = new Set<string>();
let sim: Sim | null = null;
let paused = false;
let cfg: SettingsMap = {};
/** The deployed run: squad ids in spawn order, kill tally per squad slot. */
let run: { req: LaunchRequest; kills: number[]; aborted: boolean; reported: boolean } | null = null;

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
}
addEventListener("resize", resize);
resize();

function centreOn(p: Vec): void {
  const s = worldToScreen(p.x, p.y);
  cam.x = innerWidth / 2 - s.x;
  cam.y = innerHeight / 2 - s.y;
}

function mouseWorld(ev: MouseEvent): Vec {
  return screenToWorld(ev.clientX - cam.x, ev.clientY - cam.y);
}

function entityAtScreen(x: number, y: number) {
  if (!sim) return undefined;
  let best;
  let bestD = 22;
  for (const e of sim.entities) {
    if (e.hp <= 0) continue;
    const s = worldToScreen(e.pos.x, e.pos.y);
    const d = Math.hypot(s.x + cam.x - x, s.y + cam.y - 16 - y);
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

// --- Input ------------------------------------------------------------------

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

let dragStart: { x: number; y: number } | null = null;
canvas.addEventListener("mousedown", (ev) => {
  if (!sim || sim.outcome) return;
  if (ev.button === 0) dragStart = { x: ev.clientX, y: ev.clientY };
  if (ev.button === 2) {
    const ids = [...rs.selected];
    if (!ids.length) return;
    const hit = entityAtScreen(ev.clientX, ev.clientY);
    if (hit && hit.kind !== "agent") sim.orderAttack(ids, hit.id);
    else sim.orderMove(ids, mouseWorld(ev));
  }
});

canvas.addEventListener("mousemove", (ev) => {
  rs.hoverTile = mouseWorld(ev);
  if (dragStart && Math.hypot(ev.clientX - dragStart.x, ev.clientY - dragStart.y) > 6) {
    rs.dragBox = { x0: dragStart.x, y0: dragStart.y, x1: ev.clientX, y1: ev.clientY };
  }
});

addEventListener("mouseup", (ev) => {
  if (!sim || ev.button !== 0 || !dragStart) return;
  if (!ev.shiftKey) rs.selected.clear();
  if (rs.dragBox) {
    const b = rs.dragBox;
    const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
    const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    for (const a of sim.agents) {
      const s = worldToScreen(a.pos.x, a.pos.y);
      const sx = s.x + cam.x;
      const sy = s.y + cam.y - 16;
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) rs.selected.add(a.id);
    }
  } else {
    const hit = entityAtScreen(ev.clientX, ev.clientY);
    if (hit?.kind === "agent") rs.selected.add(hit.id);
  }
  dragStart = null;
  rs.dragBox = null;
  updateHud();
});

addEventListener("keydown", (ev) => {
  keys.add(ev.key.toLowerCase());
  // M toggles all audio, on any screen (but not while typing in a field).
  if (ev.key.toLowerCase() === "m" && !(ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement)) toggleMute();
  if (!sim) return;
  if (ev.code === "Space") {
    ev.preventDefault();
    paused = !paused;
  }
  if (ev.key === "Escape") rs.selected.clear();
  const n = Number(ev.key);
  if (n >= 1 && n <= 9) {
    const a = sim.entities.filter((e) => e.kind === "agent")[n - 1];
    if (a && a.hp > 0) {
      if (!ev.shiftKey) rs.selected.clear();
      rs.selected.add(a.id);
    }
  }
  if (ev.key.toLowerCase() === "a" && ev.ctrlKey) {
    ev.preventDefault();
    sim.agents.forEach((a) => rs.selected.add(a.id));
  }
  updateHud();
});
addEventListener("keyup", (ev) => keys.delete(ev.key.toLowerCase()));

// --- HUD --------------------------------------------------------------------

function fmtTime(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function updateHud(): void {
  if (!sim) return;
  $("#objective").textContent = `◆ ${sim.objectiveText()}`;
  const alarm = $("#alarm");
  const state = sim.alertState();
  alarm.textContent = state === "alarmed" ? "ALARM" : state === "suspicious" ? "SUSPICIOUS" : "UNDETECTED";
  alarm.className = `pill ${state === "alarmed" ? "red" : state === "suspicious" ? "yellow" : "green"}`;
  $("#clock").textContent = fmtTime(sim.time);
  $("#paused").hidden = !paused;
  // Only rebuild the roster when it changes, or clicks get eaten mid-frame.
  const key = sim.entities
    .filter((e) => e.kind === "agent")
    .map((a) => `${a.id}:${Math.ceil(a.hp)}:${rs.selected.has(a.id)}`)
    .join("|");
  const roster = $("#roster");
  if (roster.dataset.key === key) return;
  roster.dataset.key = key;
  roster.replaceChildren(
    ...sim.entities
      .filter((e) => e.kind === "agent")
      .map((a, i) => {
        const card = document.createElement("button");
        card.className = `agent${rs.selected.has(a.id) ? " sel" : ""}${a.hp <= 0 ? " dead" : ""}`;
        card.innerHTML = `<span class="k">${i + 1}</span><b>${a.name}</b><i style="width:${(100 * a.hp) / a.maxHp}%"></i>`;
        card.onclick = (ev) => {
          if (a.hp <= 0) return;
          if (!ev.shiftKey) rs.selected.clear();
          rs.selected.add(a.id);
          updateHud();
        };
        return card;
      }),
  );
}

function showModal(html: string, actions: { label: string; onClick: () => void }[]): void {
  const m = $("#modal");
  m.querySelector(".body")!.innerHTML = html;
  const bar = m.querySelector(".actions")!;
  bar.replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.onclick = a.onClick;
      return b;
    }),
  );
  m.hidden = false;
}

/** Squad-ordered agent entities (spawn order = squad order). */
const squadEntities = (s: Sim) => s.entities.filter((e) => e.kind === "agent");

function drainEvents(s: Sim): void {
  for (const ev of s.events.splice(0)) {
    renderFx(ev);
    switch (ev.type) {
      case "shot":
        sfx(ev.hostile ? "shot_hostile" : "shot");
        break;
      case "takedown":
        sfx("takedown");
        break;
      case "detect":
      case "suspicious":
        sfx("detect");
        break;
      case "alarm":
        sfx("alarm");
        setMissionMusic("combat");
        break;
      case "reinforcements":
        sfx("alarm");
        renderFx({ type: "shake", amount: 4 });
        break;
      case "hack":
      case "door":
        sfx("hack");
        break;
      case "pickup":
      case "drop":
        sfx("select");
        break;
      case "disabled":
        sfx("explosion");
        break;
      case "outcome":
        sfx(ev.outcome);
        break;
      case "death":
        sfx("death");
        if (ev.kind !== "agent") creditKill(s, ev.id);
        break;
    }
  }
}

/** The sim doesn't name the killer: credit the agent ordered to attack, else the nearest one. */
function creditKill(s: Sim, victimId: number): void {
  if (!run) return;
  const victim = s.byId(victimId);
  const squad = squadEntities(s);
  let best = squad.findIndex((a) => a.hp > 0 && a.attackId === victimId);
  if (best < 0 && victim) {
    let bestD = Infinity;
    squad.forEach((a, i) => {
      const d = dist(a.pos, victim.pos);
      if (a.hp > 0 && d < bestD) {
        bestD = d;
        best = i;
      }
    });
  }
  if (best >= 0) run.kills[best] = (run.kills[best] ?? 0) + 1;
}

// --- Game flow --------------------------------------------------------------

function launch(req: LaunchRequest): void {
  // squad_size is raised to the squad we were handed (R&D can grow it past the base setting).
  sim = new Sim(req.mission, { ...cfg, squad_size: req.squad.length }, req.squad);
  run = { req, kills: req.squad.map(() => 0), aborted: false, reported: false };
  paused = false;
  rs.selected = new Set(sim.agents.map((a) => a.id));
  centreOn(req.mission.agentSpawns[0]!);
  $("#modal").hidden = true;
  $("#hud").hidden = false;
  delete $("#roster").dataset.key;
  setMissionMusic("stealth");
  updateHud();
}

function confirmAbort(): void {
  if (!sim || sim.outcome || !run) return;
  const wasPaused = paused;
  paused = true;
  showModal(`<h1 class="loss">ABORT?</h1><p>Pull the squad out. The contract is forfeited; injuries still count.</p>`, [
    {
      label: "ABORT CONTRACT",
      onClick: () => {
        $("#modal").hidden = true;
        if (run) run.aborted = true;
        void finish();
      },
    },
    {
      label: "CONTINUE",
      onClick: () => {
        $("#modal").hidden = true;
        paused = wasPaused;
      },
    },
  ]);
}
$("#abort").addEventListener("click", () => {
  sfx("ui_click");
  confirmAbort();
});

async function finish(): Promise<void> {
  const s = sim;
  const r = run;
  if (!s || !r || r.reported) return;
  r.reported = true;
  const outcome = r.aborted ? "abort" : s.outcome!;
  const stealth = !s.alarm;
  const ents = squadEntities(s);
  const local = r.req.agentIds.map((id, i) => {
    const e = ents[i];
    return {
      id,
      name: e?.name ?? r.req.squad[i]?.name ?? "?",
      survived: e ? e.hp > 0 : true,
      kills: r.kills[i] ?? 0,
      hpPct: e ? Math.round((100 * Math.max(0, e.hp)) / e.maxHp) : 100,
    };
  });
  const report: AgentRunResult[] = local.map(({ id, survived, kills, hpPct }) => ({ id, survived, kills, hpPct }));
  const pending: Promise<RunResult | null> = r.req.runId ? completeRun(r.req.runId, outcome, stealth, report) : Promise.resolve(null);
  // Let the final moment of the mission land before the debrief.
  const [result] = await Promise.all([pending, new Promise((res) => setTimeout(res, r.aborted ? 0 : 1400))]);
  sim = null;
  run = null;
  rs.selected.clear();
  $("#hud").hidden = true;
  $("#modal").hidden = true;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  showDebrief({
    missionId: r.req.mission.id,
    missionName: r.req.mission.name,
    outcome,
    reason: r.aborted ? "Squad pulled out." : s.outcomeReason,
    seconds: s.time,
    stealth,
    result,
    local,
  });
}

async function boot(): Promise<void> {
  cfg = await loadConfig();
  // Consumes ?login= / ?purchase= return links; may swap the session token, so it runs before startSession.
  await initAccountFlow();
  const me = await startSession();
  await initFlow(cfg, me, launch);

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const pan = 600 * dt;
    if (keys.has("w") || keys.has("arrowup")) cam.y += pan;
    if (keys.has("s") || keys.has("arrowdown")) cam.y -= pan;
    if (keys.has("a") || keys.has("arrowleft")) cam.x += pan;
    if (keys.has("d") || keys.has("arrowright")) cam.x -= pan;
    if (sim) {
      if (!paused) sim.update(dt);
      drainEvents(sim);
      render(ctx, sim, cam, rs, now / 1000);
      for (const id of rs.selected) if ((sim.byId(id)?.hp ?? 0) <= 0) rs.selected.delete(id);
      updateHud();
      if (sim.outcome) void finish();
    } else {
      // Animated skyline behind the HQ screens (which are translucent over the canvas).
      renderAmbient(ctx, now / 1000, Number(cfg.graphics_quality ?? 2));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  if (!online) console.info("[cabal] API unreachable: running offline with default settings");
}

void boot();
