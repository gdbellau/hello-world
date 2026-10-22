// Audio facade. Gameplay code calls these; the implementation is a WebAudio
// synth (src/game/sfx/*): procedural synthwave music and SFX, no audio files.
// Every export is safe to call anywhere: without an AudioContext (node tests,
// blocked autoplay) calls are silently ignored.

import { defaultSettings, type SettingsMap } from "../../shared/settings";
import { engine, existingEngine } from "./sfx/engine";
import { playSfx, type SfxName } from "./sfx/effects";
import { currentMusic, playMusic, type TrackId } from "./sfx/music";

export type Sfx = SfxName;

export type MusicTrack = "title" | "hq" | "stealth" | "combat" | "none";

export type VolumeChannel = "master" | "music" | "sfx";

interface Prefs {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
  /** True once the player changed volumes locally; settings defaults then stop applying. */
  custom: boolean;
}

const KEY = "cabal.audio";
const defs = defaultSettings();
const prefs: Prefs = {
  master: Number(defs.default_master_volume ?? 0.8),
  music: Number(defs.default_music_volume ?? 0.45),
  sfx: Number(defs.default_sfx_volume ?? 0.8),
  muted: false,
  custom: false,
};
let musicEnabled = true;
let crossfade = 2;
let wanted: MusicTrack = "none";
let explicit = false;

try {
  const raw = globalThis.localStorage?.getItem(KEY);
  if (raw) {
    const p = JSON.parse(raw) as Partial<Prefs>;
    for (const k of ["master", "music", "sfx"] as const) if (typeof p[k] === "number" && Number.isFinite(p[k])) prefs[k] = clamp01(p[k]);
    if (typeof p.muted === "boolean") prefs.muted = p.muted;
    if (typeof p.custom === "boolean") prefs.custom = p.custom;
  }
} catch {
  // Storage unavailable or corrupt: keep defaults.
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function save(): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private mode etc.
  }
}

function applyGains(): void {
  const e = existingEngine();
  if (!e) return;
  const t = e.ctx.currentTime;
  const set = (p: AudioParam, v: number) => {
    p.cancelScheduledValues(t);
    p.setTargetAtTime(v, t, 0.03);
  };
  set(e.master.gain, prefs.muted ? 0 : prefs.master);
  set(e.music.gain, musicEnabled ? prefs.music : 0);
  set(e.sfx.gain, prefs.sfx);
}

function startWanted(): void {
  const e = existingEngine();
  if (!e || e.ctx.state !== "running") return;
  const id: TrackId | null = musicEnabled && wanted !== "none" ? wanted : null;
  if (currentMusic() !== id) playMusic(id, crossfade);
}

/** Play a one-shot sound effect. */
export function sfx(name: Sfx): void {
  try {
    playSfx(name);
  } catch {
    // Never let audio break gameplay.
  }
}

/** Switch the soundtrack with a crossfade ("none" fades out). */
export function music(track: MusicTrack): void {
  explicit = true;
  wanted = track;
  try {
    startWanted();
  } catch {
    // ignore
  }
}

/**
 * Soft music cue used by the renderer and audio module itself (title on
 * first gesture, stealth on deploy, combat on alarm, hq after a mission).
 * Ignored once anyone calls music() directly, so main.ts can take over.
 */
export function autoMusic(track: MusicTrack): void {
  if (explicit) return;
  wanted = track;
  try {
    startWanted();
  } catch {
    // ignore
  }
}

/** Must be called from a user gesture before audio can play in browsers. Also auto-attached below. */
export function unlockAudio(): void {
  try {
    const e = engine();
    if (!e) return;
    applyGains();
    const go = () => {
      if (!explicit && wanted === "none") wanted = "title";
      startWanted();
    };
    if (e.ctx.state !== "running") void e.ctx.resume().then(go, () => {});
    else go();
  } catch {
    // ignore
  }
}

/** Apply admin-panel defaults (only until the player sets their own volumes). */
export function applyAudioSettings(cfg: SettingsMap): void {
  const n = (k: string, d: number) => (Number.isFinite(Number(cfg[k])) && cfg[k] !== undefined ? Number(cfg[k]) : d);
  if (!prefs.custom) {
    prefs.master = clamp01(n("default_master_volume", prefs.master));
    prefs.music = clamp01(n("default_music_volume", prefs.music));
    prefs.sfx = clamp01(n("default_sfx_volume", prefs.sfx));
  }
  musicEnabled = cfg.music_enabled !== false;
  crossfade = Math.max(0, n("music_crossfade_s", crossfade));
  applyGains();
  try {
    startWanted();
  } catch {
    // ignore
  }
}

export function setVolume(ch: VolumeChannel, v: number): void {
  prefs[ch] = clamp01(Number.isFinite(v) ? v : 0);
  prefs.custom = true;
  save();
  applyGains();
}

export function getVolume(ch: VolumeChannel): number {
  return prefs[ch];
}

export function setMuted(m: boolean): void {
  prefs.muted = m;
  save();
  applyGains();
}

export function isMuted(): boolean {
  return prefs.muted;
}

export function toggleMute(): boolean {
  setMuted(!prefs.muted);
  return prefs.muted;
}

/** The track currently audible (or requested, before the first gesture). */
export function currentTrack(): MusicTrack {
  return (currentMusic() as MusicTrack | null) ?? wanted;
}

// Unlock on the first user gesture even if nobody calls unlockAudio().
try {
  const w = globalThis as unknown as { addEventListener?: Window["addEventListener"]; removeEventListener?: Window["removeEventListener"] };
  if (typeof w.addEventListener === "function" && typeof document !== "undefined") {
    const once = () => {
      unlockAudio();
      w.removeEventListener?.("pointerdown", once, true);
      w.removeEventListener?.("keydown", once, true);
    };
    w.addEventListener("pointerdown", once, true);
    w.addEventListener("keydown", once, true);
  }
} catch {
  // Non-browser environment.
}
