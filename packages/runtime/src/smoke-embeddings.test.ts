import { describe, expect, it } from "vitest";

import { parseModelsConfig } from "./models";
import { runEmbeddingSmoke } from "./smoke";

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "emb",
      kind: "openai-compatible",
      baseUrl: "https://emb.test/v1",
      apiKeyEnv: "EMB_KEY",
      keyless: false,
      terms: "evaluation-only",
      maxClassification: "public",
      dataPolicy: "Test double.",
    },
  ],
  roles: { planner: [], worker: [], fast: [] },
  embeddings: {
    dimensions: 4,
    chain: [
      { provider: "emb", model: "emb-1", dimensions: 4, maxBatch: 8, quirks: ["dimensions-param"] },
    ],
  },
});

describe("runEmbeddingSmoke", () => {
  it("passes when the provider returns vectors of the configured size", async () => {
    let body = "";
    const fetchImpl: typeof fetch = (_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        Response.json({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] }),
      );
    };
    const [result] = await runEmbeddingSmoke({ config, env: { EMB_KEY: "k" }, fetchImpl });
    expect(result).toMatchObject({ provider: "emb", model: "emb-1", status: "pass" });
    expect(JSON.parse(body)).toMatchObject({ dimensions: 4 });
  });

  it("fails on a dimension mismatch and skips without a key", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    const [failed] = await runEmbeddingSmoke({ config, env: { EMB_KEY: "k" }, fetchImpl });
    expect(failed).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("2 dimensions") as unknown,
    });
    const [skipped] = await runEmbeddingSmoke({ config, env: {}, fetchImpl });
    expect(skipped?.status).toBe("skip");
  });
});
