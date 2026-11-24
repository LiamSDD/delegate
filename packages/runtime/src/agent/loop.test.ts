import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ModelStreamEvent } from "../providers/types";
import { RESEARCH_STEP, scriptedProvider, testRun, textTurn, toolTurn } from "../testing/fakes";
import { defineTool } from "../tools/registry";
import { runAgentLoop, type AgentLoopOptions } from "./loop";

const lookup = defineTool({
  name: "lookup",
  description: "Look something up",
  capability: CAPABILITIES.webFetch,
  inputSchema: z.object({ url: z.string() }),
  targetDomain: (input) => new URL(input.url).hostname,
  summariseArgs: (input) => input.url,
  execute: (input) => Promise.resolve({ summary: "found", forModel: `facts for ${input.url}` }),
});

function options(
  run: ReturnType<typeof testRun>,
  overrides: Partial<AgentLoopOptions> = {},
): AgentLoopOptions {
  return {
    run: run.ctx,
    step: RESEARCH_STEP,
    agentId: "agent_1",
    role: "worker",
    system: "You research.",
    tools: [lookup],
    messages: [{ role: "user", content: "Research acme.example" }],
    maxIterations: 4,
    maxTokens: 500,
    ...overrides,
  };
}

describe("runAgentLoop", () => {
  it("runs send, stream, tools, results, repeat until the model ends", async () => {
    const provider = scriptedProvider("fake", [
      toolTurn([
        { id: "c1", name: "lookup", args: { url: "https://acme.example/about" } },
        { id: "c2", name: "lookup", args: { url: "https://acme.example/pricing" } },
      ]),
      textTurn("All done."),
    ]);
    const run = testRun({ provider });
    const result = await runAgentLoop(options(run));
    expect(result).toMatchObject({ outcome: "end", text: "All done.", iterations: 2 });
    expect(result.toolCalls).toHaveLength(2);
    const second = provider.requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(second?.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      content: "facts for https://acme.example/about",
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "usage.updated",
      "policy.decided",
      "tool.called",
      "tool.result",
      "policy.decided",
      "tool.called",
      "tool.result",
      "agent.message",
      "usage.updated",
    ]);
  });

  it("keeps the system prompt and tool definitions byte-stable and first across turns", async () => {
    const provider = scriptedProvider("fake", [
      toolTurn([{ id: "c1", name: "lookup", args: { url: "https://acme.example/" } }]),
      textTurn("ok"),
    ]);
    const run = testRun({ provider });
    await runAgentLoop(options(run));
    const [first, second] = provider.requests;
    expect(second?.system).toBe(first?.system);
    expect(second?.tools).toBe(first?.tools);
  });

  it("streams coalesced agent messages and never forwards reasoning", async () => {
    let clock = 0;
    const turn: ModelStreamEvent[] = [
      { type: "reasoning_delta", text: "secret plan" },
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "big " },
      { type: "text_delta", text: "world" },
      {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: "stop", reason: "end" },
    ];
    const provider = scriptedProvider("fake", [
      (request) => {
        expect(request.system).toBe("You research.");
        return turn;
      },
    ]);
    const run = testRun({ provider, clock: () => (clock += 120) });
    await runAgentLoop(options(run));
    const messages = run.events.filter((event) => event.type === "agent.message");
    const texts = messages.map((event) => event.payload.text);
    expect(texts.join("")).toBe("Hello big world");
    expect(texts.length).toBeLessThan(3);
    expect(texts.join("")).not.toContain("secret");
    expect(messages[0]).toMatchObject({ agentId: "agent_1", stepId: "s1" });
  });

  it("denies tool calls beyond the per-loop cap without executing them", async () => {
    const provider = scriptedProvider("fake", [
      toolTurn([
        { id: "c1", name: "lookup", args: { url: "https://acme.example/a" } },
        { id: "c2", name: "lookup", args: { url: "https://acme.example/b" } },
        { id: "c3", name: "lookup", args: { url: "https://acme.example/c" } },
      ]),
      textTurn("done"),
    ]);
    const run = testRun({ provider });
    const result = await runAgentLoop(options(run, { maxToolCalls: 2 }));
    expect(result.toolCalls.map((call) => call.ok)).toEqual([true, true, false]);
    expect(run.events.filter((event) => event.type === "tool.called")).toHaveLength(2);
    const denied = run.events.filter(
      (event) => event.type === "policy.decided" && event.payload.decision === "deny",
    );
    expect(denied).toHaveLength(1);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "c3",
      isError: true,
    });
  });

  it("stops at the iteration bound", async () => {
    const provider = scriptedProvider("fake", () =>
      toolTurn([{ id: "c", name: "lookup", args: { url: "https://acme.example/" } }]),
    );
    const run = testRun({ provider });
    const result = await runAgentLoop(options(run, { maxIterations: 3 }));
    expect(result).toMatchObject({ outcome: "max_iterations", iterations: 3 });
    expect(provider.requests).toHaveLength(3);
  });

  it("resumes after pause_turn without inventing tool results", async () => {
    const provider = scriptedProvider("fake", [
      [
        { type: "text_delta", text: "Working" },
        { type: "stop", reason: "pause_turn" },
      ],
      textTurn("Finished"),
    ]);
    const run = testRun({ provider });
    const result = await runAgentLoop(options(run));
    expect(result.outcome).toBe("end");
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it.each([
    ["max_tokens", "max_tokens"],
    ["refusal", "refusal"],
    ["error", "error"],
  ] as const)("maps stop reason %s to outcome %s", async (reason, outcome) => {
    const provider = scriptedProvider("fake", [
      [
        { type: "text_delta", text: "partial" },
        {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        { type: "stop", reason },
      ],
    ]);
    const run = testRun({ provider });
    expect((await runAgentLoop(options(run))).outcome).toBe(outcome);
  });

  it("stops when the step budget is exhausted", async () => {
    const provider = scriptedProvider("fake", () =>
      toolTurn([{ id: "c", name: "lookup", args: { url: "https://acme.example/" } }]),
    );
    const run = testRun({ provider, maxTokens: 300 });
    const result = await runAgentLoop(options(run, { maxIterations: 10 }));
    expect(result.outcome).toBe("budget_exceeded");
    expect(provider.requests.length).toBeLessThan(10);
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider("fake", () => {
      controller.abort();
      return toolTurn([{ id: "c", name: "lookup", args: { url: "https://acme.example/" } }]);
    });
    const run = testRun({ provider, signal: controller.signal });
    const result = await runAgentLoop(options(run));
    expect(result.outcome).toBe("aborted");
    expect(provider.requests).toHaveLength(1);
  });

  it("does not start a new turn after the deadline", async () => {
    let clock = 0;
    const provider = scriptedProvider("fake", () => {
      clock += 10_000;
      return toolTurn([{ id: "c", name: "lookup", args: { url: "https://acme.example/" } }]);
    });
    const run = testRun({ provider, clock: () => clock });
    const result = await runAgentLoop(options(run, { deadlineAt: 15_000 }));
    expect(result.outcome).toBe("deadline");
    expect(provider.requests).toHaveLength(2);
  });
});
