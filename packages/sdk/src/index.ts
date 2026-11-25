import { z } from "zod";

export const packageName = "@delegate/sdk" as const;

export const RUN_STATUSES = [
  "planning",
  "awaiting_plan_approval",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const MissionInputSchema = z.strictObject({
  url: z.string().min(1).max(2048),
  focus: z.string().trim().min(1).max(500).optional(),
  department: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(900).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  opportunityId: z.string().trim().min(1).max(40).optional(),
});
export type MissionInput = z.infer<typeof MissionInputSchema>;

export const StartRunRequestSchema = z.strictObject({
  missionId: z.string().min(1).max(64),
  input: MissionInputSchema,
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.object({ runId: z.uuid() });

export const RunStepViewSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  summary: z.string().optional(),
});

export const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  version: z.number().int(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactSchema = ArtifactRefSchema.extend({ content: z.unknown() });
export type Artifact = z.infer<typeof ArtifactSchema>;

export const RunViewSchema = z.object({
  id: z.uuid(),
  mission: z.string(),
  status: RunStatusSchema,
  terminal: z.boolean(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    costMicroUsd: z.number(),
    toolCalls: z.number(),
  }),
  pendingPlan: z.array(RunStepViewSchema).nullable(),
  pendingApprovals: z.array(z.object({ approvalId: z.string(), summary: z.string() })),
  steps: z.array(RunStepViewSchema),
  artifacts: z.array(ArtifactRefSchema),
  deliverable: ArtifactSchema.nullable(),
  summary: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type RunView = z.infer<typeof RunViewSchema>;

export const RunListEntrySchema = z.object({
  id: z.uuid(),
  mission: z.string(),
  target: z.string().nullable(),
  status: RunStatusSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunListEntry = z.infer<typeof RunListEntrySchema>;

export const PlanDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approved") }),
  z.strictObject({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class DelegateApiError extends Error {
  override readonly name = "DelegateApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DelegateClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface DelegateClient {
  readonly baseUrl: string;
  startRun(request: StartRunRequest): Promise<{ runId: string; webUrl: string }>;
  getRun(runId: string): Promise<RunView>;
  listRuns(limit?: number): Promise<RunListEntry[]>;
  decidePlan(runId: string, decision: PlanDecision): Promise<{ decision: string }>;
  getArtifact(runId: string, artifactId: string): Promise<Artifact>;
  runUrl(runId: string): string;
}

function normaliseBase(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    throw new Error("The Delegate base URL must use https (http is allowed for localhost only).");
  return url.origin;
}

export function createDelegateClient(options: DelegateClientOptions): DelegateClient {
  const baseUrl = normaliseBase(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/json",
    "user-agent": options.userAgent ?? "delegate-sdk/0.1",
  };

  async function call<T extends z.ZodType>(
    schema: T,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      throw new DelegateApiError(
        response.status,
        parsed.success ? parsed.data.error.code : "http_error",
        parsed.success ? parsed.data.error.message : `Delegate answered HTTP ${response.status}`,
      );
    }
    return schema.parse(json);
  }

  const runUrl = (runId: string) => `${baseUrl}/runs/${encodeURIComponent(runId)}`;

  return {
    baseUrl,
    runUrl,
    async startRun(request) {
      const body = StartRunRequestSchema.parse(request);
      const { runId } = await call(StartRunResponseSchema, "/api/runs", {
        method: "POST",
        body,
      });
      return { runId, webUrl: runUrl(runId) };
    },
    async getRun(runId) {
      const { view } = await call(
        z.object({ view: RunViewSchema }),
        `/api/runs/${encodeURIComponent(runId)}?view=1`,
      );
      return view;
    },
    async listRuns(limit = 20) {
      const { runs } = await call(
        z.object({ runs: z.array(RunListEntrySchema) }),
        `/api/runs?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`,
      );
      return runs;
    },
    decidePlan(runId, decision) {
      return call(
        z.object({ decision: z.string() }),
        `/api/runs/${encodeURIComponent(runId)}/plan`,
        {
          method: "POST",
          body: PlanDecisionSchema.parse(decision),
        },
      );
    },
    async getArtifact(runId, artifactId) {
      const { artifact } = await call(
        z.object({ artifact: ArtifactSchema }),
        `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      );
      return artifact;
    },
  };
}
