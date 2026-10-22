import "./style.css";
import { completeMission, loadConfig, online, startMission, startSession, type Me } from "./api";
import { screenToWorld, worldToScreen, type Vec } from "./iso";
import { parseMission } from "./map";
import { render, type Camera, type RenderState } from "./render";
import { Sim } from "./sim";

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const ctx = canvas.getContext("2d")!;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const cam: Camera = { x: 0, y: 0 };
const rs: RenderState = { selected: new Set(), hoverTile: null, dragBox: null };
const keys = new Set<string>();
let sim: Sim | null = null;
let paused = false;
let runId: string | null = null;
let me: Me | null = null;
let reported = false;

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
  const t = sim.target;
  $("#objective").textContent =
    t.hp > 0 ? "◆ ELIMINATE THE TARGET" : "◆ TARGET DOWN. EXTRACT ALL AGENTS (GREEN ZONE)";
  const alarm = $("#alarm");
  alarm.textContent = sim.alarm ? "ALARM" : "UNDETECTED";
  alarm.className = sim.alarm ? "pill red" : "pill green";
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

// --- Game flow --------------------------------------------------------------

async function deploy(cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const mission = parseMission();
  sim = new Sim(mission, cfg);
  paused = false;
  reported = false;
  rs.selected = new Set(sim.agents.map((a) => a.id));
  centreOn(mission.agentSpawns[0]!);
  $("#modal").hidden = true;
  $("#hud").hidden = false;
  runId = await startMission(mission.id, mission.type);
  updateHud();
}

async function finish(cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  if (!sim || reported) return;
  reported = true;
  const outcome = sim.outcome!;
  const stealth = !sim.alarm;
  const result = runId ? await completeMission(runId, outcome, stealth) : null;
  if (result) me = me ? { ...me, credits: me.credits + result.reward } : me;
  const reward = result ? `<p>Payment received: <b>¥${result.reward.toLocaleString()}</b>${result.stealth ? " (ghost bonus)" : ""}</p>` : "";
  showModal(
    outcome === "win"
      ? `<h1 class="win">CONTRACT FULFILLED</h1><p>Mission time ${fmtTime(sim.time)}.${stealth ? " No alarms raised." : ""}</p>${reward}`
      : `<h1 class="loss">CONTRACT FAILED</h1><p>${sim.agents.length ? "The target escaped." : "Your squad was eliminated."}</p>`,
    [{ label: "REDEPLOY", onClick: () => void deploy(cfg) }],
  );
}

async function boot(): Promise<void> {
  const cfg = await loadConfig();
  me = await startSession();
  const mission = parseMission();
  const motd = cfg.motd ? `<p class="motd">${String(cfg.motd).replace(/</g, "&lt;")}</p>` : "";
  const corp = me ? `<p class="dim">${me.corp_name} · ¥${me.credits.toLocaleString()}</p>` : `<p class="dim">Offline mode. Progress is not saved.</p>`;
  if (cfg.maintenance_mode) {
    showModal(`<h1>THE CABAL</h1>${motd}<p>Systems are offline for maintenance. Try again shortly.</p>`, []);
    return;
  }
  showModal(
    `<h1>THE CABAL</h1><p class="dim">2080 // CORPORATE OPERATIONS TERMINAL</p>${motd}${corp}
     <h2>${mission.name}</h2><p>${mission.brief}</p>
     <ul class="help">
       <li><b>Left-click / drag</b> select agents · <b>1-4</b> pick agent · <b>Ctrl+A</b> all</li>
       <li><b>Right-click</b> move · <b>Right-click enemy</b> attack</li>
       <li>Reach an unaware enemy for a <b>silent takedown</b>. Gunfire raises the alarm.</li>
       <li><b>Space</b> pause · <b>WASD / arrows</b> pan camera</li>
     </ul>`,
    [{ label: "DEPLOY SQUAD", onClick: () => void deploy(cfg) }],
  );

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
      render(ctx, sim, cam, rs, now / 1000);
      for (const id of rs.selected) if ((sim.byId(id)?.hp ?? 0) <= 0) rs.selected.delete(id);
      updateHud();
      if (sim.outcome) void finish(cfg);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  if (!online) console.info("[cabal] API unreachable: running offline with default settings");
}

void boot();
