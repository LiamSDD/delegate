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
