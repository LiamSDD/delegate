import { describe, expect, it } from "vitest";

import { parseModelsConfig } from "./models";
import { formatSmokeReport, runSmoke } from "./smoke";

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "free",
      kind: "openai-compatible",
      baseUrl: "https://free.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
    },
    {
      id: "keyed",
      kind: "openai-compatible",
      baseUrl: "https://keyed.test/v1",
      apiKeyEnv: "KEYED_API_KEY",
      keyless: false,
      terms: "evaluation-only",
      maxClassification: "public",
      dataPolicy: "x",
    },
    {
      id: "browser",
      kind: "webllm",
      keyless: true,
      terms: "local-only",
      maxClassification: "confidential",
      dataPolicy: "x",
    },
  ],
  roles: {
    planner: [
      {
        provider: "keyed",
        model: "big",
        contextWindow: 100000,
        supportsTools: true,
        reasoningEffort: "low",
      },
      { provider: "free", model: "small", contextWindow: 32000, supportsTools: true },
    ],
    worker: [{ provider: "free", model: "small", contextWindow: 32000, supportsTools: true }],
    fast: [{ provider: "browser", model: "tiny", contextWindow: 4096, supportsTools: true }],
  },
});

function sse(lines: unknown[]): Response {
  return new Response(
    lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

const toolCall = () =>
  sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "c",
                type: "function",
                function: { name: "ping", arguments: '{"value":"pong"}' },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);

describe("runSmoke", () => {
  it("checks each configured server-side model once, with a tool call, and skips the rest", async () => {
    const bodies: Record<string, unknown>[] = [];
    let clock = 0;
    const results = await runSmoke({
      config,
      env: { KEYED_API_KEY: "nvapi-SECRET123" },
      now: () => (clock += 250),
      fetchImpl: (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        bodies.push(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
        );
        if (url.startsWith("https://keyed.test")) {
          return Promise.resolve(new Response("bad key nvapi-SECRET123", { status: 401 }));
        }
        return Promise.resolve(toolCall());
      },
    });
    expect(
      results.map((result) => [result.provider, result.model, result.status, result.toolCall]),
    ).toEqual([
      ["keyed", "big", "fail", false],
      ["free", "small", "pass", true],
      ["browser", "tiny", "skip", false],
    ]);
    expect(results[1]?.latencyMs).toBe(250);
    expect(bodies[0]?.reasoning_effort).toBe("low");
    const report = formatSmokeReport(results);
    expect(report).not.toContain("SECRET123");
    expect(report).toContain("PASS");
    expect(report).toContain("free/small");
  });

  it("skips offline-only entries instead of waiting minutes for them", async () => {
    const offline = parseModelsConfig({
      ...config,
      roles: {
        ...config.roles,
        planner: [
          {
            provider: "keyed",
            model: "slow",
            contextWindow: 100000,
            supportsTools: true,
            interactive: false,
          },
        ],
      },
    });
    let calls = 0;
    const results = await runSmoke({
      config: offline,
      env: { KEYED_API_KEY: "k" },
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(toolCall());
      },
    });
    expect(results[0]).toMatchObject({ provider: "keyed", model: "slow", status: "skip" });
    expect(results[0]?.detail).toMatch(/offline only/);
    expect(calls).toBe(1);
  });

  it("fails a model that answers without calling the tool", async () => {
    const results = await runSmoke({
      config,
      env: {},
      fetchImpl: () =>
        Promise.resolve(
          sse([
            { choices: [{ index: 0, delta: { content: "pong" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]),
        ),
    });
    expect(results.find((result) => result.provider === "free")).toMatchObject({
      status: "fail",
      toolCall: false,
      detail: "no tool call",
    });
  });
});
