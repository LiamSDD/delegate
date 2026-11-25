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
});
