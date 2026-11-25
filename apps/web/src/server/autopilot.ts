import { randomUUID } from "node:crypto";

import { githubInstallations, mcpConnectors, withTenant } from "@delegate/db";
import {
  AUTOPILOT_CHILD_TOOL,
  AUTOPILOT_LIMITS,
  AUTOPILOT_MISSION_ID,
  AUTOPILOT_POLICY_ID,
  AUTOPILOT_REPORT_KIND,
  type AutopilotInput,
  AutopilotInputSchema,
  type AutopilotLink,
  type AutopilotMove,
  type AutopilotTier,
  autopilotChildPolicy,
  buildAutopilotReport,
  type ChildArtifacts,
  childArtifacts,
  type ChildRunState,
  type ChildStartedPayload,
  describeChildPolicy,
  foldRun,
  nextAutopilotMove,
  plannedNodes,
  type RunEvent,
  type RunState,
  type RunStatus,
  summariseChild,
  trackOf,
} from "@delegate/runtime";
import { count, eq } from "drizzle-orm";

import type { AppDatabase } from "./db";
import type { DurableDeps } from "./durable";
import { reviveOrSweep } from "./durable";
import { executeRun } from "./execute-run";
import { createDbLease } from "./leases";
import {
  appendEvent,
  createRunRecord,
  type EventDraft,
  getRunRecord,
  isTerminalEventType,
  missionInputOf,
  readAllEvents,
  RunAlreadyTerminalError,
  type RunContext,
  type RunRecord,
} from "./runs";
import type { GuestSession } from "./session";
import { readAutomation } from "./workspace-settings";

export const AUTOPILOT_STEP_LIMIT = 8;
export const AUTOPILOT_LEASE_ATTEMPTS = 3;
export const AUTOPILOT_LEASE_RETRY_MS = 1_000;

interface AdvanceState {
  running: Set<string>;
  again: Set<string>;
}

const holder = globalThis as typeof globalThis & { __delegateAutopilot?: AdvanceState };

function advancing(): AdvanceState {
  holder.__delegateAutopilot ??= { running: new Set(), again: new Set() };
  return holder.__delegateAutopilot;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalRecord(record: RunRecord): boolean {
  return record.lastEventType !== null && isTerminalEventType(record.lastEventType);
}

export function autopilotLinkOf(events: readonly RunEvent[]): AutopilotLink | undefined {
  const created = events[0];
  return created?.type === "run.created" ? created.payload.autopilot : undefined;
}

export async function workspaceTier(app: AppDatabase, ctx: RunContext): Promise<AutopilotTier> {
  try {
    const [installations, connectors] = await withTenant(app.db, ctx.userId, async (tx) =>
      Promise.all([
        tx
          .select({ total: count() })
          .from(githubInstallations)
          .where(eq(githubInstallations.workspaceId, ctx.workspaceId)),
        tx
          .select({ total: count() })
          .from(mcpConnectors)
          .where(eq(mcpConnectors.workspaceId, ctx.workspaceId)),
      ]),
    );
    return (installations[0]?.total ?? 0) + (connectors[0]?.total ?? 0) > 0 ? "connected" : "guest";
  } catch {
    return "guest";
  }
}

export async function createAutopilotRun(
  app: AppDatabase,
  session: GuestSession,
  input: AutopilotInput,
  deps: DurableDeps,
): Promise<string> {
  const parsed = AutopilotInputSchema.parse(input);
  const { runId } = await createRunRecord(app, session, {
    missionId: AUTOPILOT_MISSION_ID,
    input: parsed,
    execution: deps.runner().execution,
  });
  deps.schedule(() => advanceAutopilot(app, session.userId, runId, deps));
  return runId;
}

export async function advanceAutopilot(
  app: AppDatabase,
  userId: string,
  parentRunId: string,
  deps: DurableDeps,
): Promise<void> {
  const state = advancing();
  if (state.running.has(parentRunId)) {
    state.again.add(parentRunId);
    return;
  }
  state.running.add(parentRunId);
  try {
    do {
      state.again.delete(parentRunId);
      await advanceOnce(app, userId, parentRunId, deps);
    } while (state.again.has(parentRunId));
  } catch (error: unknown) {
    console.error(
      "autopilot advance failed",
      parentRunId,
      error instanceof Error ? error.message.slice(0, 200) : "unknown",
    );
  } finally {
    state.running.delete(parentRunId);
    state.again.delete(parentRunId);
  }
}

async function advanceOnce(
  app: AppDatabase,
  userId: string,
  parentRunId: string,
  deps: DurableDeps,
): Promise<void> {
  for (let attempt = 0; attempt < AUTOPILOT_LEASE_ATTEMPTS; attempt += 1) {
    const record = await getRunRecord(app, userId, parentRunId);
    if (record?.mission !== AUTOPILOT_MISSION_ID || isTerminalRecord(record)) return;
    const ctx = { runId: record.id, workspaceId: record.workspaceId, userId };
    const lease = createDbLease(app, ctx);
    if (await lease.acquire()) {
      try {
        await step(app, ctx, record, deps);
      } finally {
        await lease.release();
      }
      return;
    }
    await sleep(AUTOPILOT_LEASE_RETRY_MS);
  }
}

async function append(app: AppDatabase, ctx: RunContext, draft: EventDraft): Promise<boolean> {
  try {
    await appendEvent(app, ctx, draft);
    return true;
  } catch (error: unknown) {
    if (error instanceof RunAlreadyTerminalError) return false;
    throw error;
  }
}

function tokensOf(record: RunRecord): number {
  return record.totals.inputTokens + record.totals.outputTokens;
}

async function step(
  app: AppDatabase,
  ctx: RunContext,
  record: RunRecord,
  deps: DurableDeps,
): Promise<void> {
  const parsedInput = AutopilotInputSchema.safeParse(missionInputOf(record.input));
  for (let round = 0; round < AUTOPILOT_STEP_LIMIT; round += 1) {
    const events = await readAllEvents(app, ctx.userId, ctx.runId);
    let state: RunState;
    try {
      state = foldRun(events);
    } catch (error: unknown) {
      await append(app, ctx, {
        type: "run.failed",
        payload: {
          error: {
            code: "autopilot_log_invalid",
            message: `The Autopilot log could not be folded: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
          },
        },
      });
      return;
    }
    if (state.status === "completed" || state.status === "failed") return;
    if (!parsedInput.success) {
      await append(app, ctx, {
        type: "run.failed",
        payload: { error: { code: "invalid_input", message: "The Autopilot input is not valid." } },
      });
      return;
    }
    const now = deps.now?.() ?? new Date();
    const elapsedMs = now.getTime() - record.createdAt.getTime();
    const open = state.children.find((child) => child.outcome === undefined);
    if (open !== undefined) {
      const settled = await settleChild(app, ctx, open, elapsedMs, deps);
      if (!settled) return;
      continue;
    }
    const move = await decide(app, ctx.userId, state, parsedInput.data, elapsedMs, deps);
    if (move.kind === "finish") {
      await finish(app, ctx, state, parsedInput.data, move, elapsedMs, now);
      return;
    }
    const quota = deps.guestLimiter.take(ctx.userId);
    if (!quota.ok) {
      await finish(
        app,
        ctx,
        state,
        parsedInput.data,
        {
          kind: "finish",
          status: "stopped",
          track: move.track,
          stop: {
            reason: "quota",
            message: `Stopped before ${move.node.label}: the hourly run quota for this workspace is used up (child runs count against it). Start the next step by hand when the quota resets.`,
          },
        },
        elapsedMs,
        now,
      );
      return;
    }
    await startChild(app, ctx, move, deps);
    return;
  }
}

async function settleChild(
  app: AppDatabase,
  ctx: RunContext,
  open: ChildRunState,
  elapsedMs: number,
  deps: DurableDeps,
): Promise<boolean> {
  const child = await getRunRecord(app, ctx.userId, open.childRunId);
  if (child === null) {
    await launchChild(app, ctx, open, deps);
    return false;
  }
  if (!isTerminalRecord(child)) {
    if (elapsedMs >= AUTOPILOT_LIMITS.maxWallMs) {
      await append(
        app,
        { runId: child.id, workspaceId: child.workspaceId, userId: ctx.userId },
        {
          type: "run.failed",
          payload: {
            error: {
              code: "autopilot_wall_time",
              message: `Cancelled: the ${String(Math.round(AUTOPILOT_LIMITS.maxWallMs / 60_000))}-minute Autopilot time limit was reached.`,
            },
          },
        },
      );
      deps.registry.abort(child.id, "autopilot wall time");
      return true;
    }
    await reviveOrSweep(app, ctx.userId, child, deps);
    return false;
  }
  const childEvents = await readAllEvents(app, ctx.userId, child.id);
  return append(app, ctx, {
    type: "child.completed",
    payload: {
      childRunId: open.childRunId,
      nodeId: open.nodeId,
      missionId: open.missionId,
      outcome: summariseChild(open.missionId, open.childRunId, childEvents),
      tokens: tokensOf(child),
    },
  });
}

async function decide(
  app: AppDatabase,
  userId: string,
  state: RunState,
  input: AutopilotInput,
  elapsedMs: number,
  deps: DurableDeps,
): Promise<AutopilotMove> {
  const needed = new Set(
    [state.children[0], state.children.at(-1)].flatMap((child) =>
      child === undefined ? [] : [child.childRunId],
    ),
  );
  const artifacts = new Map<string, ChildArtifacts>();
  for (const runId of needed)
    artifacts.set(runId, childArtifacts(await readAllEvents(app, userId, runId)));
  return nextAutopilotMove({
    input,
    children: state.children,
    artifacts: (runId) => artifacts.get(runId),
    tokens: state.children.reduce((sum, child) => sum + (child.tokens ?? 0), 0),
    elapsedMs,
    limits: { ...AUTOPILOT_LIMITS },
    shipAvailable: deps.shipEnabled === true && deps.runner().execution === "live",
  });
}

async function startChild(
  app: AppDatabase,
  ctx: RunContext,
  move: Extract<AutopilotMove, { kind: "start" }>,
  deps: DurableDeps,
): Promise<void> {
  const tier = await workspaceTier(app, ctx);
  const automation = await readAutomation(app, ctx);
  const policy = autopilotChildPolicy(tier, move.node.missionId, automation.autoApprovePlans);
  const started: ChildStartedPayload = {
    childRunId: randomUUID(),
    nodeId: move.node.nodeId,
    missionId: move.node.missionId,
    label: move.node.label,
    input: move.input,
    ...(move.from === undefined ? {} : { from: move.from }),
    approvals: policy.approvals,
  };
  if (
    !(await append(app, ctx, {
      type: "policy.decided",
      payload: {
        tool: AUTOPILOT_CHILD_TOOL,
        decision: "allow",
        policyId: AUTOPILOT_POLICY_ID,
        reason: `${move.node.label}: ${describeChildPolicy(tier, policy)}`,
      },
    }))
  )
    return;
  if (!(await append(app, ctx, { type: "child.started", payload: started }))) return;
  await launchChild(app, ctx, started, deps);
}

async function launchChild(
  app: AppDatabase,
  parent: RunContext,
  started: ChildStartedPayload,
  deps: DurableDeps,
): Promise<void> {
  const runner = deps.runner();
  const session = { userId: parent.userId, workspaceId: parent.workspaceId };
  await createRunRecord(app, session, {
    runId: started.childRunId,
    missionId: started.missionId,
    input: started.input,
    execution: runner.execution,
    parentRunId: parent.runId,
    autopilot: { parentRunId: parent.runId, nodeId: started.nodeId },
  });
  const ctx = { runId: started.childRunId, workspaceId: parent.workspaceId, userId: parent.userId };
  const mayAsk = started.approvals.sideEffects === "ask";
  const connections =
    mayAsk &&
    started.missionId === "custom-goal" &&
    runner.execution === "live" &&
    deps.connections !== undefined
      ? await deps.connections(app, ctx).catch(() => undefined)
      : undefined;
  deps.schedule(() =>
    executeRun({
      app,
      ctx,
      missionId: started.missionId,
      input: started.input,
      runner: runner.run,
      registry: deps.registry,
      autoApprovePlan: started.approvals.plan === "auto",
      ...(connections === undefined ? {} : { connections }),
      ...(runner.execution === "live" ? { lease: createDbLease(app, ctx) } : {}),
      ...(mayAsk && started.missionId === "ship-a-pr" && deps.shipInstallations !== undefined
        ? { findInstallation: deps.shipInstallations(parent.workspaceId, parent.userId) }
        : {}),
      onSettled: () => advanceAutopilot(app, parent.userId, parent.runId, deps),
    }),
  );
}

async function finish(
  app: AppDatabase,
  ctx: RunContext,
  state: RunState,
  input: AutopilotInput,
  move: Extract<AutopilotMove, { kind: "finish" }>,
  elapsedMs: number,
  now: Date,
): Promise<void> {
  const report = buildAutopilotReport({
    input,
    tier: await workspaceTier(app, ctx),
    children: state.children,
    finish: move,
    tokens: state.children.reduce((sum, child) => sum + (child.tokens ?? 0), 0),
    elapsedMs,
    limits: { ...AUTOPILOT_LIMITS },
    now,
  });
  if (
    !(await append(app, ctx, {
      type: "artifact.created",
      payload: {
        artifactId: randomUUID(),
        kind: AUTOPILOT_REPORT_KIND,
        title: "Autopilot report",
        version: 1,
        content: report,
      },
    }))
  )
    return;
  await append(
    app,
    ctx,
    report.status === "failed"
      ? {
          type: "run.failed",
          payload: {
            error: {
              code: `autopilot_${report.stop?.reason ?? "failed"}`,
              message: report.stop?.message ?? report.headline,
            },
          },
        }
      : { type: "run.completed", payload: { summary: report.headline } },
  );
}

export async function cancelAutopilotChildren(
  app: AppDatabase,
  userId: string,
  parentRunId: string,
  deps: Pick<DurableDeps, "registry">,
): Promise<void> {
  let state: RunState;
  try {
    state = foldRun(await readAllEvents(app, userId, parentRunId));
  } catch {
    return;
  }
  for (const child of state.children) {
    if (child.outcome !== undefined) continue;
    const record = await getRunRecord(app, userId, child.childRunId);
    if (record === null || isTerminalRecord(record)) continue;
    await append(
      app,
      { runId: record.id, workspaceId: record.workspaceId, userId },
      {
        type: "run.failed",
        payload: { error: { code: "cancelled", message: "cancelled with its Autopilot run" } },
      },
    );
    deps.registry.abort(record.id, "cancelled with its Autopilot run");
  }
}

export interface AutopilotGraphNode {
  nodeId: string;
  missionId: string;
  label: string;
  childRunId: string | null;
  status: RunStatus | "queued";
  summary: string | null;
  outcome: ChildRunState["outcome"] | null;
  from: ChildRunState["from"] | null;
  approvals: ChildRunState["approvals"] | null;
  startedAt: string | null;
  completedAt: string | null;
}

export async function autopilotGraph(
  app: AppDatabase,
  userId: string,
  events: readonly RunEvent[],
): Promise<AutopilotGraphNode[]> {
  const state = foldRun(events);
  const terminal = state.status === "completed" || state.status === "failed";
  const started = new Map(state.children.map((child) => [child.nodeId, child]));
  const nodes = plannedNodes(trackOf(state.children));
  const extra = state.children.filter(
    (child) => !nodes.some((node) => node.nodeId === child.nodeId),
  );
  const result: AutopilotGraphNode[] = [];
  for (const node of [...nodes, ...extra]) {
    const child = started.get(node.nodeId);
    if (child === undefined) {
      if (terminal) continue;
      result.push({
        nodeId: node.nodeId,
        missionId: node.missionId,
        label: node.label,
        childRunId: null,
        status: "queued",
        summary: null,
        outcome: null,
        from: null,
        approvals: null,
        startedAt: null,
        completedAt: null,
      });
      continue;
    }
    const live =
      child.outcome === undefined
        ? ((await getRunRecord(app, userId, child.childRunId))?.status ?? "planning")
        : child.outcome.status;
    result.push({
      nodeId: child.nodeId,
      missionId: child.missionId,
      label: child.label,
      childRunId: child.childRunId,
      status: live,
      summary: child.outcome?.summary ?? null,
      outcome: child.outcome ?? null,
      from: child.from ?? null,
      approvals: child.approvals,
      startedAt: child.startedAt,
      completedAt: child.completedAt ?? null,
    });
  }
  return result;
}
