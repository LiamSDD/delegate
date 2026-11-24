import { evaluate, type DecisionKind, type ProviderTerms } from "@delegate/policy";
import { type z } from "zod";

import { type RunContext } from "../agent/context";
import { type Actor } from "../events";
import { type ToolDefinition } from "../providers/types";

export const TOOL_SUMMARY_MAX_CHARS = 280;
export const TOOL_RESULT_FOR_MODEL_MAX_CHARS = 8_000;
const TOOL_ERROR_MAX_CHARS = 300;
const RUNTIME_POLICY_ID = "runtime";

export interface ToolArtifact {
  kind: string;
  title: string;
  content: unknown;
}

export interface ToolOutcome {
  summary: string;
  forModel: string;
  artifact?: ToolArtifact;
}

export interface ToolExecution {
  run: RunContext;
  stepId: string;
  toolCallId: string;
}

export interface ToolSpec<I> {
  name: string;
  description: string;
  capability: string;
  inputSchema: z.ZodType<I>;
  targetDomain: (input: I) => string | undefined;
  summariseArgs: (input: I) => string;
  execute: (input: I, execution: ToolExecution) => Promise<ToolOutcome>;
}

export interface PreparedCall {
  targetDomain: string | undefined;
  argsSummary: string;
  run: (execution: ToolExecution) => Promise<ToolOutcome>;
}

export interface RegisteredTool {
  name: string;
  capability: string;
  definition: ToolDefinition;
  prepare: (
    rawArguments: unknown,
  ) => { ok: true; call: PreparedCall } | { ok: false; error: string };
}

export function defineTool<I>(spec: ToolSpec<I>): RegisteredTool {
  return {
    name: spec.name,
    capability: spec.capability,
    definition: { name: spec.name, description: spec.description, inputSchema: spec.inputSchema },
    prepare: (rawArguments) => {
      const parsed = spec.inputSchema.safeParse(rawArguments);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return { ok: false, error: issues };
      }
      const input = parsed.data;
      return {
        ok: true,
        call: {
          targetDomain: spec.targetDomain(input),
          argsSummary: spec.summariseArgs(input).slice(0, TOOL_SUMMARY_MAX_CHARS),
          run: (execution) => spec.execute(input, execution),
        },
      };
    },
  };
}

export interface StepGrant {
  id: string;
  capabilities: readonly string[];
}

export interface ToolCaller {
  actor: Actor;
  provider?: { id: string; terms: ProviderTerms };
}

export interface ToolCallOutcome {
  ok: boolean;
  toolCallId: string;
  decision: DecisionKind;
  content: string;
  artifactId?: string;
  outcome?: ToolOutcome;
}

export async function denyToolCall(
  run: RunContext,
  step: StepGrant,
  call: { name: string },
  reason: string,
): Promise<ToolCallOutcome> {
  const toolCallId = run.nextId("tc");
  await run.emitter.emit({
    runId: run.runId,
    type: "policy.decided",
    stepId: step.id,
    payload: {
      toolCallId,
      tool: call.name,
      decision: "deny",
      policyId: RUNTIME_POLICY_ID,
      reason: cap(reason, 500),
    },
  });
  return { ok: false, toolCallId, decision: "deny", content: `Denied: ${reason}` };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseArguments(argumentsJson: string): { ok: true; value: unknown } | { ok: false } {
  if (argumentsJson.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(argumentsJson) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function executeToolCall(
  run: RunContext,
  step: StepGrant,
  tools: readonly RegisteredTool[],
  call: { name: string; argumentsJson: string },
  caller: ToolCaller,
): Promise<ToolCallOutcome> {
  const toolCallId = run.nextId("tc");
  const decide = async (decision: DecisionKind, policyId: string, reason: string) => {
    await run.emitter.emit({
      runId: run.runId,
      type: "policy.decided",
      stepId: step.id,
      payload: { toolCallId, tool: call.name, decision, policyId, reason: cap(reason, 500) },
    });
  };
  const refuse = async (policyId: string, reason: string): Promise<ToolCallOutcome> => {
    await decide("deny", policyId, reason);
    return { ok: false, toolCallId, decision: "deny", content: `Denied: ${reason}` };
  };

  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined)
    return refuse(RUNTIME_POLICY_ID, `Tool ${call.name} is not available to step ${step.id}`);
  if (!step.capabilities.includes(tool.capability)) {
    return refuse(
      RUNTIME_POLICY_ID,
      `Step ${step.id} was not granted capability ${tool.capability}`,
    );
  }
  const parsedArguments = parseArguments(call.argumentsJson);
  if (!parsedArguments.ok) return refuse(RUNTIME_POLICY_ID, "Tool arguments are not valid JSON");
  const prepared = tool.prepare(parsedArguments.value);
  if (!prepared.ok)
    return refuse(RUNTIME_POLICY_ID, `Tool arguments do not match the schema: ${prepared.error}`);

  const decision = evaluate(run.policies, {
    workspaceId: run.workspaceId,
    runId: run.runId,
    stepId: step.id,
    actor: caller.actor,
    tool: tool.name,
    capability: tool.capability,
    grantedCapabilities: [...step.capabilities],
    argsSummary: prepared.call.argsSummary,
    ...(prepared.call.targetDomain === undefined
      ? {}
      : { targetDomain: prepared.call.targetDomain }),
    dataClassification: run.classification,
    ...(caller.provider === undefined ? {} : { provider: caller.provider }),
    estimatedCostMicroUsd: 0,
    spentRunMicroUsd: run.budget.spent().microUsd,
    spentDayMicroUsd: 0,
  });
  await decide(decision.decision, decision.policyId, decision.reason);
  if (decision.decision !== "allow") {
    const verb =
      decision.decision === "deny"
        ? "Denied by policy"
        : "Requires human approval, which is not available in this run";
    return {
      ok: false,
      toolCallId,
      decision: decision.decision,
      content: `${verb}: ${decision.reason}`,
    };
  }

  await run.emitter.emit({
    runId: run.runId,
    type: "tool.called",
    stepId: step.id,
    payload: {
      toolCallId,
      tool: tool.name,
      capability: tool.capability,
      argsSummary: prepared.call.argsSummary,
    },
  });
  const startedAt = run.now().getTime();
  try {
    const outcome = await prepared.call.run({ run, stepId: step.id, toolCallId });
    let artifactId: string | undefined;
    if (outcome.artifact !== undefined) {
      artifactId = crypto.randomUUID();
      await run.emitter.emit({
        runId: run.runId,
        type: "artifact.created",
        stepId: step.id,
        payload: {
          artifactId,
          kind: outcome.artifact.kind,
          title: cap(outcome.artifact.title, 200),
          version: 1,
          content: outcome.artifact.content,
        },
      });
    }
    await run.emitter.emit({
      runId: run.runId,
      type: "tool.result",
      stepId: step.id,
      payload: {
        toolCallId,
        tool: tool.name,
        ok: true,
        summary: cap(outcome.summary, TOOL_SUMMARY_MAX_CHARS),
        durationMs: Math.max(0, run.now().getTime() - startedAt),
        ...(artifactId === undefined ? {} : { artifactId }),
      },
    });
    return {
      ok: true,
      toolCallId,
      decision: "allow",
      content: cap(outcome.forModel, TOOL_RESULT_FOR_MODEL_MAX_CHARS),
      ...(artifactId === undefined ? {} : { artifactId }),
      outcome,
    };
  } catch (error) {
    const message = cap(
      error instanceof Error ? error.message : "Tool failed",
      TOOL_ERROR_MAX_CHARS,
    );
    await run.emitter.emit({
      runId: run.runId,
      type: "tool.result",
      stepId: step.id,
      payload: {
        toolCallId,
        tool: tool.name,
        ok: false,
        summary: `${tool.name} failed`,
        durationMs: Math.max(0, run.now().getTime() - startedAt),
        error: message,
      },
    });
    return { ok: false, toolCallId, decision: "allow", content: `Tool error: ${message}` };
  }
}
