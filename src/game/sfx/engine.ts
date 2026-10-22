// WebAudio graph + synth voices shared by music and SFX.
// Everything is created lazily and every entry point tolerates a missing
// AudioContext (node tests, old browsers, privacy modes).

export interface Engine {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  /** Reverb send (shared). */
  verb: GainNode;
  /** Tempo-synced-ish echo send for arps/leads. */
  echo: GainNode;
  noise: AudioBuffer;
  shaper: WaveShaperNode;
}

let eng: Engine | null = null;
let failed = false;

type ACCtor = new () => AudioContext;

export function engine(): Engine | null {
  if (eng) return eng;
  if (failed) return null;
  try {
    const g = globalThis as unknown as { AudioContext?: ACCtor; webkitAudioContext?: ACCtor };
    const AC = g.AudioContext ?? g.webkitAudioContext;
    if (!AC) {
      failed = true;
      return null;
    }
    const ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(comp);
    const music = ctx.createGain();
    music.connect(master);
    const sfx = ctx.createGain();
    sfx.connect(master);

    // Reverb: exponentially decaying stereo noise impulse.
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    conv.buffer = ir;
    const verb = ctx.createGain();
    verb.gain.value = 0.9;
    verb.connect(conv);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.35;
    conv.connect(verbOut);
    verbOut.connect(master);

    // Echo: feedback delay with a darkening filter.
    const echo = ctx.createGain();
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.36;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2400;
    echo.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.5;
    lp.connect(echoOut);
    echoOut.connect(music);
    echoOut.connect(verb);

    const nlen = ctx.sampleRate * 2;
    const noise = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3);
    }
    shaper.curve = curve;
    shaper.connect(sfx);

    eng = { ctx, master, music, sfx, verb, echo, noise, shaper };
    return eng;
  } catch {
    failed = true;
    return null;
  }
}

/** The engine only if it already exists (never creates a context). */
export function existingEngine(): Engine | null {
  return eng;
}

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// Voices. All take an absolute start time and a destination node.

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  to?: number; // pitch target (exponential glide over dur)
  dur: number;
  gain: number;
  attack?: number;
  filter?: number;
  q?: number;
  detune?: number;
  send?: number; // reverb send amount
}

export function tone(e: Engine, when: number, dest: AudioNode, o: ToneOpts): void {
  const { ctx } = e;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, when);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), when + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  const a = o.attack ?? 0.003;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), when + a);
  g.gain.exponentialRampToValueAtTime(0.0001, when + o.dur);
  let node: AudioNode = osc;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = o.filter;
    f.Q.value = o.q ?? 0.7;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(dest);
  if (o.send) {
    const s = ctx.createGain();
    s.gain.value = o.send;
    g.connect(s);
    s.connect(e.verb);
  }
  osc.start(when);
  osc.stop(when + o.dur + 0.05);
}

export interface NoiseOpts {
  type?: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
  dur: number;
  gain: number;
  attack?: number;
  send?: number;
}

export function noise(e: Engine, when: number, dest: AudioNode, o: NoiseOpts): void {
  const { ctx } = e;
  const src = ctx.createBufferSource();
  src.buffer = e.noise;
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(o.freq, when);
  if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), when + o.dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  const a = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), when + a);
  g.gain.exponentialRampToValueAtTime(0.0001, when + o.dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  if (o.send) {
    const s = ctx.createGain();
    s.gain.value = o.send;
    g.connect(s);
    s.connect(e.verb);
  }
  const off = Math.random() * 1.5;
  src.start(when, off, o.dur + 0.05);
}

// --- Drum + synth voices used by the sequencer -------------------------------

export function kick(e: Engine, t: number, dest: AudioNode, v = 1): void {
  tone(e, t, dest, { freq: 160, to: 42, dur: 0.32, gain: 0.95 * v });
  noise(e, t, dest, { type: "highpass", freq: 3000, dur: 0.012, gain: 0.25 * v });
}

export function snare(e: Engine, t: number, dest: AudioNode, v = 1, verb = 0.5): void {
  noise(e, t, dest, { type: "bandpass", freq: 1900, q: 0.7, dur: 0.2, gain: 0.55 * v, send: verb });
  tone(e, t, dest, { type: "triangle", freq: 210, to: 160, dur: 0.1, gain: 0.35 * v });
}

export function clap(e: Engine, t: number, dest: AudioNode, v = 1): void {
  for (let i = 0; i < 3; i++) noise(e, t + i * 0.011, dest, { type: "bandpass", freq: 1300, q: 1.2, dur: 0.06 + (i === 2 ? 0.12 : 0), gain: 0.4 * v, send: 0.6 });
}

export function hat(e: Engine, t: number, dest: AudioNode, v = 1, open = false): void {
  noise(e, t, dest, { type: "highpass", freq: 7500, dur: open ? 0.22 : 0.045, gain: 0.22 * v });
}

export function bass(e: Engine, t: number, dest: AudioNode, midi: number, dur: number, v = 1, bright = 1): void {
  const { ctx } = e;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.Q.value = 7;
  f.frequency.setValueAtTime(180 * bright, t);
  f.frequency.exponentialRampToValueAtTime(900 * bright, t + 0.012);
  f.frequency.exponentialRampToValueAtTime(220 * bright, t + Math.min(dur, 0.25));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42 * v, t + 0.005);
  g.gain.setValueAtTime(0.42 * v, t + dur * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  for (const [type, det, mul] of [
    ["sawtooth", -6, 1],
    ["sawtooth", 6, 1],
    ["square", 0, 0.5],
  ] as const) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = mtof(midi) * mul;
    o.detune.value = det;
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  f.connect(g);
  g.connect(dest);
}

export function pluck(e: Engine, t: number, dest: AudioNode, midi: number, dur: number, v = 1, type: OscillatorType = "square", cutoff = 2600, echo = 0.4): void {
  const { ctx } = e;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = mtof(midi);
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.Q.value = 3;
  f.frequency.setValueAtTime(cutoff, t);
  f.frequency.exponentialRampToValueAtTime(cutoff * 0.25, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16 * v, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f);
  f.connect(g);
  g.connect(dest);
  if (echo) {
    const s = ctx.createGain();
    s.gain.value = echo;
    g.connect(s);
    s.connect(e.echo);
  }
  o.start(t);
  o.stop(t + dur + 0.05);
}

export function pad(e: Engine, t: number, dest: AudioNode, midis: number[], dur: number, v = 1, cutoff = 1100): void {
  const { ctx } = e;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.Q.value = 1;
  f.frequency.setValueAtTime(cutoff * 0.5, t);
  f.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.5);
  f.frequency.linearRampToValueAtTime(cutoff * 0.6, t + dur);
  const g = ctx.createGain();
  const att = Math.min(0.8, dur * 0.3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.07 * v, t + att);
  g.gain.setValueAtTime(0.07 * v, t + dur - 0.1);
  g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);
  for (const m of midis)
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = mtof(m);
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.7);
    }
  f.connect(g);
  g.connect(dest);
  const s = ctx.createGain();
  s.gain.value = 0.6;
  g.connect(s);
  s.connect(e.verb);
}
