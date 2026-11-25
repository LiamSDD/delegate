import { BudgetExceededError } from "../budget";
import { type ModelRole } from "../events";
import { type ChatMessage, type ToolDefinition } from "../providers/types";
import { NoModelAvailableError } from "../router";
import {
  denyToolCall,
  executeToolCall,
  type RegisteredTool,
  type StepGrant,
  type ToolCallOutcome,
} from "../tools/registry";
import { RunAbortedError, type RunContext } from "./context";
import { TextCoalescer } from "./emitter";
import { ModelStreamError, callModel, type ModelCallResult } from "./model-call";
import { repairToolCall } from "./tool-args";

export const AGENT_MESSAGE_INTERVAL_MS = 250;

export type LoopOutcome =
  | "end"
  | "max_iterations"
  | "max_tokens"
  | "refusal"
  | "error"
  | "aborted"
  | "budget_exceeded"
  | "no_model"
  | "deadline";

export interface AgentLoopOptions {
  run: RunContext;
  step: StepGrant;
  agentId: string;
  role: ModelRole;
  system: string;
  tools: readonly RegisteredTool[];
  messages: ChatMessage[];
  maxIterations: number;
  maxTokens: number;
  maxToolCalls?: number;
  temperature?: number;
  deadlineAt?: number;
}

export interface AgentLoopResult {
  outcome: LoopOutcome;
  text: string;
  messages: ChatMessage[];
  iterations: number;
  toolCalls: ToolCallOutcome[];
  detail?: string;
}

function isAborted(run: RunContext): boolean {
  return run.signal?.aborted === true;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { run, step, agentId } = options;
  const messages = [...options.messages];
  const toolDefinitions: ToolDefinition[] = options.tools.map((tool) => tool.definition);
  const toolCalls: ToolCallOutcome[] = [];
  let text = "";
  let iterations = 0;
  const finish = (outcome: LoopOutcome, detail?: string): AgentLoopResult => ({
    outcome,
    text,
    messages,
    iterations,
    toolCalls,
    ...(detail === undefined ? {} : { detail }),
  });

  while (iterations < options.maxIterations) {
    if (isAborted(run)) return finish("aborted");
    if (options.deadlineAt !== undefined && run.now().getTime() >= options.deadlineAt)
      return finish("deadline");
    iterations += 1;

    const coalescer = new TextCoalescer(
      (chunk) => {
        run.emitter.queue({
          runId: run.runId,
          type: "agent.message",
          stepId: step.id,
          agentId,
          payload: { text: chunk },
        });
      },
      () => run.now().getTime(),
      AGENT_MESSAGE_INTERVAL_MS,
    );

    let response: ModelCallResult;
    try {
      response = await callModel(run, {
        role: options.role,
        stepId: step.id,
        request: {
          system: options.system,
          messages: [...messages],
          maxTokens: options.maxTokens,
          ...(toolDefinitions.length === 0 ? {} : { tools: toolDefinitions }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        },
        onText: (delta) => {
          coalescer.push(delta);
        },
        onStreamEnd: () => {
          coalescer.flush();
        },
      });
    } catch (error) {
      coalescer.flush();
      if (error instanceof RunAbortedError) return finish("aborted");
      if (error instanceof BudgetExceededError) return finish("budget_exceeded", error.message);
      if (error instanceof NoModelAvailableError) return finish("no_model", error.message);
      if (error instanceof ModelStreamError) return finish("error", error.message);
      throw error;
    }

    text = response.text;
    const requested = response.toolCalls.map((call) => repairToolCall(options.tools, call));
    messages.push({
      role: "assistant",
      content: response.text,
      ...(requested.length === 0 ? {} : { toolCalls: requested }),
      ...(response.reasoning === "" ? {} : { reasoning: response.reasoning }),
    });
    if (isAborted(run)) return finish("aborted");

    switch (response.stopReason) {
      case "pause_turn":
        continue;
      case "max_tokens":
        return finish("max_tokens");
      case "refusal":
        return finish("refusal");
      case "error":
        return finish("error", response.stopDetail);
      case "end":
      case "tool_use":
        if (requested.length === 0) return finish("end");
    }

    const caller = {
      actor: { type: "agent" as const, id: agentId },
      provider: { id: response.provider, terms: response.entry.provider.terms },
    };
    for (const call of requested) {
      const overCap =
        options.maxToolCalls !== undefined && toolCalls.length >= options.maxToolCalls;
      const outcome = overCap
        ? await denyToolCall(
            run,
            step,
            call,
            `Tool call limit of ${options.maxToolCalls ?? 0} for this agent reached`,
          )
        : await executeToolCall(run, step, options.tools, call, caller);
      toolCalls.push(outcome);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: outcome.content,
        ...(outcome.ok ? {} : { isError: true }),
      });
    }
  }
  return finish("max_iterations");
}
