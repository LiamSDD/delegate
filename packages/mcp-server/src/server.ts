import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type Artifact,
  MissionInputSchema,
  type PlanDecision,
  type RunListEntry,
  type RunView,
  StartAutopilotRequestSchema,
  type StartAutopilotRequest,
  type StartRunRequest,
} from "@delegate/sdk";
import { z } from "zod";

export const SERVER_INFO = { name: "delegate", version: "0.1.0" } as const;

export const WAIT_DEFAULT_SECONDS = 25;
export const WAIT_MAX_SECONDS = 120;
export const WAIT_POLL_MS = 1_000;
const DELIVERABLE_MAX_CHARS = 60_000;

export interface DelegateBackend {
  startMission(request: StartRunRequest): Promise<{ runId: string; webUrl: string }>;
  startAutopilot(request: StartAutopilotRequest): Promise<{ runId: string; webUrl: string }>;
  getRun(runId: string): Promise<RunView | null>;
  listRuns(limit: number): Promise<RunListEntry[]>;
  decidePlan(runId: string, decision: PlanDecision): Promise<{ decision: string }>;
  getArtifact(runId: string, artifactId: string): Promise<Artifact | null>;
  runUrl(runId: string): string;
}

export class BackendError extends Error {
  override readonly name = "BackendError";
}

export interface ServerOptions {
  missions: readonly { id: string; title: string; description: string }[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RunIdShape = { runId: z.uuid().describe("The run id returned by start_mission") };

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function cap(text: string): string {
  return text.length <= DELIVERABLE_MAX_CHARS
    ? text
    : `${text.slice(0, DELIVERABLE_MAX_CHARS)}\n… truncated; read the full deliverable with get_artifact or the resource.`;
}

const WAITING_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_plan_approval",
  "awaiting_approval",
]);

function waitingChild(view: RunView) {
  return (view.children ?? []).find((child) => WAITING_STATUSES.has(child.status));
}

function nextActionFor(view: RunView): string | null {
  if (view.status === "awaiting_plan_approval")
    return "The plan is waiting for a decision: call approve_plan or reject_plan.";
  if (view.terminal) return null;
  const child = waitingChild(view);
  if (child !== undefined && child.runId !== null)
    return child.status === "awaiting_plan_approval"
      ? `Child run ${child.runId} (${child.label}) is waiting for its plan: call approve_plan or reject_plan with that runId.`
      : `Child run ${child.runId} (${child.label}) is waiting for an approval in the web UI; Autopilot continues after it.`;
  return "Still working: call wait_for_run.";
}

function presentRun(view: RunView, webUrl: string, runUrl: (runId: string) => string) {
  const serialised = view.deliverable === null ? "" : JSON.stringify(view.deliverable.content);
  const deliverable =
    view.deliverable === null
      ? null
      : {
          artifactId: view.deliverable.artifactId,
          kind: view.deliverable.kind,
          title: view.deliverable.title,
          ...(serialised.length <= DELIVERABLE_MAX_CHARS
            ? { content: view.deliverable.content }
            : { contentPreview: cap(serialised) }),
        };
  return {
    runId: view.id,
    mission: view.mission,
    status: view.status,
    terminal: view.terminal,
    webUrl,
    nextAction: nextActionFor(view),
    pendingPlan: view.pendingPlan,
    pendingApprovals: view.pendingApprovals,
    steps: view.steps,
    totals: view.totals,
    artifacts: view.artifacts,
    summary: view.summary,
    error: view.error,
    deliverable,
    ...(view.children === undefined
      ? {}
      : {
          children: view.children.map((child) => ({
            ...child,
            webUrl: child.runId === null ? null : runUrl(child.runId),
          })),
        }),
    ...(view.autopilotParent === undefined || view.autopilotParent === null
      ? {}
      : {
          autopilotParent: {
            ...view.autopilotParent,
            webUrl: runUrl(view.autopilotParent.runId),
          },
        }),
  };
}

function needsAttention(view: RunView): boolean {
  return (
    view.terminal ||
    view.status === "awaiting_plan_approval" ||
    view.status === "awaiting_approval" ||
    waitingChild(view) !== undefined
  );
}

async function guarded(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof BackendError) return failure(error.message);
    if (error instanceof Error && error.name === "DelegateApiError") return failure(error.message);
    throw error;
  }
}

export function createDelegateMcpServer(backend: DelegateBackend, options: ServerOptions) {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const missionIds = options.missions.map((mission) => mission.id);
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Delegate runs missions (cited company research, automation audits, assistants) as governed, audited runs. Start one with start_mission, or hand a whole goal to start_autopilot, then call wait_for_run until it is terminal or a plan needs approval. Every run is visible live at its webUrl.",
  });

  server.registerTool(
    "start_mission",
    {
      title: "Start a Delegate mission",
      description: `Start a mission run. Missions: ${options.missions.map((mission) => `${mission.id} (${mission.title})`).join(", ")}. Returns the run id and the web URL where the run streams live.`,
      inputSchema: {
        missionId: z.string().describe(`One of: ${missionIds.join(", ")}`),
        input: MissionInputSchema.describe(
          "Mission input. url is the company website; build-agent also needs goal.",
        ),
      },
    },
    ({ missionId, input }) =>
      guarded(async () => {
        const started = await backend.startMission({ missionId, input });
        return json({
          ...started,
          next: "Call wait_for_run with this runId to follow progress.",
        });
      }),
  );

  server.registerTool(
    "start_autopilot",
    {
      title: "Start an Autopilot run",
      description:
        "Hand Delegate a goal and let it carry the work through: a goal brief first, then the top actions as child runs (Company X-ray, AI Automation Audit and Build it; or Repo X-ray and Ship-a-PR). Each child keeps its own approvals: plans follow the workspace auto-approve setting and side effects (pull requests, connector writes) always ask unless pre-approved. At most 4 children, no nested autopilots. get_run lists the children with their status.",
      inputSchema: StartAutopilotRequestSchema.shape,
    },
    ({ goal, url }) =>
      guarded(async () => {
        const started = await backend.startAutopilot(url === undefined ? { goal } : { goal, url });
        return json({
          ...started,
          next: "Call wait_for_run with this runId; it returns early when a child needs a decision.",
        });
      }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get a run",
      description: "Status, step summary and, when finished, the deliverable of a run.",
      inputSchema: RunIdShape,
      annotations: { readOnlyHint: true },
    },
    ({ runId }) =>
      guarded(async () => {
        const view = await backend.getRun(runId);
        if (view === null) return failure("No run with that id is visible to this token.");
        return json(presentRun(view, backend.runUrl(runId), (id) => backend.runUrl(id)));
      }),
  );

  server.registerTool(
    "wait_for_run",
    {
      title: "Wait for a run",
      description: `Long-poll a run until it finishes, needs a plan decision, or the timeout passes (default ${WAIT_DEFAULT_SECONDS} s, at most ${WAIT_MAX_SECONDS} s). Call again if it is still running.`,
      inputSchema: {
        ...RunIdShape,
        timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ runId, timeoutSeconds }) =>
      guarded(async () => {
        const deadline = now() + (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000;
        for (;;) {
          const view = await backend.getRun(runId);
          if (view === null) return failure("No run with that id is visible to this token.");
          if (needsAttention(view) || now() + WAIT_POLL_MS > deadline)
            return json({
              ...presentRun(view, backend.runUrl(runId), (id) => backend.runUrl(id)),
              waited: true,
            });
          await sleep(WAIT_POLL_MS);
        }
      }),
  );

  server.registerTool(
    "approve_plan",
    {
      title: "Approve a plan",
      description: "Approve the plan a run is waiting on, so it starts working.",
      inputSchema: RunIdShape,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    ({ runId }) =>
      guarded(async () => json(await backend.decidePlan(runId, { decision: "approved" }))),
  );

  server.registerTool(
    "reject_plan",
    {
      title: "Reject a plan",
      description: "Reject the plan a run is waiting on; the run stops.",
      inputSchema: { ...RunIdShape, reason: z.string().trim().min(1).max(500).optional() },
      annotations: { destructiveHint: true },
    },
    ({ runId, reason }) =>
      guarded(async () =>
        json(
          await backend.decidePlan(
            runId,
            reason === undefined ? { decision: "rejected" } : { decision: "rejected", reason },
          ),
        ),
      ),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "Most recent runs in this workspace.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) =>
      guarded(async () => {
        const runs = await backend.listRuns(limit ?? 20);
        return json(runs.map((run) => ({ ...run, webUrl: backend.runUrl(run.id) })));
      }),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Get an artifact",
      description:
        "Read one artifact of a run (deliverables, source snapshots, connector outputs).",
      inputSchema: { ...RunIdShape, artifactId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true },
    },
    ({ runId, artifactId }) =>
      guarded(async () => {
        const artifact = await backend.getArtifact(runId, artifactId);
        if (artifact === null) return failure("No artifact with that id on this run.");
        return { content: [{ type: "text", text: cap(JSON.stringify(artifact, null, 2)) }] };
      }),
  );

  server.registerResource(
    "run-deliverable",
    new ResourceTemplate("delegate://runs/{runId}/deliverable", {
      list: async () => {
        const runs = await backend.listRuns(20);
        return {
          resources: runs
            .filter((run) => run.status === "completed")
            .map((run) => ({
              uri: `delegate://runs/${run.id}/deliverable`,
              name: `${run.mission}${run.target === null ? "" : ` · ${run.target}`}`,
              mimeType: "application/json",
            })),
        };
      },
    }),
    {
      title: "Run deliverable",
      description: "The final deliverable of a completed run, as JSON.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const runId = z.uuid().safeParse(variables.runId);
      if (!runId.success) throw new BackendError("Not a run id.");
      const view = await backend.getRun(runId.data);
      const deliverable = view?.deliverable ?? null;
      if (deliverable === null) throw new BackendError("That run has no deliverable yet.");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(deliverable, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
