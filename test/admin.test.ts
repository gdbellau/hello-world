import { describe, expect, it } from "vitest";
import { SETTINGS, defaultSettings } from "../shared/settings";
import {
  addDays,
  buildExport,
  csrfError,
  dayList,
  diffImport,
  estimateDailyLoad,
  fillSeries,
  mergeDau,
  parseImport,
  productErrors,
  requireReason,
  totalsBetween,
  winRate,
} from "../worker/admin-lib";

const h = (o: Record<string, string>) => new Headers(o);

describe("day helpers", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("lists days oldest first, ending at the given day", () => {
    expect(dayList("2026-10-02", 3)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(dayList("2026-10-02", 1)).toEqual(["2026-10-02"]);
  });
});

describe("fillSeries", () => {
  const days = dayList("2026-10-05", 5);
  it("fills missing days with zeros and aligns values", () => {
    const s = fillSeries(
      [
        { day: "2026-10-01", metric: "new_players", value: 3 },
        { day: "2026-10-04", metric: "new_players", value: 7 },
        { day: "2026-10-05", metric: "revenue_cents", value: 499 },
      ],
      days,
    );
    expect(s.new_players).toEqual([3, 0, 0, 7, 0]);
    expect(s.revenue_cents).toEqual([0, 0, 0, 0, 499]);
  });
  it("ignores rows outside the window and handles no data", () => {
    expect(fillSeries([{ day: "2026-09-01", metric: "x", value: 1 }], days)).toEqual({});
    expect(fillSeries([], days)).toEqual({});
  });
  it("sums duplicate rows for the same day", () => {
    const s = fillSeries(
      [
        { day: "2026-10-05", metric: "dau", value: 2 },
        { day: "2026-10-05", metric: "dau", value: 3 },
      ],
      days,
    );
    expect(s.dau![4]).toBe(5);
  });
});

describe("totals and DAU merge", () => {
  const rows = [
    { day: "2026-10-01", metric: "a", value: 1 },
    { day: "2026-10-02", metric: "a", value: 2 },
    { day: "2026-10-03", metric: "a", value: 4 },
  ];
  it("sums only inside the inclusive range", () => {
    expect(totalsBetween(rows, "2026-10-02", "2026-10-03")).toEqual({ a: 6 });
    expect(totalsBetween(rows, "2026-11-01", "2026-11-30")).toEqual({});
  });
  it("prefers rolled-up dau and fills the rest from live counts", () => {
    const rolled = [{ day: "2026-10-01", metric: "dau", value: 10 }];
    const live = [
      { day: "2026-10-01", n: 99 },
      { day: "2026-10-02", n: 12 },
    ];
    expect(mergeDau(rolled, live)).toEqual([{ day: "2026-10-02", metric: "dau", value: 12 }]);
  });
  it("computes win rate without aborts, null when undecided", () => {
    expect(winRate(3, 1)).toBe(75);
    expect(winRate(0, 0)).toBeNull();
  });
  it("estimates daily load from averages", () => {
    const e = estimateDailyLoad({ dau: 100, missions_started: 50, purchases: 2, new_players: 10 });
    expect(e.requests).toBe(100 * 6 + 50 * 2 + 2 * 3);
    expect(e.rowsWritten).toBeGreaterThan(0);
    expect(estimateDailyLoad({})).toEqual({ requests: 0, rowsWritten: 0 });
  });
});

describe("settings import", () => {
  const current = defaultSettings();
  const numeric = SETTINGS.find((s) => s.type === "integer" && s.max !== undefined)!;

  it("parses our envelope and flat objects, rejects junk", () => {
    expect(parseImport({ format: "cabal-settings", version: 1, values: { a: 1 } })).toEqual({ a: 1 });
    expect(parseImport('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseImport("not json")).toThrow(/JSON/);
    expect(() => parseImport([1, 2])).toThrow();
    expect(() => parseImport({ format: "other", values: {} })).toThrow(/format/);
  });

  it("round-trips an export with no changes", () => {
    const d = diffImport(SETTINGS, current, parseImport(JSON.parse(JSON.stringify(buildExport(current)))));
    expect(d.changes).toEqual([]);
    expect(d.errors).toEqual([]);
    expect(d.unchanged.length).toBe(SETTINGS.length);
  });

  it("reports changes, resets to default, unknown keys and invalid values", () => {
    const changed = { ...current, [numeric.key]: (numeric.default as number) + 1 };
    const d = diffImport(SETTINGS, changed, {
      [numeric.key]: numeric.default, // back to default -> reset
      maintenance_mode: true,
      not_a_setting: 5,
      squad_size: 999, // out of range
    });
    expect(d.changes.find((c) => c.key === numeric.key)).toMatchObject({ action: "reset", to: numeric.default });
    expect(d.changes.find((c) => c.key === "maintenance_mode")).toMatchObject({ action: "set", from: false, to: true });
    expect(d.unknown).toEqual(["not_a_setting"]);
    expect(d.errors.map((e) => e.key)).toEqual(["squad_size"]);
  });

  it("coerces numeric strings the same way the Worker does", () => {
    const d = diffImport(SETTINGS, current, { squad_size: "5" });
    expect(d.changes[0]).toMatchObject({ key: "squad_size", to: 5 });
  });
});

describe("csrf", () => {
  const self = "https://cabal.example";
  it("lets reads through", () => {
    expect(csrfError("GET", h({}), self)).toBeNull();
  });
  it("requires the custom header on writes", () => {
    expect(csrfError("POST", h({}), self)).toMatch(/X-Admin-Request/);
    expect(csrfError("PUT", h({ "X-Admin-Request": "0" }), self)).toMatch(/X-Admin-Request/);
    expect(csrfError("DELETE", h({ "X-Admin-Request": "1" }), self)).toBeNull();
  });
  it("rejects cross-origin and cross-site writes even with the header", () => {
    expect(csrfError("POST", h({ "X-Admin-Request": "1", Origin: "https://evil.example" }), self)).toMatch(/origin/i);
    expect(csrfError("POST", h({ "X-Admin-Request": "1", "Sec-Fetch-Site": "cross-site" }), self)).toMatch(/site/i);
    expect(csrfError("POST", h({ "X-Admin-Request": "1", Origin: self, "Sec-Fetch-Site": "same-origin" }), self)).toBeNull();
  });
});

describe("validation helpers", () => {
  it("requires a reason", () => {
    expect(() => requireReason("")).toThrow();
    expect(() => requireReason("  ok ")).toThrow();
    expect(requireReason("  refund #12 ")).toBe("refund #12");
  });
  it("validates products field by field", () => {
    const ok = { name: "Pack", kind: "cosmetic", price_cents: 199, entitlement: "skin:chrome", active: true, stripe_price_id: "price_1AbCdEf" };
    expect(productErrors("skins-chrome", ok)).toEqual({});
    const bad = productErrors("Bad Id", { ...ok, kind: "nft", price_cents: 1.5, stripe_price_id: "prod_123", entitlement: "Skin Chrome" });
    expect(Object.keys(bad).sort()).toEqual(["entitlement", "id", "kind", "price_cents", "stripe_price_id"]);
  });
});
