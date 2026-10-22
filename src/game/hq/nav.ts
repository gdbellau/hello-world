// Screen router for the between-missions UI. Screens register themselves in
// flow.ts; anything can navigate with go() without importing the screens.

import { sfx } from "../audio";

export type ScreenId =
  | "title"
  | "hq"
  | "roster"
  | "recruit"
  | "augments"
  | "research"
  | "world"
  | "loadout"
  | "debrief";

export type Render = (main: HTMLElement, arg: unknown) => void;

interface Route {
  render: Render;
  /** Full-bleed screens (title) skip the HQ chrome. */
  bare?: boolean;
}

const routes = new Map<ScreenId, Route>();
let current: { id: ScreenId; arg: unknown } | null = null;
let frame: ((id: ScreenId, body: HTMLElement) => HTMLElement) | null = null;

export function register(id: ScreenId, render: Render, bare = false): void {
  routes.set(id, { render, bare });
}

export function setFrame(f: (id: ScreenId, body: HTMLElement) => HTMLElement): void {
  frame = f;
}

const root = () => document.querySelector<HTMLElement>("#screen")!;

export function go(id: ScreenId, arg?: unknown, click = true): void {
  if (click) sfx("ui_click");
  current = { id, arg };
  draw(false);
}

/** Re-render the current screen in place (after a state change), keeping scroll. */
export function rerender(): void {
  if (current && !root().hidden) draw(true);
}

export const currentScreen = () => current?.id ?? null;

function draw(keepScroll: boolean): void {
  const r = routes.get(current!.id)!;
  const el = root();
  const prevMain = el.querySelector<HTMLElement>(".hq-main");
  const scroll = keepScroll && prevMain ? prevMain.scrollTop : 0;
  const main = document.createElement("main");
  main.className = `hq-main screen-${current!.id}`;
  r.render(main, current!.arg);
  el.replaceChildren(r.bare || !frame ? main : frame(current!.id, main));
  el.hidden = false;
  main.scrollTop = scroll;
}

export function hideScreens(): void {
  root().hidden = true;
  root().replaceChildren();
  current = null;
}
