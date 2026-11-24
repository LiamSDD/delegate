import { describe, expect, it } from "vitest";

import { loadKeylessChain } from "./model-chain-file";

function fixture(contents: string): () => Promise<string> {
  return () => Promise.resolve(contents);
}

function missing(): Promise<string> {
  return Promise.reject(new Error("ENOENT"));
}

describe("loadKeylessChain", () => {
  it("reports a missing file", async () => {
    expect(await loadKeylessChain(missing)).toEqual({
      status: "unavailable",
      reason: "config/models.json was not found",
    });
  });

  it("reports a file that is not JSON", async () => {
    expect(await loadKeylessChain(fixture("{ nope"))).toEqual({
      status: "unavailable",
      reason: "config/models.json is not valid JSON",
    });
  });

  it("summarises a valid file", async () => {
    const read = fixture(
      JSON.stringify({
        version: 1,
        providers: [
          { id: "llm7", kind: "openai-compatible", keyless: true, terms: "public-demo-ok" },
        ],
        roles: { planner: [], worker: [{ provider: "llm7", model: "m" }], fast: [] },
      }),
    );
    const summary = await loadKeylessChain(read);
    expect(summary.status).toBe("ok");
  });
});
