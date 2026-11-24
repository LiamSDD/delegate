import { describe, expect, it } from "vitest";

import { Budget } from "../budget";
import { parseModelsConfig, type LatencyMode } from "../models";
import { scriptedProvider, textTurn } from "../testing/fakes";
import { createRunContext } from "./context";
import { createRunEmitter } from "./emitter";
import { callModel } from "./model-call";

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "fake",
      kind: "openai-compatible",
      baseUrl: "https://fake.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "Test double.",
    },
  ],
  roles: {
    planner: [
      {
        provider: "fake",
        model: "slow-strong",
        contextWindow: 32000,
        supportsTools: true,
        interactive: false,
      },
      { provider: "fake", model: "fast-good", contextWindow: 32000, supportsTools: true },
    ],
    worker: [],
    fast: [],
  },
});

async function servedModel(latency?: LatencyMode): Promise<string> {
  const provider = scriptedProvider("fake", () => textTurn("ok"));
  const ctx = createRunContext({
    runId: "run_1",
    workspaceId: "ws_1",
    audience: "owner",
    classification: "public",
    config,
    env: {},
    emitter: createRunEmitter(() => Promise.resolve()),
    budget: new Budget({ run: { maxTokens: 10_000, maxMicroUsd: 0 } }),
    policies: [],
    createProvider: () => provider,
    ...(latency === undefined ? {} : { latency }),
  });
  const result = await callModel(ctx, {
    role: "planner",
    stepId: "s1",
    request: { system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
  });
  return result.model;
}

describe("createRunContext latency", () => {
  it("routes interactive runs past entries marked interactive: false", async () => {
    expect(await servedModel()).toBe("fast-good");
    expect(await servedModel("interactive")).toBe("fast-good");
  });

  it("lets offline runs use entries marked interactive: false", async () => {
    expect(await servedModel("offline")).toBe("slow-strong");
  });
});
