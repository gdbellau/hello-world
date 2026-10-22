// Procedural pixel-art character sprites.
//
// Every character is painted into a small colour grid (28×34 art pixels) by a
// paper-doll painter: legs, torso, head, arms and gear are layered per class,
// per facing view and per animation frame, then a 1px outline is traced around
// the silhouette. Five views are painted (S, SE, E, NE, N); the other three
// directions are mirrors. Results are cached lazily as offscreen canvases.
//
// Reusable from other modules (e.g. render-objects.ts) via `drawCharacter`.

import { ART, blurGlow, ctx2d, makeCanvas, type Canvas2D } from "./canvas";
import { characterPalette, hexToRgb, resolveArchetype, resolveSkin, rgbToHex, type Archetype, type CharPalette } from "./palette";

export const SPR_W = 28;
export const SPR_H = 34;
/** Anchor (feet centre) inside the sprite, in art pixels. */
export const ANCHOR_X = 14;
export const ANCHOR_Y = 32;

export type Pose = "idle" | "walk" | "aim" | "dead";

export const WALK_FRAMES = 4;
export const IDLE_FRAMES = 2;

// ---------------------------------------------------------------------------
// Pixel grid

class Grid {
  readonly c: (string | null)[];
  readonly em: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.c = new Array<string | null>(w * h).fill(null);
    this.em = new Uint8Array(w * h);
  }
  set(x: number, y: number, col: string, emit = false): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.c[i] = col;
    this.em[i] = emit ? 1 : 0;
  }
  clear(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.c[y * this.w + x] = null;
  }
  get(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.c[y * this.w + x] ?? null;
  }
  rect(x: number, y: number, w: number, h: number, col: string, emit = false): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, col, emit);
  }
  line(x0: number, y0: number, x1: number, y1: number, col: string, emit = false): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) this.set(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, col, emit);
  }
  /** Top-left rim light: brighten filled pixels whose left or upper neighbour is empty. */
  rim(): void {
    const hits: number[] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (!this.c[i] || this.em[i]) continue;
        if (!this.get(x - 1, y) || !this.get(x, y - 1)) hits.push(i);
      }
    for (const i of hits) {
      const [r, g, b] = hexToRgb(this.c[i]!);
      this.c[i] = rgbToHex([r * 1.2 + 38, g * 1.2 + 34, b * 1.2 + 52]);
    }
  }
  /** Trace a 1px outline around every filled pixel. */
  outline(col: string): void {
    const add: number[] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push(y * this.w + x);
      }
    for (const i of add) {
      this.c[i] = col;
      this.em[i] = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Painter

interface Spec {
  tw: number; // torso width
  lw: number; // leg width
  hw: number; // head width
}

const SPEC: Record<Archetype, Spec> = {
  ghost: { tw: 7, lw: 3, hw: 7 },
  razor: { tw: 7, lw: 3, hw: 6 },
  decker: { tw: 7, lw: 3, hw: 6 },
  bruiser: { tw: 10, lw: 4, hw: 6 },
  guard: { tw: 8, lw: 3, hw: 6 },
  target: { tw: 8, lw: 3, hw: 6 },
  civilian: { tw: 7, lw: 3, hw: 6 },
};

type WeaponKind = "pistol" | "silenced" | "smg" | "rifle" | "heavy" | "blade" | "tablet" | "none";

const WEAPON: Record<Archetype, WeaponKind> = {
  ghost: "silenced",
  razor: "blade",
  decker: "smg",
  bruiser: "heavy",
  guard: "rifle",
  target: "tablet",
  civilian: "none",
};

const DARK = "#0b0a14";

interface P {
  g: Grid;
  p: CharPalette;
  arch: Archetype;
  skin: string;
  v: number; // 0 S, 1 SE, 2 E, 3 NE, 4 N
  pose: Pose;
  f: number;
}

/** Paints a standing character. Returns the muzzle point (art px, unmirrored). */
function paintStanding(P: P): { mx: number; my: number } {
  const { g, p, arch, v, pose, f } = P;
  const spec = SPEC[arch];
  const side = v === 2;
  const q = v === 1 || v === 3;
  const backV = v >= 3;
  const walk = pose === "walk";
  const aim = pose === "aim";
  const b = walk ? (f % 2 === 0 ? 1 : 0) : pose === "idle" && f === 1 ? 1 : 0;
  const tw = side ? Math.max(5, spec.tw - 3) : q ? spec.tw - 1 : spec.tw;
  const x0 = ANCHOR_X - Math.floor(tw / 2);
  const ty = 15 + b;
  const cx = ANCHOR_X;
  const wk = WEAPON[arch];
  let muzzle = { mx: cx, my: ty + 3 };

  // ---- behind the body -----------------------------------------------------
  if (!backV) backGear(P, x0, tw, ty);
  if (aim && v >= 3) muzzle = aimWeapon(P, x0, tw, ty, wk);
  if (!aim && v === 4 && wk !== "none" && wk !== "tablet") idleWeapon(P, x0, tw, ty, wk, b);

  // ---- legs ----------------------------------------------------------------
  legs(P, x0, tw, spec.lw);

  // ---- torso ---------------------------------------------------------------
  torso(P, x0, tw, ty);

  if (backV) backGear(P, x0, tw, ty);

  // ---- head ----------------------------------------------------------------
  head(P, ty - 6);

  // ---- arms & weapons ------------------------------------------------------
  if (aim) {
    if (v < 3) muzzle = aimWeapon(P, x0, tw, ty, wk);
    else aimArms(P, x0, tw, ty);
  } else {
    arms(P, x0, tw, ty);
    if (v !== 4 && wk !== "none") muzzle = idleWeapon(P, x0, tw, ty, wk, b);
  }
  return muzzle;
}

function sleeve(P: P, x: number, y: number, far = false): void {
  const { p, g } = P;
  if (p.bareArms) {
    const tat = p.tattoo && (x * 3 + y * 5) % 4 === 0;
    g.set(x, y, tat ? p.tattoo! : far ? p.skinShade : p.skin);
  } else g.set(x, y, far ? p.mainShade : p.main);
}

function legs(P: P, x0: number, tw: number, lw: number): void {
  const { g, p, v, pose, f, arch } = P;
  const walk = pose === "walk";
  const cloak = arch === "ghost";
  if (v === 2) {
    // Profile: near and far leg swing in opposite directions.
    const near = walk ? [3, 0, -3, 0][f]! : pose === "aim" ? 2 : 1;
    const far = walk ? [-3, 0, 3, 0][f]! : pose === "aim" ? -2 : -1;
    const liftN = walk && f === 3 ? 1 : 0;
    const liftF = walk && f === 1 ? 1 : 0;
    const hx = ANCHOR_X - Math.floor(lw / 2);
    leg(g, hx, far, liftF, lw, p.secondShade, p.secondShade, shadeHex(p.boots, 0.7), cloak);
    leg(g, hx, near, liftN, lw, p.second, p.secondShade, p.boots, cloak);
    return;
  }
  const liftL = walk ? [0, 2, 0, 0][f]! : 0;
  const liftR = walk ? [0, 0, 0, 2][f]! : 0;
  const q = v === 1 || v === 3;
  const shiftL = q && liftL ? 1 : 0;
  const shiftR = q && liftR ? 1 : 0;
  const cx = ANCHOR_X;
  const lx = cx - lw - (lw > 3 ? 0 : 0);
  const rx = cx;
  const top = 23;
  const draw = (x: number, lift: number, shade: boolean) => {
    const bottom = 29 - lift;
    for (let y = top; y <= bottom; y++) {
      if (cloak && y < 28) continue;
      for (let i = 0; i < lw; i++) g.set(x + i, y, i === lw - 1 || shade ? p.secondShade : p.second);
    }
    // Boot.
    g.rect(x, bottom + 1, lw, 2, p.boots);
    g.set(x + lw - 1, bottom + 2, shadeHex(p.boots, 0.7));
    if (P.arch === "bruiser" || P.arch === "guard") g.set(x, bottom - 2, p.armorShade); // knee pad
  };
  draw(lx + shiftL, liftL, false);
  draw(rx + shiftR, liftR, true);
  void x0;
  void tw;
}

function leg(g: Grid, hx: number, off: number, lift: number, lw: number, col: string, shadeCol: string, boot: string, cloak: boolean): void {
  const top = 23;
  const bottom = 29 - lift;
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / (bottom - top || 1);
    const x = hx + Math.round(off * t);
    if (cloak && y < 28) continue;
    for (let i = 0; i < lw; i++) g.set(x + i, y, i === lw - 1 ? shadeCol : col);
  }
  const bx = hx + off;
  g.rect(bx, bottom + 1, lw + 1, 2, boot);
}

function torso(P: P, x0: number, tw: number, ty: number): void {
  const { g, p, v, arch, pose, f } = P;
  const side = v === 2;
  const backV = v >= 3;
  for (let y = ty; y < ty + 8; y++) {
    for (let x = x0; x < x0 + tw; x++) {
      let col = p.main;
      if (side ? x === x0 : x >= x0 + tw - (v === 1 ? 2 : 1)) col = p.mainShade;
      if (y === ty) col = p.mainLight;
      g.set(x, y, col);
    }
  }
  // Belt.
  g.rect(x0, ty + 6, tw, 1, arch === "target" ? p.mainShade : p.secondShade);

  switch (arch) {
    case "ghost": {
      // Long cloak flaring to the ankles, with a neon hem.
      const sway = pose === "walk" ? [1, 0, -1, 0][f]! : 0;
      for (let y = ty + 7; y <= 28; y++) {
        const extra = Math.min(3, Math.floor((y - ty - 6) / 2));
        const w = tw + extra;
        const xs = ANCHOR_X - Math.floor(w / 2) + (y > 25 ? sway : 0) + (side ? -1 : 0);
        for (let x = xs; x < xs + w; x++) g.set(x, y, x >= xs + w - 2 && !side ? p.mainShade : x === xs && side ? p.mainShade : p.main);
        if (y === 28) for (let x = xs; x < xs + w; x++) g.set(x, y, p.accent, true);
      }
      if (!backV && !side) g.line(ANCHOR_X - 1 + (v === 1 ? 1 : 0), ty + 2, ANCHOR_X - 1 + (v === 1 ? 1 : 0), 27, p.mainShade);
      if (backV) g.line(ANCHOR_X - 1, ty + 1, ANCHOR_X - 1, 26, p.mainShade);
      break;
    }
    case "razor": {
      if (!backV && !side) {
        g.line(x0 + 1, ty + 1, x0 + tw - 2, ty + 5, p.accent, true);
        g.set(x0, ty, p.mainLight);
        g.set(x0 + tw - 1, ty, p.mainLight);
      }
      // Coat tails.
      const tail = side ? [x0 - 1] : [x0, x0 + tw - 1];
      for (const x of tail) g.rect(x, ty + 7, 1, 3, p.mainShade);
      if (side) g.set(x0 + 2, ty + 2, p.accent, true);
      break;
    }
    case "decker": {
      if (!backV && !side) {
        g.rect(x0 + 1, ty, 1, 6, p.armorShade);
        g.rect(x0 + tw - 2, ty, 1, 6, p.armorShade);
        g.set(x0 + 1, ty + 2, p.accent, true);
      }
      if (!backV) g.rect(x0 + 2, ty + 4, tw - 4, 1, p.mainShade);
      break;
    }
    case "bruiser": {
      if (!backV) {
        g.rect(x0 + 1, ty + 1, tw - 2, 4, p.armor);
        g.rect(x0 + 1, ty + 4, tw - 2, 1, p.armorShade);
        if (!side) g.rect(ANCHOR_X - 1, ty + 2, 2, 1, p.accent, true);
      } else g.rect(x0 + 1, ty + 1, tw - 2, 4, p.armorShade);
      // Pauldrons.
      if (!side) {
        g.rect(x0 - 2, ty - 1, 3, 3, p.armor);
        g.rect(x0 + tw - 1, ty - 1, 3, 3, p.armorShade);
        g.set(x0 - 2, ty, p.accent, true);
        g.set(x0 + tw + 1, ty, p.accent, true);
      } else {
        g.rect(x0, ty - 1, 4, 3, p.armor);
        g.set(x0 + 1, ty, p.accent, true);
      }
      break;
    }
    case "guard": {
      if (!backV) {
        g.rect(x0 + 1, ty + 1, tw - 2 - (side ? 0 : 1), 4, p.armor);
        g.rect(x0 + 1, ty + 4, tw - 2 - (side ? 0 : 1), 1, p.armorShade);
        if (!side) g.set(x0 + 2, ty + 2, p.accent, true);
      } else {
        g.rect(x0 + 1, ty + 1, tw - 2, 4, p.armorShade);
        g.set(ANCHOR_X - 1, ty + 2, p.accent, true);
      }
      if (!side) {
        g.rect(x0 - 1, ty, 2, 2, p.armor);
        g.rect(x0 + tw - 1, ty, 2, 2, p.armorShade);
      }
      break;
    }
    case "target":
    case "civilian":
      break;
  }
  // Shirt and tie (VIP, exec and yakuza suits).
  if (!backV && (p.tie || arch === "target")) {
    const tcx = side ? x0 + tw - 2 : ANCHOR_X - 1 + (v === 1 ? 1 : 0);
    if (!side) {
      g.rect(tcx - 1, ty, 4, 1, p.shirt);
      g.rect(tcx, ty + 1, 2, 2, p.shirt);
    } else g.rect(tcx, ty, 2, 2, p.shirt);
    if (p.tie) {
      g.set(tcx + (side ? 1 : 0), ty + 1, p.tie, arch === "target");
      g.rect(tcx + (side ? 1 : 0), ty + 2, side ? 1 : 2, 3, p.tie, arch === "target");
    }
  }
  // Katana worn across the back.
  if (p.katana) {
    if (backV) g.line(x0 + tw, ty - 3, x0, ty + 7, p.metal), g.line(x0 + tw, ty - 3, x0 + tw - 2, ty + 0, p.accent, true);
    else if (side) g.line(x0 - 2, ty - 2, x0 - 1, ty + 8, p.metalShade);
  }
}

function head(P: P, hy: number): void {
  const { g, p, v, arch, skin } = P;
  const spec = SPEC[arch];
  const side = v === 2;
  const q = v === 1 || v === 3;
  const backV = v >= 3;
  const hw = side ? 5 : spec.hw;
  const hx = ANCHOR_X - Math.floor(hw / 2) + (q ? 1 : 0) - (side ? 0 : 0);
  const r = hx + hw - 1;

  if (arch === "ghost") {
    // Hood.
    for (let y = hy - 1; y <= hy + 5; y++)
      for (let x = hx; x <= r; x++) {
        if (y === hy - 1 && (x === hx || x === r)) continue;
        g.set(x, y, (side ? x === hx : x === r) ? p.mainShade : y === hy - 1 ? p.mainLight : p.main);
      }
    g.rect(ANCHOR_X - 1 + (q ? 1 : 0) - (side ? 1 : 0), hy - 2, 2, 1, p.main);
    if (!backV) {
      const ox = side ? r - 2 : hx + 1 + (q ? 1 : 0);
      const ow = side ? 3 : hw - 2 - (q ? 1 : 0);
      g.rect(ox, hy + 2, ow, 3, DARK);
      g.rect(ox + (side ? 1 : 1), hy + 3, side ? 2 : ow - 2, 1, p.visor, true);
    } else g.line(ANCHOR_X - 1, hy, ANCHOR_X - 1, hy + 5, p.mainShade);
    crest(P, hx, hw, hy);
    return;
  }

  // Skin base with shading on the right.
  for (let y = hy; y <= hy + 5; y++) for (let x = hx; x <= r; x++) g.set(x, y, !side && x === r ? p.skinShade : p.skin);
  const helmet = arch === "guard" || arch === "bruiser";

  if (helmet) {
    const top = arch === "guard" ? hy - 1 : hy;
    for (let y = top; y <= hy + 2; y++)
      for (let x = hx; x <= r; x++) {
        if (y === top && (x === hx || x === r)) continue;
        g.set(x, y, x === r || (side && x === hx) ? p.armorShade : y === top ? shadeHex(p.armor, 1.25) : p.armor);
      }
    if (backV) {
      g.rect(hx, hy + 3, hw, 1, p.armorShade);
      if (v === 4) g.set(ANCHOR_X - 1, hy + 1, p.visor, true);
      else g.set(r, hy + 3, p.visor, true);
    } else if (side) {
      g.rect(hx, hy + 3, 2, 1, p.armorShade);
      g.rect(r - 2, hy + 3, 3, 1, p.visor, true);
      g.set(r + 1, hy + 3, p.visor, true);
    } else {
      g.rect(hx, hy + 3, hw, 1, p.visor, true);
      if (v === 1) g.set(hx, hy + 3, p.armorShade);
    }
    if (arch === "bruiser" && !backV) g.rect(hx + (side ? 2 : 1), hy + 5, side ? 3 : hw - 2, 1, p.skinShade);
    if (backV) g.rect(hx, hy + 4, hw, 1, p.armorShade);
    crest(P, hx, hw, hy);
    return;
  }

  // Hair.
  const hair = p.hair;
  if (arch === "razor") {
    // Shaved sides, neon mohawk.
    for (let y = hy; y <= hy + 1; y++) for (let x = hx; x <= r; x++) g.set(x, y, p.skinShade);
    const mx = side ? hx + 1 : ANCHOR_X - 1 + (q ? 1 : 0);
    const mw = side ? 4 : 2;
    g.rect(mx, hy - 2, mw, 3, hair);
    g.set(mx + (side ? 0 : 0), hy - 3, hair);
    if (side) g.set(mx + 2, hy - 3, hair);
  } else {
    g.rect(hx, hy, hw, 2, hair);
    if (arch === "decker") {
      g.set(hx + 1, hy - 1, hair);
      g.set(hx + 3, hy - 1, hair);
      g.set(r, hy - 1, hair);
    }
    if (arch === "target" || p.tie) g.set(hx + 1, hy + 1, shadeHex(hair, 1.6)); // slick shine
  }
  if (backV) {
    for (let y = hy; y <= hy + 4; y++) for (let x = hx; x <= r; x++) if (!(v === 3 && x === r && y >= hy + 2)) g.set(x, y, arch === "razor" && y > hy + 1 ? p.skinShade : hair);
    if (arch === "razor") g.rect(ANCHOR_X - 1, hy - 2, 2, 6, hair);
  } else if (side) {
    g.rect(hx, hy, 2, 4, arch === "razor" ? p.skinShade : hair);
    g.set(r + 1, hy + 3, p.skin); // nose
  } else if (v === 1) {
    g.rect(hx, hy + 2, 1, 2, arch === "razor" ? p.skinShade : hair);
  } else {
    g.set(hx, hy + 2, hair);
    g.set(r, hy + 2, hair);
  }

  // Eyes / visor / goggles.
  if (!backV) {
    const ey = hy + 3;
    if (arch === "razor") {
      if (side) g.rect(r - 2, ey, 3, 1, p.visor, true);
      else g.rect(hx + 1 + (v === 1 ? 1 : 0), ey, hw - 2, 1, p.visor, true);
    } else if (arch === "decker") {
      if (side) {
        g.rect(hx, ey, 2, 1, p.armorShade);
        g.rect(r - 1, ey, 2, 1, p.visor, true);
      } else {
        const a = hx + (v === 1 ? 1 : 0);
        g.rect(a, ey, 2, 1, p.visor, true);
        g.rect(a + 3, ey, 2, 1, p.visor, true);
        g.set(a + 2, ey, p.armorShade);
      }
    } else if (arch === "target") {
      if (side) g.rect(r - 1, ey, 2, 1, p.visor, true);
      else {
        const a = hx + (v === 1 ? 1 : 0);
        g.rect(a, ey, 2, 1, p.visor, true);
        g.rect(a + 3, ey, 2, 1, p.visor, true);
        g.set(a + 2, ey, p.metalShade);
      }
    } else {
      // Plain eyes; agents with a skin visor colour get cyber-eyes.
      const glow = arch !== "civilian";
      if (side) g.set(r - 1, ey, glow ? p.visor : DARK, glow);
      else {
        const a = hx + 1 + (v === 1 ? 1 : 0);
        g.set(a, ey, glow ? p.visor : DARK, glow);
        g.set(a + 3 - (v === 1 ? 1 : 0), ey, glow ? p.visor : DARK, glow);
      }
    }
    if (!side) g.set(hx + Math.floor(hw / 2) + (v === 1 ? 1 : 0), hy + 5, p.skinShade); // mouth shadow
  }
  crest(P, hx, hw, hy);
  void skin;
}

function crest(P: P, hx: number, hw: number, hy: number): void {
  const { g, p, v, skin } = P;
  if (!p.crest) return;
  const top = P.arch === "guard" || P.arch === "ghost" ? hy - 2 : hy - 1;
  const cx = hx + Math.floor(hw / 2);
  if (skin === "founder") {
    // Little crown of light.
    g.rect(cx - 2, top, 5, 1, p.crest, true);
    g.set(cx - 2, top - 1, p.crest, true);
    g.set(cx, top - 2, p.crest, true);
    g.set(cx, top - 1, p.crest, true);
    g.set(cx + 2, top - 1, p.crest, true);
    return;
  }
  // Kuwagata horns.
  if (v === 2) {
    g.line(hx + hw - 2, top, hx + hw + 1, top - 3, p.crest, true);
  } else {
    g.line(cx - 1, top, cx - 3, top - 3, p.crest, true);
    g.line(cx, top, cx + 2, top - 3, p.crest, true);
    if (v < 3) g.set(cx - 1, top + 1, p.crest, true), g.set(cx, top + 1, p.crest, true);
  }
}

function backGear(P: P, x0: number, tw: number, ty: number): void {
  const { g, p, v, arch } = P;
  const backV = v >= 3;
  if (arch === "decker") {
    // Cyberdeck backpack + antenna.
    if (backV) {
      const bx = x0;
      g.rect(bx, ty, tw, 7, p.armor);
      g.rect(bx, ty + 6, tw, 1, p.armorShade);
      g.rect(bx + tw - 1, ty, 1, 7, p.armorShade);
      g.rect(bx + 1, ty + 1, tw - 3, 2, DARK);
      for (let i = 0; i < tw - 3; i += 2) g.set(bx + 1 + i, ty + 2, i % 4 ? p.visor : p.accent, true);
      g.line(bx + tw - 2, ty, bx + tw - 2, ty - 8, p.metalShade);
      g.set(bx + tw - 2, ty - 9, p.accent, true);
    } else if (v === 2) {
      g.rect(x0 - 4, ty, 4, 7, p.armor);
      g.rect(x0 - 4, ty + 6, 4, 1, p.armorShade);
      g.set(x0 - 3, ty + 2, p.accent, true);
      g.set(x0 - 3, ty + 4, p.visor, true);
      g.line(x0 - 3, ty, x0 - 3, ty - 8, p.metalShade);
      g.set(x0 - 3, ty - 9, p.accent, true);
    } else {
      g.rect(x0 - 1, ty + 1, tw + 2, 6, p.armorShade);
      const ax = v === 1 ? x0 : x0 + tw;
      g.line(ax, ty, ax, ty - 8, p.metalShade);
      g.set(ax, ty - 9, p.accent, true);
    }
  }
  if (p.katana && !backV && v !== 2) {
    // Hilt over the shoulder.
    g.line(x0 - 1, ty - 4, x0, ty - 1, p.armorShade);
    g.set(x0 - 1, ty - 4, p.accent, true);
  }
}

function arms(P: P, x0: number, tw: number, ty: number): void {
  const { g, p, v, pose, f, arch } = P;
  const glove = arch === "guard" || arch === "bruiser" ? p.boots : p.skin;
  if (v === 2) {
    const sw = pose === "walk" ? [-2, 0, 2, 0][f]! : 0;
    const sx = ANCHOR_X - 1;
    for (let y = ty; y < ty + 7; y++) {
      const t = (y - ty) / 6;
      const x = sx + Math.round(sw * t);
      sleeve(P, x, y);
      sleeve(P, x + 1, y, true);
    }
    g.rect(sx + sw, ty + 7, 2, 1, glove);
    if (arch === "razor") blade(P, sx + sw + 1, ty + 7, 2, 3);
    return;
  }
  const swing = pose === "walk" ? [0, 1, 0, -1][f]! : 0;
  const lx = x0 - 2;
  const rx = x0 + tw;
  const ll = 7 - Math.max(0, swing);
  const rl = 7 - Math.max(0, -swing);
  for (let y = 0; y < ll; y++) {
    sleeve(P, lx, ty + y);
    sleeve(P, lx + 1, ty + y);
  }
  for (let y = 0; y < rl; y++) {
    sleeve(P, rx, ty + y, true);
    sleeve(P, rx + 1, ty + y, true);
  }
  g.rect(lx, ty + ll, 2, 1, glove);
  g.rect(rx, ty + rl, 2, 1, glove);
  if (arch === "razor") {
    blade(P, lx, ty + ll, -1, 5);
    blade(P, rx + 1, ty + rl, 1, 5);
  }
}

function blade(P: P, x: number, y: number, dx: number, len: number): void {
  const { g, p } = P;
  for (let i = 1; i <= len; i++) {
    const bx = x + Math.round((dx * i) / len);
    g.set(bx, y + i, p.blade);
    g.set(bx + (dx >= 0 ? 1 : -1), y + i - 1, p.accent, true);
  }
}

function idleWeapon(P: P, x0: number, tw: number, ty: number, wk: WeaponKind, b: number): { mx: number; my: number } {
  const { g, p, v } = P;
  const hand = v === 2 ? { x: ANCHOR_X, y: ty + 7 } : { x: x0 + tw + 1, y: ty + 7 };
  void b;
  switch (wk) {
    case "silenced":
    case "pistol": {
      const len = wk === "silenced" ? 5 : 3;
      const dx = v === 2 ? 1 : v === 4 ? 0 : 1;
      const dy = v === 2 ? 0 : 1;
      for (let i = 0; i < len; i++) g.set(hand.x + dx * Math.ceil(i / 2) + (v === 2 ? i : 0) - (v === 2 ? Math.ceil(i / 2) : 0), hand.y + dy * i, i >= 3 ? p.metalShade : p.metal);
      g.set(hand.x - (v === 2 ? 0 : 1), hand.y + 1, p.metalShade);
      return { mx: hand.x + (v === 2 ? len : 2), my: hand.y + (v === 2 ? 0 : len) };
    }
    case "smg": {
      if (v === 2) {
        g.rect(hand.x - 1, hand.y - 2, 6, 2, p.metal);
        g.set(hand.x + 1, hand.y, p.metalShade);
        g.set(hand.x + 5, hand.y - 2, p.metalShade);
        return { mx: hand.x + 6, my: hand.y - 2 };
      }
      g.rect(hand.x - 1, hand.y - 3, 2, 5, p.metal);
      g.rect(hand.x + 1, hand.y - 1, 1, 2, p.metalShade);
      return { mx: hand.x, my: hand.y + 2 };
    }
    case "rifle": {
      // Port arms: diagonally across the chest.
      if (v === 2) {
        g.line(hand.x - 3, hand.y - 1, hand.x + 6, hand.y - 3, p.metal);
        g.line(hand.x - 3, hand.y, hand.x + 2, hand.y - 1, p.metalShade);
        g.set(hand.x + 6, hand.y - 3, p.accent, true);
        return { mx: hand.x + 7, my: hand.y - 3 };
      }
      g.line(x0 - 1, ty + 7, x0 + tw + 2, ty + 1, p.metal);
      g.line(x0, ty + 7, x0 + tw + 1, ty + 2, p.metalShade);
      g.set(x0 + tw + 2, ty, p.accent, true);
      return { mx: x0 + tw + 3, my: ty };
    }
    case "heavy": {
      if (v === 2) {
        g.rect(hand.x - 3, hand.y - 3, 9, 3, p.metal);
        g.rect(hand.x - 3, hand.y - 1, 9, 1, p.metalShade);
        g.rect(hand.x + 6, hand.y - 3, 2, 2, p.metalShade);
        g.set(hand.x - 1, hand.y - 2, p.accent, true);
        return { mx: hand.x + 8, my: hand.y - 3 };
      }
      const y = ty + 5;
      g.rect(x0 - 2, y, tw + 6, 3, p.metal);
      g.rect(x0 - 2, y + 2, tw + 6, 1, p.metalShade);
      g.rect(x0 + tw + 4, y, 2, 2, p.metalShade);
      g.set(x0 + 1, y + 1, p.accent, true);
      return { mx: x0 + tw + 6, my: y };
    }
    case "tablet": {
      if (v === 2) {
        g.rect(hand.x, hand.y - 3, 3, 1, p.metalShade);
        g.rect(hand.x, hand.y - 4, 3, 1, p.accent, true);
      } else {
        g.rect(hand.x - 2, hand.y - 3, 3, 3, p.metalShade);
        g.rect(hand.x - 2, hand.y - 3, 3, 2, p.accent, true);
      }
      return { mx: hand.x, my: hand.y - 3 };
    }
    case "blade":
    case "none":
      return { mx: hand.x, my: hand.y };
  }
}

/** Arms raised for back-facing aims (body hides most of the gun). */
function aimArms(P: P, x0: number, tw: number, ty: number): void {
  const { g, p, v } = P;
  if (v === 4) {
    g.rect(x0 - 1, ty, 2, 3, p.mainShade);
    g.rect(x0 + tw - 1, ty, 2, 3, p.mainShade);
  } else {
    g.line(x0 + tw - 1, ty + 1, x0 + tw + 2, ty - 1, p.main);
    g.line(x0 + tw - 1, ty + 2, x0 + tw + 2, ty, p.mainShade);
    g.rect(x0 - 1, ty, 2, 4, p.mainShade);
  }
}

function aimWeapon(P: P, x0: number, tw: number, ty: number, wk: WeaponKind): { mx: number; my: number } {
  const { g, p, v, arch } = P;
  const glove = arch === "guard" || arch === "bruiser" ? p.boots : p.skin;
  const len = wk === "heavy" ? 9 : wk === "rifle" ? 8 : wk === "smg" ? 6 : wk === "silenced" ? 6 : wk === "blade" ? 6 : 4;
  const thick = wk === "heavy" ? 3 : wk === "rifle" || wk === "smg" ? 2 : 1;
  const metal = wk === "blade" ? p.blade : p.metal;
  const drawGun = (hx: number, hy: number, dx: number, dy: number) => {
    // dx,dy in {-1,0,1}; slope 2:1 rendered as two pixels per step.
    let x = hx;
    let y = hy;
    for (let i = 0; i < len; i++) {
      for (let t = 0; t < thick; t++) g.set(x, y + t, t === thick - 1 && thick > 1 ? p.metalShade : metal, wk === "blade" && t === 0);
      x += dx;
      if (dy && i % 2 === 1) y += dy;
    }
    if (wk === "blade") g.line(hx, hy - 1, x - dx, y - 1, p.accent, true);
    return { mx: x, my: y };
  };
  switch (v) {
    case 0: {
      // Facing the viewer: arms come together, muzzle points at camera.
      g.rect(x0 - 1, ty, 2, 4, p.main);
      g.rect(x0 + tw - 1, ty, 2, 4, p.mainShade);
      g.line(x0, ty + 4, ANCHOR_X - 1, ty + 5, p.main);
      g.line(x0 + tw - 1, ty + 4, ANCHOR_X, ty + 5, p.mainShade);
      const s = thick + 1;
      g.rect(ANCHOR_X - 1, ty + 3, s, s, p.metal);
      g.set(ANCHOR_X - 1, ty + 3, DARK);
      g.rect(ANCHOR_X - 1, ty + 5, 2, 1, glove);
      if (wk === "blade") g.line(ANCHOR_X, ty + 3, ANCHOR_X + 1, ty + 8, p.blade), g.set(ANCHOR_X + 2, ty + 8, p.accent, true);
      return { mx: ANCHOR_X - 1, my: ty + 3 };
    }
    case 1: {
      g.line(x0, ty + 1, x0 + tw + 1, ty + 5, p.mainShade);
      g.line(x0 + tw - 1, ty + 1, x0 + tw + 2, ty + 4, p.main);
      g.rect(x0 + tw + 2, ty + 4, 2, 1, glove);
      return drawGun(x0 + tw + 3, ty + 3, 1, 1);
    }
    case 2: {
      for (let x = ANCHOR_X - 1; x <= ANCHOR_X + 4; x++) {
        sleeve(P, x, ty + 2);
        sleeve(P, x, ty + 3, true);
      }
      g.rect(ANCHOR_X + 4, ty + 2, 1, 2, glove);
      return drawGun(ANCHOR_X + 4, ty + 1, 1, 0);
    }
    case 3: {
      // Gun points away up-right; drawn behind the body.
      return drawGun(x0 + tw + 2, ty - 1, 1, -1);
    }
    default: {
      g.rect(x0 + tw - 2, ty - 4, 2, 4, p.metalShade);
      return { mx: x0 + tw - 1, my: ty - 5 };
    }
  }
}

/** Body lying on the floor. */
function paintDead(P: P): void {
  const { g, p, arch } = P;
  const y0 = 25;
  // Legs (left), torso, head (right).
  g.rect(3, y0 + 2, 2, 3, p.boots);
  g.rect(5, y0 + 1, 6, 2, p.second);
  g.rect(5, y0 + 3, 6, 2, p.secondShade);
  g.rect(11, y0, 8, 5, p.main);
  g.rect(11, y0 + 4, 8, 1, p.mainShade);
  if (arch === "ghost") g.rect(8, y0 + 1, 4, 4, p.main);
  if (arch === "guard" || arch === "bruiser") g.rect(12, y0 + 1, 5, 2, p.armor);
  if (arch === "target" && p.tie) g.rect(13, y0 + 1, 4, 1, p.tie);
  // Arm flung out.
  g.rect(13, y0 - 2, 2, 2, p.bareArms ? p.skin : p.mainShade);
  g.rect(14, y0 - 3, 2, 1, p.skin);
  const helmet = arch === "guard" || arch === "bruiser";
  g.rect(19, y0, 5, 5, helmet ? p.armor : arch === "ghost" ? p.main : p.skin);
  if (!helmet && arch !== "ghost") g.rect(19, y0, 2, 5, p.hair);
  if (helmet) g.rect(22, y0 + 1, 1, 3, shadeHex(p.visor, 0.35));
}

// ---------------------------------------------------------------------------
// Cache + public API

export interface SpriteFrame {
  /** Full-colour sprite (art px). */
  base: Canvas2D;
  /** Pre-blurred additive glow of the emissive pixels, or null. */
  glow: Canvas2D | null;
  /** Muzzle point, art px relative to sprite origin (already mirrored). */
  mx: number;
  my: number;
}

const cache = new Map<string, SpriteFrame>();
const LIGHT_LEVELS = [0.5, 0.66, 0.83, 1];

function shadeHex(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * f, g * f, b * f]);
}

/** Screen-space 8-way direction (0 = E, 1 = SE, 2 = S … 7 = NE) for a world-space facing angle. */
export function dir8FromFacing(facing: number): number {
  const wx = Math.cos(facing);
  const wy = Math.sin(facing);
  const sx = wx - wy;
  const sy = (wx + wy) / 2;
  const a = Math.atan2(sy, sx);
  return (((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8) | 0;
}

// dir8 -> [view, mirrored]
const DIR_VIEW: [number, boolean][] = [
  [2, false], // E
  [1, false], // SE
  [0, false], // S
  [1, true], // SW
  [2, true], // W
  [3, true], // NW
  [4, false], // N
  [3, false], // NE
];

/**
 * Returns a cached sprite frame. `light` 0-3 darkens non-emissive pixels for
 * units standing in shadow (3 = fully lit).
 */
export function characterSprite(arch: string, skin: string | undefined, dir8: number, pose: Pose, frame: number, light = 3): SpriteFrame {
  const a = resolveArchetype(arch);
  const s = resolveSkin(skin);
  const [view, mirror] = DIR_VIEW[((dir8 % 8) + 8) % 8]!;
  const fr = pose === "walk" ? frame % WALK_FRAMES : pose === "idle" ? frame % IDLE_FRAMES : 0;
  const lv = Math.max(0, Math.min(3, light | 0));
  const deadMirror = pose === "dead" ? dir8 % 2 === 1 : mirror;
  const key = `${a}|${s}|${pose === "dead" ? 0 : view}|${deadMirror ? 1 : 0}|${pose}|${fr}|${lv}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const g = new Grid(SPR_W, SPR_H);
  const p = characterPalette(a, s);
  const P: P = { g, p, arch: a, skin: s, v: view, pose, f: fr };
  let m = { mx: ANCHOR_X, my: 20 };
  if (pose === "dead") paintDead(P);
  else m = paintStanding(P);
  g.rim();
  g.outline(p.outline);

  const f = LIGHT_LEVELS[lv]!;
  const base = makeCanvas(SPR_W, SPR_H);
  const bc = ctx2d(base);
  const img = bc.createImageData(SPR_W, SPR_H);
  const em = makeCanvas(SPR_W, SPR_H);
  const ec = ctx2d(em);
  const eimg = ec.createImageData(SPR_W, SPR_H);
  let anyEmit = false;
  for (let y = 0; y < SPR_H; y++)
    for (let x = 0; x < SPR_W; x++) {
      const sx = deadMirror ? SPR_W - 1 - x : x;
      const col = g.c[y * SPR_W + sx];
      if (!col) continue;
      const emit = g.em[y * SPR_W + sx] === 1;
      const [r, gg, bb] = hexToRgb(col);
      const k = emit ? 1 : f;
      const o = (y * SPR_W + x) * 4;
      img.data[o] = r * k;
      img.data[o + 1] = gg * k;
      img.data[o + 2] = bb * k;
      img.data[o + 3] = 255;
      if (emit && pose !== "dead") {
        anyEmit = true;
        eimg.data[o] = r;
        eimg.data[o + 1] = gg;
        eimg.data[o + 2] = bb;
        eimg.data[o + 3] = 255;
      }
    }
  bc.putImageData(img, 0, 0);
  ec.putImageData(eimg, 0, 0);
  const frameOut: SpriteFrame = {
    base,
    glow: anyEmit ? blurGlow(em) : null,
    mx: deadMirror ? SPR_W - 1 - m.mx : m.mx,
    my: m.my,
  };
  cache.set(key, frameOut);
  return frameOut;
}

export interface DrawCharacterOpts {
  arch: string;
  skin?: string;
  facing: number;
  pose: Pose;
  frame: number;
  /** 0-3, see characterSprite. */
  light?: number;
  alpha?: number;
  /** Additive glow strength for emissive pixels (0 disables). */
  glow?: number;
}

/**
 * Draws a character with its feet at (sx, sy) in the current transform (CSS px).
 * Returns the muzzle position in the same space.
 */
export function drawCharacter(ctx: CanvasRenderingContext2D, sx: number, sy: number, o: DrawCharacterOpts): { x: number; y: number } {
  const fr = characterSprite(o.arch, o.skin, dir8FromFacing(o.facing), o.pose, o.frame, o.light ?? 3);
  const x = Math.round(sx - ANCHOR_X * ART);
  const y = Math.round(sy - ANCHOR_Y * ART);
  const prevA = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  if (o.alpha !== undefined) ctx.globalAlpha = prevA * o.alpha;
  ctx.drawImage(fr.base, x, y, SPR_W * ART, SPR_H * ART);
  if (fr.glow && (o.glow ?? 0) > 0) {
    const pad = (fr.glow.width - SPR_W) / 2;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = prevA * (o.glow ?? 0) * (o.alpha ?? 1);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fr.glow, x - pad * ART, y - pad * ART, fr.glow.width * ART, fr.glow.height * ART);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = prevOp;
  }
  ctx.globalAlpha = prevA;
  return { x: x + (fr.mx + 0.5) * ART, y: y + (fr.my + 0.5) * ART };
}

/** Archetype used to draw an entity of the given kind/class. */
export function archetypeFor(kind: string, cls?: string): Archetype {
  if (kind === "agent") return resolveArchetype(cls);
  if (kind === "guard") return "guard";
  if (kind === "target") return "target";
  return resolveArchetype(kind);
}

/** Muzzle offset (css px, relative to the feet) of a character's aiming pose. */
export function muzzleOffset(arch: string, skin: string | undefined, facing: number): { x: number; y: number } {
  const fr = characterSprite(arch, skin, dir8FromFacing(facing), "aim", 0, 3);
  return { x: (fr.mx + 0.5 - ANCHOR_X) * ART, y: (fr.my + 0.5 - ANCHOR_Y) * ART };
}
