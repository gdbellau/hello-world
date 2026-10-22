import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex } from "../worker/crypto";
import { isLocalHost, isLoginTokenShape, loginEmail, normaliseEmail, sendEmail, type EmailConfig } from "../worker/email";

describe("email normalisation", () => {
  it("trims and lower-cases valid addresses", () => {
    expect(normaliseEmail("  Neo.Anderson+cabal@Metacortex.COM ")).toBe("neo.anderson+cabal@metacortex.com");
    expect(normaliseEmail("a_b@sub.domain.co.uk")).toBe("a_b@sub.domain.co.uk");
  });

  it("rejects junk and injection attempts", () => {
    for (const bad of [
      "",
      "plain",
      "@x.com",
      "a@",
      "a@b",
      "a@b.c",
      "a b@x.com",
      "a@x..com",
      ".a@x.com",
      "a.@x.com",
      "a..b@x.com",
      "a@-x.com",
      "a@x-.com",
      "a@[127.0.0.1]",
      "a@x.com\r\nBcc: v@y.com",
      '"a"@x.com',
      `${"a".repeat(65)}@x.com`,
      `a@${"b".repeat(250)}.com`,
      42,
      null,
      { email: "a@x.com" },
    ]) {
      expect(normaliseEmail(bad), String(bad)).toBeNull();
    }
  });
});

describe("login tokens", () => {
  it("are 256-bit url-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isLoginTokenShape(a)).toBe(true);
  });

  it("only accept the expected shape", () => {
    expect(isLoginTokenShape("short")).toBe(false);
    expect(isLoginTokenShape("x".repeat(129))).toBe(false);
    expect(isLoginTokenShape(`${"x".repeat(40)}' OR 1=1`)).toBe(false);
    expect(isLoginTokenShape(undefined)).toBe(false);
  });

  it("are stored hashed", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("login email", () => {
  it("escapes the link in HTML and includes it in text", () => {
    const m = loginEmail("a@x.com", "Sign in", 'https://g.example/?login=abc"><script>', 15);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&quot;&gt;&lt;script&gt;");
    expect(m.text).toContain("https://g.example/?login=abc");
    expect(m.text).toContain("15 minutes");
  });

  it("sends through Resend only when configured", async () => {
    const calls: [string, RequestInit][] = [];
    const fetcher = (async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const msg = loginEmail("a@x.com", "S", "https://g/?login=t", 15);
    expect(await sendEmail({}, msg, fetcher)).toBe(false);
    expect(calls).toHaveLength(0);
    const env = { RESEND_API_KEY: "re_1", EMAIL_FROM: "C <l@x.com>" } satisfies EmailConfig;
    expect(await sendEmail(env, msg, fetcher)).toBe(true);
    expect(calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({ from: "C <l@x.com>", to: ["a@x.com"], subject: "S" });
    const failing = (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    expect(await sendEmail(env, msg, failing)).toBe(false);
  });
});

describe("dev link exposure", () => {
  it("is limited to localhost", () => {
    expect(isLocalHost(new URL("http://localhost:8787/"))).toBe(true);
    expect(isLocalHost(new URL("http://127.0.0.1:8787/"))).toBe(true);
    expect(isLocalHost(new URL("https://thecabal.example/"))).toBe(false);
    expect(isLocalHost(new URL("https://localhost.evil.example/"))).toBe(false);
  });
});
