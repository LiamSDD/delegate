import { describe, expect, it } from "vitest";

import { EmbeddingError, embedAll, type EmbeddingProvider } from "./embeddings";

function provider(
  reject: (text: string) => boolean,
  status = 422,
): EmbeddingProvider & { calls: number } {
  const fake = {
    provider: "fake",
    model: "fake",
    dimensions: 2,
    maxBatch: 4,
    calls: 0,
    embed(texts: readonly string[]) {
      fake.calls += 1;
      if (texts.some(reject)) return Promise.reject(new EmbeddingError("rejected", status));
      return Promise.resolve(texts.map(() => [1, 0]));
    },
  };
  return fake;
}

describe("embedAll", () => {
  it("bisects a rejected batch so one bad input does not lose the others", async () => {
    const texts = ["a", "b", "bad", "c", "d", "e"];
    const result = await embedAll(
      provider((text) => text === "bad"),
      texts,
      "passage",
    );
    expect(result.failed).toBe(1);
    expect(result.vectors.map((vector) => vector !== undefined)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
  });

  it("does not bisect on rate limits or server errors", async () => {
    await expect(
      embedAll(
        provider(() => true, 429),
        ["a", "b"],
        "passage",
      ),
    ).rejects.toThrow(EmbeddingError);
    await expect(
      embedAll(
        provider(() => true, 503),
        ["a", "b"],
        "passage",
      ),
    ).rejects.toThrow(EmbeddingError);
  });

  it("embeds batches in parallel and stops at the time budget, leaving the rest unembedded (gate run, curl 2026-11-25)", async () => {
    let clock = 0;
    let inFlight = 0;
    let peak = 0;
    const slow: EmbeddingProvider = {
      provider: "fake",
      model: "fake",
      dimensions: 2,
      maxBatch: 2,
      async embed(texts) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        clock += 1_000;
        inFlight -= 1;
        return texts.map(() => [1, 0]);
      },
    };
    const texts = Array.from({ length: 40 }, (_, index) => `chunk ${index}`);
    const result = await embedAll(slow, texts, "passage", undefined, {
      concurrency: 3,
      budgetMs: 5_000,
      now: () => clock,
    });
    expect(peak).toBe(3);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.vectors).toHaveLength(40);
    const embedded = result.vectors.filter((vector) => vector !== undefined).length;
    expect(embedded + result.skipped + result.failed).toBe(40);
    expect(embedded).toBeLessThan(20);
    expect(result.vectors.slice(0, 2).every((vector) => vector !== undefined)).toBe(true);
  });
});
