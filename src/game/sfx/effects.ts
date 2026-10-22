// Procedural sound effects. Each recipe schedules a few oscillators / noise
// bursts on the SFX bus. Rapid repeats are throttled per name.

import { existingEngine, mtof, noise, tone, type Engine } from "./engine";
import { stinger } from "./music";

export type SfxName =
  | "select"
  | "move"
  | "shot"
  | "shot_hostile"
  | "takedown"
  | "alarm"
  | "detect"
  | "hack"
  | "win"
  | "loss"
  | "ui_click"
  | "purchase"
  | "death"
  | "explosion"
  | "error";

const last = new Map<string, number>();
const MIN_GAP: Partial<Record<SfxName, number>> = { shot: 0.04, shot_hostile: 0.04, alarm: 1.2, detect: 0.25, move: 0.05, select: 0.05, death: 0.05 };
let voices = 0;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

const RECIPES: Record<SfxName, (e: Engine, t: number, out: AudioNode) => void> = {
  ui_click: (e, t, o) => {
    tone(e, t, o, { freq: 1900, to: 1300, dur: 0.035, gain: 0.18 });
    noise(e, t, o, { type: "highpass", freq: 6000, dur: 0.012, gain: 0.08 });
  },
  select: (e, t, o) => {
    tone(e, t, o, { type: "square", freq: 880, dur: 0.05, gain: 0.07, filter: 3000 });
    tone(e, t + 0.05, o, { type: "square", freq: 1320, dur: 0.07, gain: 0.07, filter: 3000 });
  },
  move: (e, t, o) => {
    tone(e, t, o, { type: "square", freq: 700, to: 520, dur: 0.07, gain: 0.06, filter: 2400 });
    tone(e, t + 0.06, o, { type: "sine", freq: 1040, dur: 0.06, gain: 0.05 });
  },
  shot: (e, t, o) => {
    // Suppressed pistol: a soft "pfft" with a mechanical click.
    const p = rnd(0.9, 1.1);
    noise(e, t, o, { type: "bandpass", freq: 1400 * p, q: 0.9, dur: 0.09, gain: 0.5 });
    noise(e, t, o, { type: "highpass", freq: 5000, dur: 0.015, gain: 0.25 });
    tone(e, t, o, { freq: 140 * p, to: 55, dur: 0.07, gain: 0.35 });
    noise(e, t + 0.05, o, { type: "bandpass", freq: 3200, q: 4, dur: 0.02, gain: 0.12 });
  },
  shot_hostile: (e, t, _o) => {
    // Rifle crack: distorted thump + bright noise + room tail.
    const p = rnd(0.92, 1.08);
    noise(e, t, e.shaper, { type: "highpass", freq: 900 * p, dur: 0.16, gain: 0.55, send: 0.35 });
    tone(e, t, e.shaper, { freq: 110 * p, to: 38, dur: 0.16, gain: 0.7 });
    noise(e, t, e.sfx, { type: "lowpass", freq: 600, dur: 0.3, gain: 0.2, send: 0.4 });
  },
  takedown: (e, t, o) => {
    noise(e, t, o, { type: "bandpass", freq: 500, to: 3200, q: 2, dur: 0.14, gain: 0.25, attack: 0.04 });
    tone(e, t + 0.12, o, { freq: 95, to: 38, dur: 0.22, gain: 0.8 });
    noise(e, t + 0.12, o, { type: "lowpass", freq: 700, dur: 0.1, gain: 0.45 });
    tone(e, t + 0.14, o, { type: "sawtooth", freq: 1800, to: 900, dur: 0.12, gain: 0.04, filter: 4000, send: 0.4 });
  },
  alarm: (e, t, o) => {
    // Two-tone klaxon with tremolo, ~1.6 s.
    const { ctx } = e;
    const osc = ctx.createOscillator();
    osc.type = "square";
    const osc2 = ctx.createOscillator();
    osc2.type = "sawtooth";
    for (let i = 0; i < 6; i++) {
      const f = i % 2 ? 622 : 784;
      osc.frequency.setValueAtTime(f, t + i * 0.27);
      osc2.frequency.setValueAtTime(f * 1.005, t + i * 0.27);
    }
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 0.03);
    g.gain.setValueAtTime(0.13, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
    const trem = ctx.createOscillator();
    trem.frequency.value = 11;
    const tg = ctx.createGain();
    tg.gain.value = 0.04;
    trem.connect(tg);
    tg.connect(g.gain);
    osc.connect(lp);
    osc2.connect(lp);
    lp.connect(g);
    g.connect(o);
    const s = ctx.createGain();
    s.gain.value = 0.3;
    g.connect(s);
    s.connect(e.verb);
    for (const n of [osc, osc2, trem]) {
      n.start(t);
      n.stop(t + 1.75);
    }
  },
  detect: (e, t, o) => {
    // "?!" sting: a sharp rising stab.
    tone(e, t, o, { type: "sawtooth", freq: mtof(76), to: mtof(88), dur: 0.08, gain: 0.12, filter: 5000 });
    tone(e, t + 0.07, o, { type: "square", freq: mtof(88), dur: 0.35, gain: 0.1, filter: 4500, send: 0.6 });
    tone(e, t + 0.07, o, { type: "square", freq: mtof(83), dur: 0.35, gain: 0.07, filter: 4500 });
  },
  hack: (e, t, o) => {
    for (let i = 0; i < 6; i++) tone(e, t + i * 0.045, o, { type: "square", freq: rnd(1100, 2600), dur: 0.035, gain: 0.05, filter: 5000 });
    tone(e, t + 0.3, o, { type: "sine", freq: 1760, dur: 0.18, gain: 0.12, send: 0.3 });
    tone(e, t + 0.3, o, { type: "sine", freq: 2637, dur: 0.18, gain: 0.06 });
  },
  win: () => stinger("win"),
  loss: () => stinger("loss"),
  purchase: (e, t, o) => {
    // FM bell + sparkle.
    for (const [i, f] of [1318.5, 1975.5, 2637].entries()) bell(e, t + i * 0.08, o, f, 0.9);
    for (let i = 0; i < 5; i++) noise(e, t + 0.2 + i * 0.04, o, { type: "highpass", freq: 9000, dur: 0.03, gain: 0.05 });
  },
  death: (e, t, o) => {
    tone(e, t, o, { freq: 70, to: 35, dur: 0.25, gain: 0.5 });
    noise(e, t, o, { type: "lowpass", freq: 400, dur: 0.15, gain: 0.25 });
  },
  explosion: (e, t, o) => {
    noise(e, t, e.shaper, { type: "lowpass", freq: 2400, to: 90, dur: 1.4, gain: 0.9, send: 0.6 });
    tone(e, t, o, { freq: 70, to: 24, dur: 1.0, gain: 0.9 });
  },
  error: (e, t, o) => {
    tone(e, t, o, { type: "square", freq: 180, dur: 0.08, gain: 0.08, filter: 1200 });
    tone(e, t + 0.1, o, { type: "square", freq: 140, dur: 0.12, gain: 0.08, filter: 1200 });
  },
};

function bell(e: Engine, t: number, out: AudioNode, f: number, v: number): void {
  const { ctx } = e;
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f * 3.5;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * 2, t);
  mg.gain.exponentialRampToValueAtTime(1, t + 0.6);
  mod.connect(mg);
  mg.connect(car.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12 * v, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  car.connect(g);
  g.connect(out);
  const s = ctx.createGain();
  s.gain.value = 0.4;
  g.connect(s);
  s.connect(e.verb);
  car.start(t);
  mod.start(t);
  car.stop(t + 1);
  mod.stop(t + 1);
}

export function playSfx(name: SfxName): void {
  const e = existingEngine();
  if (!e || e.ctx.state !== "running") return;
  const recipe = RECIPES[name];
  if (!recipe) return;
  const now = e.ctx.currentTime;
  const gap = MIN_GAP[name] ?? 0.02;
  if (now - (last.get(name) ?? -1) < gap) return;
  last.set(name, now);
  if (voices > 40) return;
  voices++;
  setTimeout(() => voices--, 400);
  try {
    recipe(e, now + 0.005, e.sfx);
  } catch {
    // A failed voice should never break the game loop.
  }
}

