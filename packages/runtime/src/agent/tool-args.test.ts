import { CAPABILITIES, defaultPolicy } from "@delegate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RESEARCH_STEP, scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { defineTool } from "../tools/registry";
import { runAgentLoop } from "./loop";
import { repairToolCall } from "./tool-args";

function fetchTool(seen: unknown[]) {
  return defineTool({
    name: "fetch_page",
    description: "Fetch a page.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ url: z.url(), maxChars: z.number().int().positive().optional() }),
    targetDomain: (input) => new URL(input.url).hostname,
    summariseArgs: (input) => input.url,
    execute: (input) => {
      seen.push(input);
      return Promise.resolve({ summary: "fetched", forModel: "page text" });
    },
  });
}

const call = (argumentsJson: string) => ({ id: "call_1", name: "fetch_page", argumentsJson });

describe("repairToolCall", () => {
  const tools = [fetchTool([])];

  it("returns valid arguments and unknown tools unchanged", () => {
    const valid = call('{"url":"https://acme.example/pricing"}');
    expect(repairToolCall(tools, valid)).toBe(valid);
    const unknown = { ...call("{'url': 1}"), name: "other" };
    expect(repairToolCall(tools, unknown)).toBe(unknown);
    const empty = call("");
    expect(repairToolCall(tools, empty)).toBe(empty);
  });

  it.each([
    "{'url': 'https://acme.example/pricing', 'maxChars': '4000',}",
    '```json\n{"url": "https://acme.example/pricing", "maxChars": 4000}\n```',
    '{"arguments": {"url": "https://acme.example/pricing", "maxChars": "4000"}}',
  ])("repairs %s", (raw) => {
    expect(JSON.parse(repairToolCall(tools, call(raw)).argumentsJson)).toEqual({
      url: "https://acme.example/pricing",
      maxChars: 4000,
    });
  });

  it("never completes arguments that were cut off", () => {
    const cut = call('{"url": "https://acme.example/pri');
    expect(repairToolCall(tools, cut)).toBe(cut);
  });

  it("hands readable arguments of the wrong shape on as JSON, for the schema refusal", () => {
    expect(repairToolCall(tools, call("{'link': 'https://acme.example'}")).argumentsJson).toBe(
      '{"link":"https://acme.example"}',
    );
  });
});

describe("runAgentLoop with malformed tool arguments", () => {
  const options = (run: ReturnType<typeof testRun>["ctx"], seen: unknown[]) => ({
    run,
    step: RESEARCH_STEP,
    agentId: "researcher_1",
    role: "worker" as const,
    system: "Research.",
    tools: [fetchTool(seen)],
    messages: [{ role: "user" as const, content: "Go" }],
    maxIterations: 3,
    maxTokens: 200,
  });
  const toolCallTurn = (argumentsJson: string) => [
    { type: "tool_call_complete" as const, call: call(argumentsJson) },
    { type: "stop" as const, reason: "tool_use" as const },
  ];

  it("runs a repaired call through the policy check and echoes valid JSON back to the model", async () => {
    const provider = scriptedProvider("fake", [
      toolCallTurn("{'url': 'https://acme.example/pricing',}"),
      textTurn("done"),
    ]);
    const { ctx, events } = testRun({ provider, policies: [defaultPolicy] });
    const seen: unknown[] = [];
    const result = await runAgentLoop(options(ctx, seen));
    expect(result.outcome).toBe("end");
    expect(seen).toEqual([{ url: "https://acme.example/pricing" }]);
    expect(events.filter((event) => event.type === "policy.decided")).toHaveLength(1);
    const echoed = provider.requests[1]?.messages[1];
    expect(echoed).toMatchObject({
      role: "assistant",
      toolCalls: [{ argumentsJson: '{"url":"https://acme.example/pricing"}' }],
    });
  });

  it("still refuses arguments that were cut off, without running the tool", async () => {
    const provider = scriptedProvider("fake", [
      toolCallTurn('{"url": "https://acme.example/pri'),
      textTurn("done"),
    ]);
    const { ctx, events } = testRun({ provider });
    const seen: unknown[] = [];
    const result = await runAgentLoop(options(ctx, seen));
    expect(seen).toEqual([]);
    expect(result.toolCalls[0]).toMatchObject({ ok: false, decision: "deny" });
    expect(events.find((event) => event.type === "policy.decided")).toMatchObject({
      payload: { decision: "deny", reason: "Tool arguments are not valid JSON" },
    });
  });
});
