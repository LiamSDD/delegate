import { describe, expect, it } from "vitest";

import { embedSnippet, isEmbedPath, requestOrigin, widgetScript } from "./embed";

describe("embedSnippet", () => {
  it("is a single async script tag pointing at the widget with the assistant id", () => {
    expect(embedSnippet("https://delegate.dev", "6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10")).toBe(
      '<script src="https://delegate.dev/widget.js" data-assistant="6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10" async></script>',
    );
  });
});

describe("requestOrigin", () => {
  it("prefers forwarded headers and uses http only for local hosts", () => {
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(requestOrigin(headers({ host: "localhost:3125" }))).toBe("http://localhost:3125");
    expect(requestOrigin(headers({ host: "delegate.dev" }))).toBe("https://delegate.dev");
    expect(
      requestOrigin(
        headers({ host: "internal", "x-forwarded-host": "demo.dev", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://demo.dev");
    expect(requestOrigin(headers({ host: "evil.dev/<script>" }))).toBe("http://localhost:3000");
  });
});

describe("isEmbedPath", () => {
  it("matches only the embed route tree", () => {
    expect(isEmbedPath("/embed/abc")).toBe(true);
    expect(isEmbedPath("/embed")).toBe(false);
    expect(isEmbedPath("/embedded/abc")).toBe(false);
    expect(isEmbedPath("/agents/abc")).toBe(false);
  });
});

describe("widgetScript", () => {
  it("never evaluates strings and frames only the embed route of its own origin", () => {
    const source = widgetScript();
    expect(source).not.toMatch(/\beval\(|new Function|setTimeout\(\s*["'`]|innerHTML/);
    expect(source).toContain("/embed/");
    expect(source).toContain("document.currentScript");
    expect(source).toMatch(/\[0-9a-f-\]\{36\}|uuid/i);
  });
});
