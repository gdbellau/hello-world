// Rendering for mission objects that aren't agents, guards or the target
// (cameras, turrets, terminals, data packages…). Owned by the missions
// workstream so render.ts (owned by art) doesn't need to change for new kinds.

import type { Entity, Sim } from "./sim";

export function drawObject(_ctx: CanvasRenderingContext2D, _sim: Sim, _e: Entity, _t: number): void {}
