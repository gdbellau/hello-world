// Procedural synthwave / darksynth soundtrack: a tiny 16-step sequencer with
// per-track patterns, scheduled ahead of time on the AudioContext clock, and
// equal-power crossfades between tracks.

import { bass, clap, existingEngine as engine, hat, kick, pad, pluck, snare, type Engine } from "./engine";

export type TrackId = "title" | "hq" | "stealth" | "combat";

interface TrackDef {
  bpm: number;
  root: number; // MIDI note of the key centre (bass octave)
  /** Chord per bar: semitone offsets from root (first entry = chord root). */
  chords: number[][];
  kick: string;
  snare: string;
  clap?: string;
  hat: string; // x = closed, o = open, . = rest
  /** Bass: x = chord root, o = octave up, 5 = fifth, - = hold previous, . = rest. */
  bass: string;
  bassBright: number;
  /** Arp: digits index chord tones (+12 per wrap), . = rest. */
  arp?: string;
  arpOct: number;
  arpWave: OscillatorType;
  arpCut: number;
  /** Lead line per bar pair: semitone offsets from root+24, or null for rest. */
  lead?: (number | null)[];
  padOct: number;
  padCut: number;
  /** Bar-level arrangement: which layers drop out on which bar of a 8-bar cycle. */
  drop?: { drums?: number[]; arp?: number[] };
  gain: number;
}

const TRACKS: Record<TrackId, TrackDef> = {
  title: {
    bpm: 92,
    root: 45, // A
    chords: [
      [0, 3, 7, 12],
      [-4, 0, 3, 8],
      [3, 7, 10, 15],
      [-2, 2, 5, 10],
    ],
    kick: "x.........x.....",
    snare: "........x.......",
    hat: "..x...x...x...x.",
    bass: "x.xox.xox.xox.xo",
    bassBright: 0.9,
    arp: "0123210301232103",
    arpOct: 2,
    arpWave: "sawtooth",
    arpCut: 2200,
    lead: [12, null, 10, 7, 8, null, 7, 3, 7, null, 5, 3, 2, null, 3, null],
    padOct: 1,
    padCut: 1400,
    drop: { drums: [0], arp: [] },
    gain: 0.9,
  },
  hq: {
    bpm: 84,
    root: 50, // D
    chords: [
      [0, 3, 7, 10, 14],
      [-4, 0, 3, 7],
      [-7, -3, 0, 5],
      [-5, -2, 2, 5],
    ],
    kick: "x.......x.x.....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "x-------x---5---",
    bassBright: 0.6,
    arp: "0.2.1.3.0.2.4.3.",
    arpOct: 2,
    arpWave: "triangle",
    arpCut: 3000,
    padOct: 1,
    padCut: 900,
    drop: { drums: [0, 1] },
    gain: 0.75,
  },
  stealth: {
    bpm: 98,
    root: 40, // E (phrygian colour)
    chords: [
      [0, 3, 7, 12],
      [1, 5, 8, 13],
      [0, 3, 7, 10],
      [-2, 2, 5, 10],
    ],
    kick: "x.......x.......",
    snare: "................",
    clap: "............x...",
    hat: "x.xxx.xxx.xxx.xx",
    bass: "x.xxx.xxx.xxx.xx",
    bassBright: 0.45,
    arp: "0...2.....1...3.",
    arpOct: 2,
    arpWave: "square",
    arpCut: 1600,
    padOct: 1,
    padCut: 700,
    drop: { drums: [0, 1], arp: [4, 5] },
    gain: 0.8,
  },
  combat: {
    bpm: 128,
    root: 36, // C minor
    chords: [
      [0, 3, 7, 12],
      [-4, 0, 3, 8],
      [3, 7, 10, 15],
      [-2, 2, 5, 10],
    ],
    kick: "x...x...x...x...",
    snare: "....x.......x...",
    hat: ".xox.xox.xox.xxo",
    bass: "xoxoxoxoxoxoxo5o",
    bassBright: 1.4,
    arp: "0120312401203124",
    arpOct: 2,
    arpWave: "sawtooth",
    arpCut: 3200,
    lead: [12, 12, 15, 14, 12, null, 10, 12, 8, 8, 10, 7, 5, null, 7, null],
    padOct: 1,
    padCut: 1800,
    gain: 0.85,
  },
};

interface Instance {
  id: TrackId;
  def: TrackDef;
  out: GainNode;
  step: number;
  next: number;
  stopAt: number | null;
  lastBass: number;
}

const LOOKAHEAD = 0.15;
let playing: Instance[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function currentMusic(): TrackId | null {
  const live = playing.filter((p) => p.stopAt === null);
  return live.length ? live[live.length - 1]!.id : null;
}

/** Switches the soundtrack (null = silence) with an equal-power-ish crossfade. */
export function playMusic(id: TrackId | null, fade: number): void {
  const e = engine();
  if (!e) return;
  if (currentMusic() === id) return;
  const now = e.ctx.currentTime;
  const f = Math.max(0.05, fade);
  for (const p of playing) {
    if (p.stopAt !== null) continue;
    p.out.gain.cancelScheduledValues(now);
    p.out.gain.setValueAtTime(p.out.gain.value, now);
    p.out.gain.linearRampToValueAtTime(0.0001, now + f);
    p.stopAt = now + f;
  }
  if (id) {
    const def = TRACKS[id];
    const out = e.ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(def.gain, now + f);
    out.connect(e.music);
    playing.push({ id, def, out, step: 0, next: now + 0.05, stopAt: null, lastBass: def.root });
  }
  if (!timer) timer = setInterval(tick, 30);
}

function tick(): void {
  const e = engine();
  if (!e) return;
  const now = e.ctx.currentTime;
  if (e.ctx.state !== "running") return;
  for (const p of playing) {
    // Resync if the tab was asleep.
    if (p.next < now - 0.5) p.next = now + 0.05;
    while (p.next < now + LOOKAHEAD && (p.stopAt === null || p.next < p.stopAt)) {
      schedule(e, p, p.step, p.next);
      p.step++;
      p.next += 60 / p.def.bpm / 4;
    }
  }
  const done = playing.filter((p) => p.stopAt !== null && now > p.stopAt + 1);
  for (const p of done) p.out.disconnect();
  playing = playing.filter((p) => !done.includes(p));
  if (!playing.length && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function schedule(e: Engine, p: Instance, step: number, t: number): void {
  const d = p.def;
  const s = step % 16;
  const bar = Math.floor(step / 16);
  const chord = d.chords[bar % d.chords.length]!;
  const cyc = bar % 8;
  const sixteenth = 60 / d.bpm / 4;
  const drums = !(d.drop?.drums ?? []).includes(cyc);
  const arpOn = !(d.drop?.arp ?? []).includes(cyc);
  const out = p.out;
  // Small humanised velocity.
  const vel = (n: number) => n * (0.9 + Math.random() * 0.15);

  if (drums) {
    if (d.kick[s] === "x") kick(e, t, out, vel(1));
    if (d.snare[s] === "x") snare(e, t, out, vel(0.9), 0.7);
    if (d.clap?.[s] === "x") clap(e, t, out, vel(0.6));
    const h = d.hat[s];
    if (h === "x") hat(e, t, out, vel(0.7));
    else if (h === "o") hat(e, t, out, vel(0.6), true);
  } else if (d.hat[s] === "x" && s % 4 === 0) hat(e, t, out, 0.35);

  const b = d.bass[s];
  if (b && b !== "." && b !== "-") {
    let n = d.root + chord[0]!;
    if (b === "o") n += 12;
    if (b === "5") n += 7;
    let len = 1;
    while (d.bass[(s + len) % 16] === "-" && len < 16) len++;
    p.lastBass = n;
    bass(e, t, out, n, sixteenth * len * 0.95, 1, d.bassBright);
  }

  const a = d.arp?.[s];
  if (arpOn && a && a !== ".") {
    const idx = Number(a);
    const tone = chord[idx % chord.length]! + 12 * Math.floor(idx / chord.length);
    pluck(e, t, out, d.root + 12 * d.arpOct + tone, sixteenth * 1.6, 0.9, d.arpWave, d.arpCut, 0.45);
  }

  if (s === 0) pad(e, t, out, chord.slice(0, 3).map((c) => d.root + 12 * d.padOct + c + 12), sixteenth * 16, 1, d.padCut);

  if (d.lead && cyc >= 4 && s % 8 === 0) {
    const li = ((cyc - 4) * 2 + s / 8) % d.lead.length;
    const note = d.lead[li];
    if (note !== null && note !== undefined) pluck(e, t, out, d.root + 24 + note, sixteenth * 7, 1.1, "triangle", 4000, 0.55);
  }
}

/** One-shot musical stinger on the music bus (used by win/loss). */
export function stinger(kind: "win" | "loss"): void {
  const e = engine();
  if (!e) return;
  const t = e.ctx.currentTime + 0.02;
  if (kind === "win") {
    [60, 64, 67, 72, 76].forEach((m, i) => pluck(e, t + i * 0.09, e.sfx, m + 12, 0.5, 1.4, "sawtooth", 4000, 0.6));
    pad(e, t + 0.4, e.sfx, [60, 64, 67, 71], 1.6, 2.2, 2200);
  } else {
    [64, 60, 57, 52].forEach((m, i) => pluck(e, t + i * 0.22, e.sfx, m, 0.6, 1.2, "sawtooth", 1200, 0.5));
    bass(e, t + 0.7, e.sfx, 33, 1.6, 1.3, 0.5);
    pad(e, t + 0.6, e.sfx, [45, 48, 52], 1.8, 1.8, 600);
  }
}
