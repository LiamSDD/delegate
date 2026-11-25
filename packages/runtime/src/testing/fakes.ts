import { CAPABILITIES, defaultPolicy, type Policy } from "@delegate/policy";

import { createRunContext, type RunContext } from "../agent/context";
import { createRunEmitter } from "../agent/emitter";
import { Budget } from "../budget";
import { type RunEventDraft } from "../events";
import { parseModelsConfig, type ModelsConfig } from "../models";
import { type ToolApprovalGate } from "../tools/approvals";
import {
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type TokenUsage,
} from "../providers/types";

export type ScriptedTurn = ModelStreamEvent[] | ((request: ModelRequest) => ModelStreamEvent[]);

export interface ScriptedProvider extends ModelProvider {
  requests: ModelRequest[];
}

export const TEST_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 40,
  cacheWriteTokens: 0,
};

export function textTurn(text: string, usage: TokenUsage = TEST_USAGE): ModelStreamEvent[] {
  return [
    { type: "reasoning_delta", text: "private chain of thought" },
    ...(text
      .match(/[\s\S]{1,7}/g)
      ?.map((piece) => ({ type: "text_delta" as const, text: piece })) ?? []),
    { type: "usage", usage },
    { type: "stop", reason: "end" },
  ];
}

export function toolTurn(
  calls: { id: string; name: string; args: unknown }[],
  usage: TokenUsage = TEST_USAGE,
): ModelStreamEvent[] {
  return [
    ...calls.map((call) => ({
      type: "tool_call_complete" as const,
      call: { id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) },
    })),
    { type: "usage", usage },
    { type: "stop", reason: "tool_use" },
  ];
}

export function scriptedProvider(
  id: string,
  turns: ScriptedTurn[] | ((request: ModelRequest, index: number) => ModelStreamEvent[]),
): ScriptedProvider {
  const requests: ModelRequest[] = [];
  return {
    id,
    requests,
    async *stream(request) {
      const index = requests.length;
      requests.push(request);
      await Promise.resolve();
      const turn = typeof turns === "function" ? turns(request, index) : turns[index];
      if (turn === undefined) throw new Error(`No scripted turn ${index} for ${id}`);
      yield* typeof turn === "function" ? turn(request) : turn;
    },
  };
}

export const TEST_MODELS_CONFIG: ModelsConfig = parseModelsConfig({
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
      { provider: "fake", model: "fake-planner", contextWindow: 32000, supportsTools: true },
    ],
    worker: [{ provider: "fake", model: "fake-worker", contextWindow: 32000, supportsTools: true }],
    fast: [{ provider: "fake", model: "fake-fast", contextWindow: 32000, supportsTools: true }],
  },
});

export interface TestRun {
  ctx: RunContext;
  events: RunEventDraft[];
  sleeps: number[];
}

export function testRun(options: {
  provider: ModelProvider;
  config?: ModelsConfig;
  policies?: Policy[];
  maxTokens?: number;
  signal?: AbortSignal;
  clock?: () => number;
  approvals?: ToolApprovalGate;
}): TestRun {
  const events: RunEventDraft[] = [];
  const sleeps: number[] = [];
  const clock = options.clock ?? (() => Date.parse("2026-11-24T10:00:00Z"));
  const ctx = createRunContext({
    runId: "run_1",
    workspaceId: "ws_1",
    audience: "public-demo",
    classification: "public",
    config: options.config ?? TEST_MODELS_CONFIG,
    env: {},
    emitter: createRunEmitter((event) => {
      events.push(event);
      return Promise.resolve();
    }),
    budget: new Budget({
      run: { maxTokens: options.maxTokens ?? 1_000_000, maxMicroUsd: 0 },
      steps: {},
    }),
    policies: options.policies ?? [defaultPolicy],
    createProvider: () => options.provider,
    now: () => new Date(clock()),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
  });
  return { ctx, events, sleeps };
}

export { createFixtureRepo } from "./fixture-repo";

export const RESEARCH_STEP = {
  id: "s1",
  capabilities: [CAPABILITIES.webFetch] as string[],
};

export { repoTarGz, tarEntries, type TarFixtureEntry } from "./tarball";
export * from "./autopilot";
