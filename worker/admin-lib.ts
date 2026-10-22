// Pure helpers shared by the admin Worker routes, the admin client and tests.
// No Workers or DOM APIs in here.

import { validateSetting, type SettingDef, type SettingValue } from "../shared/settings";

// --- Days & series -----------------------------------------------------------

const DAY_MS = 86_400_000;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `YYYY-MM-DD` shifted by n days (UTC). */
export function addDays(day: string, n: number): string {
  return dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

/** The `count` days ending at (and including) `endDay`, oldest first. */
export function dayList(endDay: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(endDay, -i));
  return out;
}

export interface StatRow {
  day: string;
  metric: string;
  value: number;
}

/**
 * Turns sparse (day, metric, value) rows into one dense array per metric,
 * aligned to `days` with zeros for missing days. Rows outside `days` are ignored.
 */
export function fillSeries(rows: readonly StatRow[], days: readonly string[]): Record<string, number[]> {
  const idx = new Map(days.map((d, i) => [d, i]));
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const i = idx.get(r.day);
    if (i === undefined) continue;
    const s = (out[r.metric] ??= new Array<number>(days.length).fill(0));
    s[i] = (s[i] ?? 0) + Number(r.value || 0);
  }
  return out;
}

/** Sum of every metric over rows whose day falls in [from, to]. */
export function totalsBetween(rows: readonly StatRow[], from: string, to: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.day >= from && r.day <= to) out[r.metric] = (out[r.metric] ?? 0) + Number(r.value || 0);
  return out;
}

/**
 * DAU per day: the rolled-up `dau` metric wins when the cron has written it,
 * otherwise the live count from player_days.
 */
export function mergeDau(rolled: readonly StatRow[], live: readonly { day: string; n: number }[]): StatRow[] {
  const have = new Set(rolled.filter((r) => r.metric === "dau").map((r) => r.day));
  return live.filter((l) => !have.has(l.day)).map((l) => ({ day: l.day, metric: "dau", value: l.n }));
}

/** Win rate in percent (wins vs. wins + losses; aborts don't count), or null with no decided runs. */
export function winRate(won: number, lost: number): number | null {
  return won + lost > 0 ? (100 * won) / (won + lost) : null;
}

// --- Settings import / export -----------------------------------------------

export const EXPORT_FORMAT = "cabal-settings";

export interface SettingsExport {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  exportedBy?: string;
  values: Record<string, SettingValue>;
}

export function buildExport(values: Record<string, SettingValue>, by?: string, now = Date.now()): SettingsExport {
  return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date(now).toISOString(), exportedBy: by, values: { ...values } };
}

/** Accepts our export envelope or a flat `{ key: value }` object. */
export function parseImport(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error("Not valid JSON");
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object");
  const obj = input as Record<string, unknown>;
  if ("values" in obj) {
    if (obj.format !== undefined && obj.format !== EXPORT_FORMAT) throw new Error(`Unknown export format: ${String(obj.format)}`);
    const v = obj.values;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("`values` must be an object");
    return v as Record<string, unknown>;
  }
  return obj;
}

export interface ImportChange {
  key: string;
  label: string;
  category: string;
  from: SettingValue;
  to: SettingValue;
  /** `reset` when the new value equals the default (the override row is removed). */
  action: "set" | "reset";
}

export interface ImportDiff {
  changes: ImportChange[];
  unchanged: string[];
  unknown: string[];
  errors: { key: string; error: string }[];
}

/**
 * Diffs an import against the current effective values. Unknown keys are
 * reported and skipped (e.g. an export from a newer build); invalid values are
 * errors and block the whole import.
 */
export function diffImport(
  schema: readonly SettingDef[],
  current: Record<string, SettingValue>,
  imported: Record<string, unknown>,
): ImportDiff {
  const byKey = new Map(schema.map((d) => [d.key, d]));
  const diff: ImportDiff = { changes: [], unchanged: [], unknown: [], errors: [] };
  for (const [key, raw] of Object.entries(imported)) {
    const def = byKey.get(key);
    if (!def) {
      diff.unknown.push(key);
      continue;
    }
    let to: SettingValue;
    try {
      to = validateSetting(key, raw);
    } catch (e) {
      diff.errors.push({ key, error: (e as Error).message });
      continue;
    }
    const from = current[key] ?? def.default;
    if (from === to) diff.unchanged.push(key);
    else diff.changes.push({ key, label: def.label, category: def.category, from, to, action: to === def.default ? "reset" : "set" });
  }
  return diff;
}

// --- CSRF -------------------------------------------------------------------

export const CSRF_HEADER = "X-Admin-Request";

/**
 * Access authenticates with an ambient cookie, so a cross-site form post would
 * carry it. State-changing admin calls must therefore send a custom header
 * (which forces a CORS preflight that we never grant) and, when the browser
 * says so, come from our own origin. Returns an error message, or null if OK.
 */
export function csrfError(method: string, headers: { get(name: string): string | null }, selfOrigin: string): string | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (headers.get(CSRF_HEADER) !== "1") return `Missing ${CSRF_HEADER} header`;
  const origin = headers.get("Origin");
  if (origin && origin !== "null" && origin !== selfOrigin) return "Cross-origin request refused";
  const site = headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-site request refused";
  return null;
}

// --- Validation helpers -----------------------------------------------------

export function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("A reason (at least 3 characters) is required");
  if (reason.length > 500) throw new Error("Reason is too long (500 max)");
  return reason.trim();
}

export const PRODUCT_KINDS = ["cosmetic", "expansion", "supporter"] as const;

export interface ProductInput {
  name: string;
  description?: string;
  kind: string;
  price_cents: number;
  currency?: string;
  stripe_price_id?: string | null;
  entitlement: string;
  active: boolean;
  sort?: number;
}

/** Field-level product validation; returns `{ field: message }` (empty when valid). */
export function productErrors(id: string, p: Partial<ProductInput>): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[a-z0-9-]{1,64}$/.test(id)) e.id = "Lowercase letters, digits and dashes (max 64)";
  if (typeof p.name !== "string" || !p.name.trim()) e.name = "Required";
  else if (p.name.length > 120) e.name = "Max 120 characters";
  if (p.description !== undefined && (typeof p.description !== "string" || p.description.length > 1000)) e.description = "Max 1000 characters";
  if (!PRODUCT_KINDS.includes(p.kind as (typeof PRODUCT_KINDS)[number])) e.kind = `One of ${PRODUCT_KINDS.join(", ")}`;
  if (!Number.isInteger(p.price_cents) || (p.price_cents as number) < 0 || (p.price_cents as number) > 100_000_00)
    e.price_cents = "Whole cents, 0 to 10,000,000";
  if (p.currency !== undefined && !/^[a-zA-Z]{3}$/.test(p.currency)) e.currency = "3-letter ISO code";
  if (p.stripe_price_id && !/^price_[A-Za-z0-9]{6,}$/.test(p.stripe_price_id)) e.stripe_price_id = "Looks like price_…";
  if (typeof p.entitlement !== "string" || !/^[a-z0-9:_-]{1,64}$/.test(p.entitlement)) e.entitlement = "e.g. skin:chrome (a-z 0-9 : _ -)";
  if (p.sort !== undefined && !Number.isInteger(p.sort)) e.sort = "Whole number";
  return e;
}

export const ENTITLEMENT_RE = /^[a-z0-9:_-]{1,64}$/;

// --- Free-tier budget -------------------------------------------------------

export const FREE_TIER = {
  workerRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageBytes: 5 * 1024 ** 3,
} as const;

/**
 * Rough per-day load from the daily counters. Coefficients are what the
 * current routes do per action; it's an estimate, not a meter.
 */
export function estimateDailyLoad(avg: Record<string, number>): { requests: number; rowsWritten: number } {
  const dau = avg.dau ?? 0;
  const started = avg.missions_started ?? 0;
  const purchases = avg.purchases ?? 0;
  const newPlayers = avg.new_players ?? 0;
  // Per active player: page + config + session + me, ~2 sessions a day.
  const requests = dau * 6 + started * 2 + purchases * 3;
  // session UPDATE + player_days, mission start (run + stat), complete (run, player, 3 stats), purchases (5).
  const rowsWritten = dau * 3 + newPlayers * 3 + started * 7 + purchases * 6;
  return { requests: Math.round(requests), rowsWritten: Math.round(rowsWritten) };
}
