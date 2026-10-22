// Audio facade. Gameplay code calls these; the art & audio workstream owns
// the implementation (WebAudio synth). Keep the signatures stable.

export type Sfx =
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
  | "purchase";

export type MusicTrack = "title" | "hq" | "stealth" | "combat" | "none";

export function sfx(_name: Sfx): void {}

export function music(_track: MusicTrack): void {}

/** Must be called from a user gesture before audio can play in browsers. */
export function unlockAudio(): void {}
