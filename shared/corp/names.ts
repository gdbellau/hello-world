// Procedural cyberpunk names for recruits. Pure: takes an rng so it's testable.

export type Rng = () => number;

/** Small seeded PRNG (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length]!;

const CALLSIGNS = [
  "VIPER", "GHOST", "HEX", "BRICK", "NOVA", "KATANA", "STATIC", "GLITCH", "RAZOR", "CIPHER", "WRAITH", "MANTIS",
  "JACKAL", "KESTREL", "NEON", "CHROME", "VOLT", "ZERO", "SPECTRE", "DRIFT", "ONI", "TALON", "SABLE", "FLUX",
  "RONIN", "VANTA", "JINX", "PYRE", "HALCYON", "BISHOP", "ROOK", "SPLICE", "QUILL", "MOTH", "TANGO", "ECHO",
  "SHRIKE", "VECTOR", "NULL", "PATCH", "SKARAB", "KOI", "LYNX", "CINDER", "BANSHEE", "DAEMON", "TORQUE", "WIRE",
];

const FIRST = [
  "Ines", "Kaito", "Amara", "Dmitri", "Yuki", "Tomas", "Zara", "Ravi", "Mei", "Oskar", "Nadia", "Kofi", "Lena",
  "Jun", "Sofia", "Malik", "Aiko", "Mateo", "Priya", "Viktor", "Elif", "Tariq", "Hana", "Bastian", "Noor", "Chen",
];

const LAST = [
  "Okafor", "Tanaka", "Reyes", "Volkov", "Nakamura", "Mbeki", "Silva", "Kovacs", "Haddad", "Lindqvist", "Ortega",
  "Park", "Novak", "Achebe", "Moreau", "Sato", "Ivanova", "Castellano", "Rahman", "Weber", "Osei", "Kim", "Duarte",
];

/** Short upper-case handle that fits the in-mission agent card (≤ 10 chars). */
export function generateCallsign(rng: Rng, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (let i = 0; i < 12; i++) {
    const c = pick(rng, CALLSIGNS);
    if (!used.has(c)) return c;
  }
  // Every short handle is taken: add a numeric suffix.
  for (;;) {
    const c = `${pick(rng, CALLSIGNS).slice(0, 7)}-${Math.floor(rng() * 90) + 10}`;
    if (!used.has(c)) return c;
  }
}

export function generateFullName(rng: Rng): string {
  return `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
}
