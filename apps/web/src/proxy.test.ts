import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "./proxy";

function nonceOf(policy: string | null): string | undefined {
  return policy?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
}

describe("proxy", () => {
  it("sends a fresh nonce CSP on the response and forwards it to rendering", () => {
    const response = proxy(new NextRequest("http://localhost/"));
    const policy = response.headers.get("Content-Security-Policy");
    const nonce = nonceOf(policy);
    expect(nonce).toBeDefined();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
  });

  it("never reuses a nonce across requests", () => {
    const first = proxy(new NextRequest("http://localhost/"));
    const second = proxy(new NextRequest("http://localhost/"));
    expect(nonceOf(first.headers.get("Content-Security-Policy"))).not.toBe(
      nonceOf(second.headers.get("Content-Security-Policy")),
    );
  });
});

describe("proxy framing", () => {
  const policy = (path: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(`http://localhost${path}`, { headers }));

  it("allows any ancestor to frame only the embed route", () => {
    const embed = policy("/embed/6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10");
    expect(embed.headers.get("Content-Security-Policy")).toContain("frame-ancestors *");
    expect(embed.headers.get("x-middleware-request-x-delegate-embed")).toBe("1");
    for (const path of ["/", "/agents/6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10", "/embedded/x"]) {
      expect(policy(path).headers.get("Content-Security-Policy")).toContain(
        "frame-ancestors 'none'",
      );
    }
  });

  it("does not let a client claim the embed chrome on other routes", () => {
    const spoofed = policy("/runs", { "x-delegate-embed": "1" });
    expect(spoofed.headers.get("x-middleware-request-x-delegate-embed")).toBeNull();
  });
});
