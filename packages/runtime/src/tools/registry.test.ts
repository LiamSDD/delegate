import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RESEARCH_STEP, scriptedProvider, testRun } from "../testing/fakes";
import { defineTool, executeToolCall, type ToolCaller } from "./registry";

const caller: ToolCaller = {
  actor: { type: "agent", id: "agent_1" },
  provider: { id: "fake", terms: "public-demo-ok" },
};

function fetchTool(onExecute: (url: string) => void, fail = false) {
  return defineTool({
    name: "fetch_page",
    description: "Fetch one page",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ url: z.string() }),
    targetDomain: (input) => {
      try {
        return new URL(input.url).hostname;
      } catch {
        return undefined;
      }
    },
    summariseArgs: (input) => `GET ${input.url}`,
    execute: (input) => {
      onExecute(input.url);
      if (fail) return Promise.reject(new Error("connection reset"));
      return Promise.resolve({
        summary: `Fetched ${input.url}`,
        forModel: "x".repeat(20_000),
        artifact: { kind: "source-snapshot", title: "Snapshot", content: { url: input.url } },
      });
    },
  });
}

const writeTool = defineTool({
  name: "send_email",
  description: "Send email",
  capability: CAPABILITIES.messageSend,
  inputSchema: z.object({ to: z.string() }),
  targetDomain: () => undefined,
  summariseArgs: (input) => `to ${input.to}`,
  execute: () => Promise.resolve({ summary: "sent", forModel: "sent" }),
});

function setup() {
  return testRun({ provider: scriptedProvider("fake", []) });
}

describe("defineTool", () => {
  it("exposes a provider-neutral definition", () => {
    const tool = fetchTool(() => undefined);
    expect(tool.definition.name).toBe("fetch_page");
    expect(tool.capability).toBe("web.fetch");
  });
});

describe("executeToolCall", () => {
  it("runs an allowed call and emits policy, call, artifact and result in order", async () => {
    const { ctx, events } = setup();
    const executed: string[] = [];
    const result = await executeToolCall(
      ctx,
      RESEARCH_STEP,
      [fetchTool((url) => executed.push(url))],
      { name: "fetch_page", argumentsJson: '{"url":"https://acme.example/about"}' },
      caller,
    );
    expect(executed).toEqual(["https://acme.example/about"]);
    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(8_000);
    expect(events.map((event) => event.type)).toEqual([
      "policy.decided",
      "tool.called",
      "artifact.created",
      "tool.result",
    ]);
    const [decided, called, artifact, toolResult] = events;
    expect(decided).toMatchObject({
      stepId: "s1",
      payload: { decision: "allow", tool: "fetch_page" },
    });
    expect(called).toMatchObject({
      payload: { capability: "web.fetch", argsSummary: "GET https://acme.example/about" },
    });
    expect(artifact).toMatchObject({
      payload: {
        kind: "source-snapshot",
        version: 1,
        content: { url: "https://acme.example/about" },
      },
    });
    const artifactId = artifact?.type === "artifact.created" ? artifact.payload.artifactId : "";
    expect(toolResult).toMatchObject({
      payload: { ok: true, artifactId, summary: "Fetched https://acme.example/about" },
    });
  });

  it("denies a capability the step was not granted, before execution", async () => {
    const { ctx, events } = setup();
    const result = await executeToolCall(
      ctx,
      RESEARCH_STEP,
      [writeTool],
      { name: "send_email", argumentsJson: '{"to":"ceo@acme.example"}' },
      caller,
    );
    expect(result).toMatchObject({ ok: false, decision: "deny" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "policy.decided",
      payload: { decision: "deny", policyId: "runtime", tool: "send_email" },
    });
  });

  it("denies a tool the step does not offer", async () => {
    const { ctx, events } = setup();
    const result = await executeToolCall(
      ctx,
      RESEARCH_STEP,
      [],
      { name: "rm_rf", argumentsJson: "{}" },
      caller,
    );
    expect(result.ok).toBe(false);
    expect(events[0]).toMatchObject({ payload: { decision: "deny", tool: "rm_rf" } });
  });

  it("denies arguments that do not match the schema", async () => {
    const { ctx, events } = setup();
    const executed: string[] = [];
    const result = await executeToolCall(
      ctx,
      RESEARCH_STEP,
      [fetchTool((url) => executed.push(url))],
      { name: "fetch_page", argumentsJson: '{"href":1' },
      caller,
    );
    expect(result.ok).toBe(false);
    expect(executed).toEqual([]);
    expect(events[0]).toMatchObject({ payload: { decision: "deny", policyId: "runtime" } });
  });

  it("lets the policy engine deny metadata and private targets without executing", async () => {
    const { ctx, events } = setup();
    const executed: string[] = [];
    const result = await executeToolCall(
      ctx,
      RESEARCH_STEP,
      [fetchTool((url) => executed.push(url))],
      { name: "fetch_page", argumentsJson: '{"url":"http://169.254.169.254/latest/meta-data"}' },
      caller,
    );
    expect(result).toMatchObject({ ok: false, decision: "deny" });
    expect(executed).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { decision: "deny", policyId: "builtin" } });
    expect(result.content).toMatch(/denied/i);
  });

  it("reports a failing tool as a tool error without crashing the run", async () => {
    const { ctx, events } = setup();
    const result = await executeToolCall(
      ctx,
      RESEARCH_STEP,
      [fetchTool(() => undefined, true)],
      { name: "fetch_page", argumentsJson: '{"url":"https://acme.example/"}' },
      caller,
    );
    expect(result.ok).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "tool.result",
      payload: { ok: false, error: "connection reset" },
    });
  });
});
