import { describe, expect, it } from "vitest";

import { summariseKeylessChain } from "./model-chain";

const config = {
  version: 1,
  providers: [
    {
      id: "pollinations",
      kind: "openai-compatible",
      baseUrl: "https://p",
      keyless: true,
      terms: "public-demo-ok",
      dataPolicy: "x",
    },
    {
      id: "llm7",
      kind: "openai-compatible",
      baseUrl: "https://l",
      keyless: true,
      terms: "public-demo-ok",
      dataPolicy: "x",
    },
    { id: "webllm", kind: "webllm", keyless: true, terms: "public-demo-ok", dataPolicy: "x" },
    {
      id: "ollama",
      kind: "ollama",
      baseUrl: "http://localhost",
      keyless: true,
      terms: "local-only",
      dataPolicy: "x",
    },
    {
      id: "nvidia",
      kind: "openai-compatible",
      baseUrl: "https://n",
      apiKeyEnv: "NVIDIA_API_KEY",
      keyless: false,
      terms: "evaluation-only",
      dataPolicy: "x",
    },
    {
      id: "anthropic",
      kind: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      keyless: false,
      terms: "byok",
      dataPolicy: "x",
    },
  ],
  roles: {
    planner: [
      {
        provider: "pollinations",
        model: "gpt-oss-large",
        contextWindow: 128000,
        supportsTools: true,
      },
      { provider: "nvidia", model: "kimi", contextWindow: 256000, supportsTools: true },
      { provider: "anthropic", model: "claude", contextWindow: 200000, supportsTools: true },
    ],
    worker: [
      { provider: "llm7", model: "gpt-oss-20b", contextWindow: 32000, supportsTools: true },
      {
        provider: "pollinations",
        model: "gpt-oss-large",
        contextWindow: 128000,
        supportsTools: true,
      },
      { provider: "ollama", model: "qwen", contextWindow: 32000, supportsTools: true },
    ],
    fast: [{ provider: "webllm", model: "qwen-small", contextWindow: 4096, supportsTools: true }],
  },
};

describe("summariseKeylessChain", () => {
  it("lists keyless providers usable by a public visitor, in chain order", () => {
    const summary = summariseKeylessChain(config);
    expect(summary).toEqual({
      status: "ok",
      providers: [
        {
          id: "pollinations",
          name: "Pollinations",
          placement: "hosted",
          models: ["gpt-oss-large"],
          roles: ["planner", "worker"],
        },
        {
          id: "llm7",
          name: "LLM7",
          placement: "hosted",
          models: ["gpt-oss-20b"],
          roles: ["worker"],
        },
        {
          id: "webllm",
          name: "WebLLM",
          placement: "in-browser",
          models: ["qwen-small"],
          roles: ["fast"],
        },
      ],
    });
  });

  it("reports invalid config instead of guessing", () => {
    expect(summariseKeylessChain({ version: 2 })).toEqual({
      status: "unavailable",
      reason: "config/models.json did not match the expected schema",
    });
  });

  it("reports when no keyless provider is configured", () => {
    expect(
      summariseKeylessChain({ ...config, roles: { planner: [], worker: [], fast: [] } }),
    ).toEqual({
      status: "unavailable",
      reason: "No keyless provider is configured",
    });
  });
});
