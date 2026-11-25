import { describe, expect, it } from "vitest";

import { CHUNK_DEFAULTS, chunkPage, estimateTokens } from "./chunker";

function paragraph(label: string, words: number): string {
  return Array.from({ length: words }, (_, index) => `${label}${index}`).join(" ");
}

describe("chunkPage", () => {
  it("keeps a short page in one chunk with its heading", () => {
    const chunks = chunkPage("# Pricing\n\nThe Team plan costs 20 euros per user.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, heading: "Pricing" });
    expect(chunks[0]?.text).toContain("Team plan costs 20 euros");
  });

  it("splits long text near the token target with overlap", () => {
    const text = Array.from({ length: 12 }, (_, index) => paragraph(`p${index}w`, 120)).join(
      "\n\n",
    );
    const chunks = chunkPage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxTokens);
    }
    const first = chunks[0]?.text ?? "";
    const second = chunks[1]?.text ?? "";
    const tail = first.split(/\s+/).slice(-5).join(" ");
    expect(second).toContain(tail);
  });

  it("starts a new chunk at a top-level heading and records it", () => {
    const text = [
      "# Product",
      paragraph("a", 250),
      "## Integrations",
      paragraph("b", 250),
      "# Support",
      paragraph("c", 250),
    ].join("\n\n");
    const chunks = chunkPage(text);
    const headings = chunks.map((chunk) => chunk.heading);
    expect(headings).toContain("Support");
    const support = chunks.find((chunk) => chunk.heading === "Support");
    expect(support?.text.startsWith("# Support")).toBe(true);
    expect(support?.text).not.toContain("a1 ");
  });

  it("hard-splits a single oversized block", () => {
    const chunks = chunkPage(paragraph("x", 2_000));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.tokenCount <= CHUNK_DEFAULTS.maxTokens)).toBe(true);
  });

  it("estimates tokens from characters", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});
