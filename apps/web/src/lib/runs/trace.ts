import type { RunEvent } from "@delegate/runtime";

export type SpanKind = "run" | "step" | "agent" | "model" | "tool" | "policy" | "critic";
export type SpanStatus = "ok" | "error" | "running" | "denied" | "flagged";

export interface SpanAttrs {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costMicroUsd?: number;
  role?: string;
  modelRole?: string;
  tool?: string;
  policyId?: string;
  decision?: string;
  severity?: string;
  category?: string;
  inferredStart?: boolean;
}

export interface TraceSpan {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  startMs: number;
  endMs: number;
  status: SpanStatus;
  depth: number;
  seq: number;
  attrs: SpanAttrs;
  input: string | null;
  output: string | null;
}

export interface Trace {
  startedAt: string | null;
  durationMs: number;
  spans: TraceSpan[];
}

const MAX_TEXT = 600;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export function buildTrace(events: readonly RunEvent[], now: number): Trace {
  const first = events[0];
  if (first?.type !== "run.created") return { startedAt: null, durationMs: 0, spans: [] };
  const t0 = Date.parse(first.at);
  const rel = (at: string) => Math.max(0, Date.parse(at) - t0);
  const nowMs = Math.max(0, now - t0);
  const spans = new Map<string, TraceSpan>();
  const children = new Map<string, string[]>();
  const add = (span: TraceSpan) => {
    spans.set(span.id, span);
    if (span.parentId !== null) {
      const list = children.get(span.parentId) ?? [];
      list.push(span.id);
      children.set(span.parentId, list);
    }
  };
  const runId = "run";
  const objectives = new Map<string, string>();
  const agentLast = new Map<string, number>();
  const agentMessages = new Map<string, string>();
  const toolSpans = new Map<string, string>();

  add({
    id: runId,
    parentId: null,
    kind: "run",
    name: first.payload.missionId,
    startMs: 0,
    endMs: nowMs,
    status: "running",
    depth: 0,
    seq: first.seq,
    attrs: {},
    input: typeof first.payload.input.url === "string" ? first.payload.input.url : null,
    output: null,
  });

  const parentOf = (event: RunEvent) => {
    if (event.agentId !== undefined && spans.has(`agent:${event.agentId}`))
      return `agent:${event.agentId}`;
    if (event.stepId !== undefined && spans.has(`step:${event.stepId}`))
      return `step:${event.stepId}`;
    return runId;
  };

  for (const event of events) {
    const at = rel(event.at);
    switch (event.type) {
      case "plan.proposed":
      case "plan.revised":
        for (const step of event.payload.steps) objectives.set(step.id, step.objective);
        break;
      case "step.started":
        add({
          id: `step:${event.stepId}`,
          parentId: runId,
          kind: "step",
          name: objectives.get(event.stepId) ?? event.stepId,
          startMs: at,
          endMs: nowMs,
          status: "running",
          depth: 1,
          seq: event.seq,
          attrs: {},
          input: null,
          output: null,
        });
        break;
      case "step.completed": {
        const span = spans.get(`step:${event.stepId}`);
        if (span !== undefined) {
          span.endMs = at;
          span.status = event.payload.outcome === "succeeded" ? "ok" : "error";
          span.output = clip(event.payload.summary);
          for (const childId of children.get(span.id) ?? []) {
            const child = spans.get(childId);
            if (child?.kind === "agent" && child.status === "running") {
              child.endMs = at;
              child.status = span.status;
            }
          }
        }
        break;
      }
      case "agent.spawned":
        add({
          id: `agent:${event.agentId}`,
          parentId: spans.has(`step:${event.stepId}`) ? `step:${event.stepId}` : runId,
          kind: "agent",
          name: `${event.payload.role} · ${event.agentId}`,
          startMs: at,
          endMs: nowMs,
          status: "running",
          depth: 0,
          seq: event.seq,
          attrs: { role: event.payload.role, modelRole: event.payload.modelRole },
          input: null,
          output: null,
        });
        agentLast.set(event.agentId, at);
        break;
      case "agent.message": {
        const text = (agentMessages.get(event.agentId) ?? "") + event.payload.text;
        agentMessages.set(event.agentId, text);
        const span = spans.get(`agent:${event.agentId}`);
        if (span !== undefined) span.output = clip(text);
        break;
      }
      case "tool.called": {
        const id = `tool:${event.payload.toolCallId}:${event.seq}`;
        toolSpans.set(event.payload.toolCallId, id);
        add({
          id,
          parentId: parentOf(event),
          kind: "tool",
          name: event.payload.tool,
          startMs: at,
          endMs: nowMs,
          status: "running",
          depth: 0,
          seq: event.seq,
          attrs: { tool: event.payload.tool },
          input: clip(event.payload.argsSummary),
          output: null,
        });
        break;
      }
      case "tool.result": {
        const span = spans.get(toolSpans.get(event.payload.toolCallId) ?? "");
        if (span !== undefined) {
          span.endMs = Math.max(span.startMs, at);
          span.status = event.payload.ok ? "ok" : "error";
          span.output = clip(event.payload.error ?? event.payload.summary);
        }
        break;
      }
      case "usage.updated": {
        const parentId = parentOf(event);
        const lastAgent = event.agentId === undefined ? undefined : agentLast.get(event.agentId);
        const parent = spans.get(parentId);
        const start = lastAgent ?? parent?.startMs ?? at;
        add({
          id: `model:${event.seq}`,
          parentId,
          kind: "model",
          name: `${event.payload.provider} · ${event.payload.model}`,
          startMs: Math.min(start, at),
          endMs: at,
          status: "ok",
          depth: 0,
          seq: event.seq,
          attrs: {
            provider: event.payload.provider,
            model: event.payload.model,
            inputTokens: event.payload.inputTokens,
            outputTokens: event.payload.outputTokens,
            cacheReadTokens: event.payload.cacheReadTokens,
            costMicroUsd: event.payload.costMicroUsd,
            inferredStart: true,
          },
          input: null,
          output: null,
        });
        break;
      }
      case "policy.decided":
        add({
          id: `policy:${event.seq}`,
          parentId: parentOf(event),
          kind: "policy",
          name: `${event.payload.decision} · ${event.payload.tool}`,
          startMs: at,
          endMs: at,
          status: event.payload.decision === "allow" ? "ok" : "denied",
          depth: 0,
          seq: event.seq,
          attrs: {
            tool: event.payload.tool,
            policyId: event.payload.policyId,
            decision: event.payload.decision,
          },
          input: null,
          output: clip(event.payload.reason),
        });
        break;
      case "critic.flagged":
        add({
          id: `critic:${event.seq}`,
          parentId: parentOf(event),
          kind: "critic",
          name: `critic · ${event.payload.category ?? "claim"}`,
          startMs: at,
          endMs: at,
          status: "flagged",
          depth: 0,
          seq: event.seq,
          attrs: {
            severity: event.payload.severity,
            ...(event.payload.category === undefined ? {} : { category: event.payload.category }),
          },
          input: clip(event.payload.claim),
          output: clip(event.payload.reason),
        });
        break;
      case "run.completed":
      case "run.failed": {
        const run = spans.get(runId);
        if (run !== undefined) {
          run.endMs = at;
          run.status = event.type === "run.completed" ? "ok" : "error";
          run.output = clip(
            event.type === "run.completed" ? event.payload.summary : event.payload.error.message,
          );
          for (const span of spans.values()) {
            if (span.status === "running") {
              span.endMs = at;
              span.status = run.status;
            }
          }
        }
        break;
      }
      default:
        break;
    }
    if (
      event.agentId !== undefined &&
      event.type !== "agent.spawned" &&
      agentLast.has(event.agentId)
    ) {
      agentLast.set(event.agentId, at);
    }
  }

  const ordered: TraceSpan[] = [];
  const visit = (id: string, depth: number) => {
    const span = spans.get(id);
    if (span === undefined) return;
    span.depth = depth;
    ordered.push(span);
    const kids = (children.get(id) ?? [])
      .map((childId) => spans.get(childId))
      .filter((child): child is TraceSpan => child !== undefined)
      .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
    for (const kid of kids) visit(kid.id, depth + 1);
  };
  visit(runId, 0);

  for (const span of [...ordered].reverse()) {
    if (span.kind === "model") continue;
    const totals = (children.get(span.id) ?? []).reduce(
      (sum, childId) => {
        const child = spans.get(childId);
        return {
          inputTokens: sum.inputTokens + (child?.attrs.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (child?.attrs.outputTokens ?? 0),
          cacheReadTokens: sum.cacheReadTokens + (child?.attrs.cacheReadTokens ?? 0),
          costMicroUsd: sum.costMicroUsd + (child?.attrs.costMicroUsd ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicroUsd: 0 },
    );
    if (totals.inputTokens + totals.outputTokens > 0) Object.assign(span.attrs, totals);
  }

  const run = spans.get(runId);
  return { startedAt: first.at, durationMs: run?.endMs ?? 0, spans: ordered };
}
