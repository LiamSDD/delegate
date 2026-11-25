import { type DataClassification, type Policy } from "@delegate/policy";
import {
  Budget,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelsConfig,
  type RunEventDraft,
} from "@delegate/runtime";
import {
  createRunContext,
  createRunEmitter,
  type RunContext,
  type ToolApprovalGate,
} from "@delegate/runtime/security";
import {
  TEST_MODELS_CONFIG,
  TEST_USAGE,
  scriptedProvider,
  textTurn,
  type ScriptedProvider,
} from "@delegate/runtime/testing";

import { type ScriptedToolCall } from "./schema";

export interface WorkerTurn {
  text?: string | undefined;
  calls: readonly ScriptedToolCall[];
}

export interface CompromisedScript {
  planner?: unknown;
  reader?: (userPrompt: string) => unknown;
  worker?: readonly WorkerTurn[];
}

export const MODEL_FOR_ROLE = {
  planner: "fake-planner",
  worker: "fake-worker",
  fast: "fake-fast",
} as const;

export function userText(request: ModelRequest): string {
  return request.messages
    .map((message) => (message.role === "user" ? message.content : ""))
    .join("\n");
}

function workerTurn(turn: WorkerTurn, index: number): ModelStreamEvent[] {
  return [
    ...(turn.text === undefined ? [] : [{ type: "text_delta" as const, text: turn.text }]),
    ...turn.calls.map((call, position) => ({
      type: "tool_call_complete" as const,
      call: {
        id: `call_${index}_${position}`,
        name: call.name,
        argumentsJson: JSON.stringify(call.args ?? {}),
      },
    })),
    { type: "usage", usage: TEST_USAGE },
    { type: "stop", reason: "tool_use" },
  ];
}

export function compromisedModel(script: CompromisedScript): ScriptedProvider {
  let workerCalls = 0;
  return scriptedProvider("fake", (request) => {
    if (request.model === MODEL_FOR_ROLE.planner)
      return textTurn(JSON.stringify(script.planner ?? {}));
    if (request.model === MODEL_FOR_ROLE.fast)
      return textTurn(JSON.stringify(script.reader?.(userText(request)) ?? { sources: [] }));
    const index = workerCalls;
    workerCalls += 1;
    const turn = script.worker?.[index];
    return turn === undefined ? textTurn("Done.") : workerTurn(turn, index);
  });
}

export function requestsFor(provider: ScriptedProvider, role: keyof typeof MODEL_FOR_ROLE) {
  return provider.requests.filter((request) => request.model === MODEL_FOR_ROLE[role]);
}

const REDTEAM_MODELS_CONFIG: ModelsConfig = {
  ...TEST_MODELS_CONFIG,
  providers: TEST_MODELS_CONFIG.providers.map((provider) => ({
    ...provider,
    maxClassification: "restricted",
  })),
};

export interface RedteamRun {
  ctx: RunContext;
  events: RunEventDraft[];
}

export function redteamRun(
  provider: ScriptedProvider,
  options: {
    policies: Policy[];
    classification?: DataClassification | undefined;
    approvals?: ToolApprovalGate;
  },
): RedteamRun {
  const events: RunEventDraft[] = [];
  const ctx = createRunContext({
    runId: "redteam",
    workspaceId: "ws_redteam",
    audience: "public-demo",
    classification: options.classification ?? "public",
    config: REDTEAM_MODELS_CONFIG,
    env: {},
    emitter: createRunEmitter((event) => {
      events.push(event);
      return Promise.resolve();
    }),
    budget: new Budget({ run: { maxTokens: 10_000_000, maxMicroUsd: 0 }, steps: {} }),
    policies: options.policies,
    createProvider: () => provider,
    now: () => new Date("2026-11-25T10:00:00Z"),
    sleep: () => Promise.resolve(),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
  });
  return { ctx, events };
}
