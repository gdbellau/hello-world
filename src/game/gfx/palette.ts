// Colour palettes for characters and skins. Pure: no DOM, safe in tests.

export const NEON = {
  magenta: "#ff2bd6",
  cyan: "#00f0ff",
  yellow: "#ffe14d",
  indigo: "#07061a",
  red: "#ff3b5c",
  green: "#39ff8c",
  orange: "#ff8a1f",
} as const;

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Multiply a colour's channels by f (f < 1 darkens, f > 1 brightens). */
export function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * f, g * f, b * f]);
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export interface CharPalette {
  outline: string;
  skin: string;
  skinShade: string;
  hair: string;
  /** Primary garment (jacket, cloak, suit). */
  main: string;
  mainShade: string;
  mainLight: string;
  /** Trousers / undersuit. */
  second: string;
  secondShade: string;
  /** Plates, helmets, backpack shells. */
  armor: string;
  armorShade: string;
  /** Weapons and gear. */
  metal: string;
  metalShade: string;
  boots: string;
  /** Emissive neon trim. */
  accent: string;
  /** Emissive eyes / visor / goggles. */
  visor: string;
  shirt: string;
  blade: string;
  tie?: string;
  /** Irezumi colour on bare arms. */
  tattoo?: string;
  /** Helmet crest / crown colour. */
  crest?: string;
  /** Movement afterimage colour. */
  trail?: string;
  bareArms?: boolean;
  katana?: boolean;
}

export type Archetype = "ghost" | "razor" | "decker" | "bruiser" | "guard" | "target" | "civilian";

export const ARCHETYPES: readonly Archetype[] = ["ghost", "razor", "decker", "bruiser", "guard", "target", "civilian"];

const BASE: CharPalette = {
  outline: "#07061a",
  skin: "#d39b7a",
  skinShade: "#a06a52",
  hair: "#15121c",
  main: "#2a2d4a",
  mainShade: "#1b1d33",
  mainLight: "#3d4266",
  second: "#1d1b2e",
  secondShade: "#121120",
  armor: "#3b4258",
  armorShade: "#262b3b",
  metal: "#5b6378",
  metalShade: "#2f3444",
  boots: "#14121e",
  accent: NEON.cyan,
  visor: NEON.cyan,
  shirt: "#d8d6ff",
  blade: "#e9e6ff",
};

const ROLE: Record<Archetype, Partial<CharPalette>> = {
  ghost: {
    main: "#2b2f50",
    mainShade: "#1a1c34",
    mainLight: "#424a78",
    accent: NEON.cyan,
    visor: NEON.cyan,
  },
  razor: {
    main: "#47183f",
    mainShade: "#2a0e28",
    mainLight: "#6e2762",
    second: "#1f1828",
    hair: NEON.magenta,
    accent: NEON.magenta,
    visor: NEON.magenta,
    skin: "#c08a6c",
    skinShade: "#8d5d48",
  },
  decker: {
    main: "#1b4250",
    mainShade: "#102931",
    mainLight: "#2b6577",
    second: "#2b2540",
    hair: "#7a4322",
    armor: "#3f4560",
    armorShade: "#272b3d",
    accent: NEON.yellow,
    visor: NEON.green,
    skin: "#8f6146",
    skinShade: "#68432f",
  },
  bruiser: {
    main: "#3e4558",
    mainShade: "#262b3a",
    mainLight: "#5d6680",
    armor: "#59627c",
    armorShade: "#353b4f",
    second: "#232633",
    accent: NEON.orange,
    visor: NEON.orange,
    metal: "#6c7489",
    skin: "#b07a5c",
  },
  guard: {
    main: "#1e2436",
    mainShade: "#141826",
    mainLight: "#323b56",
    armor: "#3d4762",
    armorShade: "#262d42",
    second: "#181c2a",
    accent: "#ff3b5c",
    visor: "#ff2040",
    metal: "#4a5064",
  },
  target: {
    main: "#e2ddcf",
    mainShade: "#aaa393",
    mainLight: "#fbf8ee",
    second: "#c9c3b3",
    secondShade: "#958f80",
    hair: "#2a1e18",
    accent: NEON.yellow,
    visor: NEON.yellow,
    shirt: "#20202a",
    tie: NEON.yellow,
    boots: "#3a2a1e",
  },
  civilian: {
    main: "#4b3f6b",
    mainShade: "#2f2747",
    mainLight: "#6a5a94",
    second: "#22202e",
    accent: "#9fdcff",
    visor: "#9fdcff",
  },
};

/** Skin overrides layered on top of the class palette. Unknown ids fall back to "default". */
export const SKINS: Record<string, Partial<CharPalette>> = {
  default: {},
  chrome: {
    main: "#c3ccd8",
    mainShade: "#7f8a9c",
    mainLight: "#f4f8fc",
    second: "#7a8494",
    secondShade: "#4f5868",
    armor: "#dfe6ee",
    armorShade: "#97a2b3",
    metal: "#e8edf3",
    metalShade: "#8a94a6",
    skin: "#d4dbe4",
    skinShade: "#98a3b3",
    hair: "#eef3f8",
    boots: "#5a6374",
    accent: NEON.cyan,
    visor: NEON.cyan,
  },
  yakuza: {
    main: "#141118",
    mainShade: "#09080b",
    mainLight: "#2c2632",
    second: "#141118",
    secondShade: "#09080b",
    armor: "#1f1a24",
    armorShade: "#100d13",
    hair: "#09090b",
    skin: "#d8a585",
    skinShade: "#a5715a",
    accent: "#ff1e3c",
    visor: "#ff1e3c",
    shirt: "#f2eee6",
    tie: "#d1102e",
    tattoo: "#c8102e",
    trail: "#ff1e3c",
    bareArms: true,
    katana: true,
    blade: "#ffd9de",
  },
  founder: {
    main: "#d9a520",
    mainShade: "#966b0c",
    mainLight: "#ffe27a",
    second: "#5c1652",
    secondShade: "#3a0c34",
    armor: "#ffcf3f",
    armorShade: "#a8780f",
    metal: "#ffd75e",
    metalShade: "#8f6410",
    boots: "#3a0c34",
    accent: NEON.magenta,
    visor: NEON.magenta,
    crest: "#ffe14d",
    trail: NEON.magenta,
  },
  exec: {
    main: "#1c2340",
    mainShade: "#111630",
    mainLight: "#33406c",
    second: "#1c2340",
    secondShade: "#111630",
    armor: "#2a3356",
    armorShade: "#171d36",
    shirt: "#f0f0f8",
    tie: "#ff3b5c",
    accent: NEON.yellow,
    visor: "#9fdcff",
    hair: "#3b2a20",
    boots: "#0d0b14",
  },
  samurai: {
    main: "#8e1222",
    mainShade: "#560a15",
    mainLight: "#c4283c",
    second: "#1d1418",
    secondShade: "#110c0e",
    armor: "#9c1426",
    armorShade: "#4c0811",
    metal: "#c9ccd6",
    accent: "#ffd24a",
    visor: "#ffd24a",
    crest: "#ffd24a",
    katana: true,
    trail: "#ffd24a",
  },
};

export const SKIN_IDS: readonly string[] = Object.keys(SKINS);

/** Normalises a skin id: anything unknown (or missing) becomes "default". */
export function resolveSkin(id: string | undefined | null): string {
  return id && Object.prototype.hasOwnProperty.call(SKINS, id) ? id : "default";
}

/** Normalises an archetype name; unknown agent classes render as ghosts. */
export function resolveArchetype(a: string | undefined | null): Archetype {
  return a && (ARCHETYPES as readonly string[]).includes(a) ? (a as Archetype) : "ghost";
}

/** Full palette for an archetype wearing a skin. Never throws; unknown inputs fall back. */
export function characterPalette(arch: string | undefined, skin?: string | null): CharPalette {
  const a = resolveArchetype(arch);
  return { ...BASE, ...ROLE[a], ...SKINS[resolveSkin(skin)] };
}
