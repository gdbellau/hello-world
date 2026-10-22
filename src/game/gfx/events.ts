// Presentation-event bus for visual effects.
//
// main.ts drains `sim.events` once per frame; forward each event here:
//
//   for (const ev of s.events.splice(0)) { renderFx(ev); /* ...sfx... */ }
//
// The renderer works without this: shots, deaths, detections, takedowns and
// the alarm are inferred from sim state. Once renderFx() has been called at
// least once, the renderer stops inferring the one-shot effects that events
// cover (takedown slash, detection ping, alarm shake) so nothing doubles up.
// Effects with no sim state behind them (hack, explosion, shake, flash) only
// come through here; mission objects can push them too.

import type { Vec } from "../iso";
import type { SimEvent } from "../sim";

export type FxEvent =
  | SimEvent
  | { type: "explosion"; at: Vec; radius?: number }
  | { type: "shake"; amount: number }
  | { type: "flash"; at: Vec; color?: string; radius?: number }
  | { type: "sparks"; at: Vec; color?: string; count?: number };

const queue: FxEvent[] = [];
let wired = false;

/** Queue a visual effect for the next rendered frame. Never throws. */
export function renderFx(ev: FxEvent): void {
  wired = true;
  if (queue.length < 256) queue.push(ev);
}

/** Renderer side: take all pending events. */
export function drainFx(): FxEvent[] {
  return queue.splice(0);
}

/** True once anything has called renderFx (events are wired up). */
export function fxWired(): boolean {
  return wired;
}
