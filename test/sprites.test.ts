import { describe, expect, it } from "vitest";
import { bayer4, hash2, pick, rand2, rng } from "../src/game/gfx/hash";
import { characterPalette, hexToRgb, mix, resolveArchetype, resolveSkin, rgbToHex, shade, SKIN_IDS, SKINS } from "../src/game/gfx/palette";
import { music, setVolume, sfx, unlockAudio, getVolume, toggleMute, isMuted, applyAudioSettings } from "../src/game/audio";
import { defaultSettings } from "../shared/settings";

describe("skin palettes", () => {
  it("ships every advertised skin", () => {
    for (const id of ["default", "chrome", "yakuza", "founder", "exec", "samurai"]) expect(SKIN_IDS).toContain(id);
  });

  it("falls back to default for unknown, empty or missing skin ids", () => {
    expect(resolveSkin("chrome")).toBe("chrome");
    expect(resolveSkin("definitely-not-a-skin")).toBe("default");
    expect(resolveSkin("")).toBe("default");
    expect(resolveSkin(undefined)).toBe("default");
    expect(resolveSkin("__proto__")).toBe("default");
    expect(resolveSkin("toString")).toBe("default");
    expect(characterPalette("ghost", "nope")).toEqual(characterPalette("ghost", "default"));
  });

  it("falls back to a known archetype for unknown classes", () => {
    expect(resolveArchetype("razor")).toBe("razor");
    expect(resolveArchetype("mystery")).toBe("ghost");
    expect(resolveArchetype(undefined)).toBe("ghost");
  });

  it("skins actually change the look", () => {
    const base = characterPalette("bruiser", "default");
    for (const id of SKIN_IDS.filter((s) => s !== "default")) {
      expect(characterPalette("bruiser", id).main, id).not.toBe(base.main);
    }
    expect(characterPalette("razor", "yakuza").bareArms).toBe(true);
    expect(characterPalette("razor", "yakuza").trail).toBeDefined();
    expect(characterPalette("ghost", "samurai").crest).toBeDefined();
  });

  it("every palette colour is a valid hex colour", () => {
    for (const id of SKIN_IDS)
      for (const v of Object.values(characterPalette("decker", id)))
        if (typeof v === "string") expect(v).toMatch(/^#[0-9a-f]{6}$/i);
    for (const s of Object.values(SKINS)) expect(typeof s).toBe("object");
  });

  it("colour helpers round-trip", () => {
    expect(hexToRgb("#ff2bd6")).toEqual([255, 43, 214]);
    expect(rgbToHex([255, 43, 214])).toBe("#ff2bd6");
    expect(shade("#808080", 0.5)).toBe("#404040");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(rgbToHex([300, -5, 12.4])).toBe("#ff000c");
  });
});

describe("deterministic tile hash", () => {
  it("is stable for the same inputs", () => {
    expect(hash2(3, 7)).toBe(hash2(3, 7));
    expect(hash2(3, 7, 42)).toBe(hash2(3, 7, 42));
    // Pinned value: changing the hash reshuffles every map's decoration.
    expect(hash2(12, 34, 5)).toBe(641081472);
  });

  it("varies with x, y and seed and stays in range", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++) {
        const h = hash2(x, y, 1);
        expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
        seen.add(h);
        const r = rand2(x, y, 1);
        expect(r >= 0 && r < 1).toBe(true);
      }
    expect(seen.size).toBe(400);
    expect(hash2(1, 2)).not.toBe(hash2(2, 1));
    expect(hash2(1, 2, 1)).not.toBe(hash2(1, 2, 2));
  });

  it("is roughly uniform", () => {
    const buckets = new Array(8).fill(0);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) buckets[hash2(x, y, 9) % 8]++;
    for (const b of buckets) expect(b).toBeGreaterThan(400);
  });

  it("pick, rng and bayer are deterministic", () => {
    expect(pick(["a", "b", "c"], 4, 5)).toBe(pick(["a", "b", "c"], 4, 5));
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
    const vals = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) vals.add(bayer4(x, y));
    expect(vals.size).toBe(16);
    expect(bayer4(5, 9)).toBe(bayer4(1, 1));
  });
});

describe("audio facade without WebAudio", () => {
  it("never throws in node", () => {
    expect(() => {
      unlockAudio();
      sfx("shot");
      sfx("alarm");
      music("combat");
      music("none");
      applyAudioSettings(defaultSettings());
      setVolume("music", 0.3);
      toggleMute();
      toggleMute();
    }).not.toThrow();
    expect(getVolume("music")).toBeCloseTo(0.3);
    expect(isMuted()).toBe(false);
  });
});
