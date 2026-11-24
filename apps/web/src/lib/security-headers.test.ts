import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import {
  buildContentSecurityPolicy,
  createNonce,
  THEME_INIT_SCRIPT_HASH,
} from "./security-headers";
import { themeInitScript } from "./theme";

function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "") map.set(name, values);
  }
  return map;
}

describe("THEME_INIT_SCRIPT_HASH", () => {
  it("is the sha256 of the exact inline theme script", () => {
    const expected = createHash("sha256").update(themeInitScript, "utf8").digest("base64");
    expect(THEME_INIT_SCRIPT_HASH).toBe(`'sha256-${expected}'`);
  });
});

describe("buildContentSecurityPolicy", () => {
  const nonce = "bm9uY2UtdmFsdWU=";
  const policy = directives(buildContentSecurityPolicy({ nonce, isDev: false }));

  it("allows scripts only by nonce and the theme script hash", () => {
    expect(policy.get("script-src")).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
      THEME_INIT_SCRIPT_HASH,
      "'strict-dynamic'",
    ]);
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
  });

  it("locks down every other source", () => {
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:"]);
    expect(policy.get("font-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
  });

  it("adds unsafe-eval only in development, for React's dev tooling", () => {
    const dev = directives(buildContentSecurityPolicy({ nonce, isDev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
  });

  it("rejects a nonce that could break out of the directive", () => {
    expect(() => buildContentSecurityPolicy({ nonce: "x'; script-src *", isDev: false })).toThrow();
  });
});

describe("createNonce", () => {
  it("is base64 and unique per call", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(a).not.toBe(b);
  });
});

describe("next.config headers", () => {
  it("sets transport, sniffing, referrer, permissions and opener policies on every path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((rule) => rule.source)).toEqual(["/:path*"]);
    const headers = rules[0]?.headers ?? [];
    expect(Object.fromEntries(headers.map((h) => [h.key, h.value]))).toEqual({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });
});
