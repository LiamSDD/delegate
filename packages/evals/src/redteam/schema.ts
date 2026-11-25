import { z } from "zod";

export const REDTEAM_SUITE = "redteam/v2" as const;

export const REDTEAM_CATEGORIES = [
  "indirect-injection",
  "exfiltration",
  "ssrf",
  "capability-escalation",
  "approval-bypass",
  "quote-forgery",
  "connector-poisoning",
  "sandbox-escape",
  "playbook-poisoning",
  "crawler-trap",
] as const;
export const RedteamCategorySchema = z.enum(REDTEAM_CATEGORIES);
export type RedteamCategory = z.infer<typeof RedteamCategorySchema>;

const host = z.string().min(1);

export const RouteSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const NetworkSchema = z.strictObject({
  dns: z.record(z.string(), z.array(z.string())).optional(),
  routes: z.record(z.string(), RouteSchema).optional(),
});
export type Network = z.infer<typeof NetworkSchema>;

export const ToolCallSchema = z.strictObject({
  name: z.string().min(1),
  args: z.unknown(),
});
export type ScriptedToolCall = z.infer<typeof ToolCallSchema>;

export const PolicyRefSchema = z.unknown();

const ReaderFactSchema = z.record(z.string(), z.unknown());

export const FetchPayloadSchema = z.strictObject({
  url: z.string().min(1),
  network: NetworkSchema.optional(),
  allowPublicIpLiterals: z.boolean().optional(),
  forbiddenHosts: z.array(host).min(1),
});

export const CrawlGeneratorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("calendar"), prefix: z.url() }),
  z.strictObject({ kind: z.literal("pagination"), prefix: z.url() }),
  z.strictObject({ kind: z.literal("repeating-path"), prefix: z.url() }),
  z.strictObject({
    kind: z.literal("link-flood"),
    url: z.url(),
    links: z.number().int().positive().max(200_000),
  }),
  z.strictObject({
    kind: z.literal("sitemap-flood"),
    url: z.url(),
    urls: z.number().int().positive().max(500_000),
  }),
  z.strictObject({
    kind: z.literal("gzip-bomb"),
    url: z.url(),
    decodedBytes: z.number().int().positive().max(1_073_741_824),
    contentType: z.string().min(1),
  }),
]);
export type CrawlGenerator = z.infer<typeof CrawlGeneratorSchema>;

export const CrawlPayloadSchema = z.strictObject({
  siteUrl: z.url(),
  network: NetworkSchema.optional(),
  generators: z.array(CrawlGeneratorSchema).default([]),
  maxPages: z.number().int().positive().max(500).default(50),
  forbiddenHosts: z.array(host).default([]),
  forbiddenPaths: z.array(z.string().startsWith("/")).default([]),
  maxRequests: z.number().int().positive(),
  maxDecodedBytes: z.number().int().positive().optional(),
  laterFetches: z.array(z.url()).default([]),
});

export const PinnedFetchPayloadSchema = z.strictObject({
  url: z.string().min(1),
  dnsSequence: z.array(z.array(z.string()).min(1)).min(1),
});

export const AgentPayloadSchema = z.strictObject({
  siteUrl: z.url(),
  step: z.strictObject({ id: z.string().min(1), capabilities: z.array(z.string()) }),
  policies: z.array(PolicyRefSchema).optional(),
  classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  assistantText: z.string().optional(),
  calls: z.array(ToolCallSchema).min(1),
  network: NetworkSchema.optional(),
  forbiddenHosts: z.array(host).default([]),
});

export const PipelinePayloadSchema = z.strictObject({
  siteUrl: z.url(),
  pages: z.record(z.string(), z.string()),
  readerFacts: z.array(ReaderFactSchema).min(1),
  workerCalls: z.array(ToolCallSchema).min(1),
  injectedText: z.string().min(8),
  network: NetworkSchema.optional(),
  forbiddenHosts: z.array(host).default([]),
});

export const ReaderPayloadSchema = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        sourceId: z.string().regex(/^S\d{1,4}$/),
        text: z.string(),
        hiddenText: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  output: z.unknown(),
  forgedQuotes: z.array(z.string()).default([]),
});

export const RepoPayloadSchema = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[\w.-]+$/),
  files: z.record(z.string(), z.string()),
  readerFacts: z.array(ReaderFactSchema).default([]),
  architect: z.unknown().optional(),
  improver: z.unknown().optional(),
  workerCalls: z.array(ToolCallSchema).default([]),
  injectedText: z.string().min(8).optional(),
  falseClaims: z.array(z.string().min(4)).default([]),
  forbiddenHosts: z.array(host).default([]),
});

export const PolicyPayloadSchema = z.strictObject({
  policies: z.array(PolicyRefSchema),
  context: z.unknown(),
});

export const PlanPayloadSchema = z.discriminatedUnion("via", [
  z.strictObject({
    via: z.literal("planner"),
    plannerOutput: z.unknown(),
    forbidden: z.array(z.strictObject({ stepId: z.string(), capability: z.string() })).min(1),
  }),
  z.strictObject({
    via: z.literal("review"),
    decision: z.unknown(),
  }),
  z.strictObject({
    via: z.literal("gaps"),
    siteUrl: z.url(),
    paths: z.array(z.string().startsWith("/")).default([]),
    topics: z.array(z.string().min(1).max(200)).default([]),
    sections: z.array(z.string().min(1).max(200)).default([]),
    injectedText: z.string().min(8),
  }),
  z.strictObject({
    via: z.literal("revision"),
    revise: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
          capabilities: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
  }),
]);

export const OrchestratorPayloadSchema = z.strictObject({
  executorCapabilities: z.array(z.string()),
  planCapabilities: z.array(z.string()),
  calls: z.array(ToolCallSchema).min(1),
});

export const ConnectorPayloadSchema = z.strictObject({
  connectors: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
        host: host,
        tools: z
          .array(
            z.strictObject({
              name: z.string().min(1),
              description: z.string().optional(),
              readOnlyHint: z.boolean().optional(),
              output: z.string().optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  preapproved: z.array(z.string()).default([]),
  readerFacts: z.array(ReaderFactSchema).default([]),
  workerTurns: z.array(z.array(ToolCallSchema).min(1)).min(1),
  injectedText: z.string().min(8).optional(),
  forbiddenRemoteCalls: z.array(z.string().regex(/^[a-z0-9-]+\/.+$/)).default([]),
  forbiddenHosts: z.array(host).default([]),
  reviewer: z.strictObject({ rejectsWhenShown: z.string().min(8) }).optional(),
});
export const EngineerPayloadSchema = z.strictObject({
  repoFiles: z.record(z.string(), z.string()),
  symlinks: z.record(z.string(), z.string()).optional(),
  audience: z.enum(["public-demo", "owner"]).default("owner"),
  approval: z.enum(["none", "approved", "rejected"]).default("none"),
  approvalDelayMs: z.number().int().min(0).max(5_000).default(0),
  connected: z
    .strictObject({
      collaborator: z
        .string()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
        .nullable(),
      permission: z.enum(["admin", "maintain", "write", "triage", "read", "none"]),
    })
    .optional(),
  assistantText: z.string().optional(),
  calls: z.array(ToolCallSchema).min(1),
});
export const INJECTION_POINTS = [
  "plan.rationale",
  "step.summary",
  "step.id",
  "agent.message",
  "tool.name",
  "tool.args",
  "tool.summary",
  "tool.error",
  "source.url",
  "source.kind",
  "source.text",
  "artifact.title",
  "critic.claim",
  "critic.reason",
  "critic.category",
  "fallback.provider",
  "failure.code",
  "failure.message",
  "run.summary",
] as const;

export const PlaybookPayloadSchema = z.discriminatedUnion("via", [
  z.strictObject({
    via: z.literal("reflect"),
    injectedText: z.string().min(8),
    at: z.array(z.enum(INJECTION_POINTS)).min(1),
    failed: z.boolean().default(false),
    reflectOutput: z.unknown().optional(),
    poison: z.array(z.string().min(4)).min(1),
  }),
  z.strictObject({
    via: z.literal("house"),
    audience: z.enum(["public-demo", "owner"]),
    houseLearning: z.boolean().optional(),
    injectedText: z.string().min(8),
  }),
  z.strictObject({
    via: z.literal("retrieval"),
    entries: z.array(z.strictObject({ key: z.string().min(1), text: z.string().min(1) })).min(1),
    poison: z.array(z.string().min(4)).min(1),
  }),
]);

const ExpectedSchema = z.strictObject({
  outcome: z.literal("blocked"),
  blockedBy: z.string().min(1),
});

const base = {
  id: z.string().regex(/^[a-z]{2}-\d{3}$/),
  category: RedteamCategorySchema,
  description: z.string().min(1),
  expected: ExpectedSchema,
};

export const RedteamCaseSchema = z.discriminatedUnion("target", [
  z.strictObject({ ...base, target: z.literal("fetch"), payload: FetchPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("pinned-fetch"), payload: PinnedFetchPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("crawl"), payload: CrawlPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("agent"), payload: AgentPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("pipeline"), payload: PipelinePayloadSchema }),
  z.strictObject({ ...base, target: z.literal("reader"), payload: ReaderPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("repo"), payload: RepoPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("policy"), payload: PolicyPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("plan"), payload: PlanPayloadSchema }),
  z.strictObject({
    ...base,
    target: z.literal("orchestrator"),
    payload: OrchestratorPayloadSchema,
  }),
  z.strictObject({ ...base, target: z.literal("connector"), payload: ConnectorPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("engineer"), payload: EngineerPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("playbook"), payload: PlaybookPayloadSchema }),
]);
export type RedteamCase = z.infer<typeof RedteamCaseSchema>;
export type RedteamTarget = RedteamCase["target"];

export const redteamCaseResultSchema = z.strictObject({
  id: z.string(),
  category: z.string(),
  blockedBy: z.string(),
  succeeded: z.boolean(),
});
export type RedteamCaseResult = z.infer<typeof redteamCaseResultSchema>;

export const redteamResultSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  suite: z.string(),
  attacks: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  asr: z.number().min(0).max(1),
  byCategory: z.array(
    z.strictObject({
      category: z.string(),
      attacks: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
    }),
  ),
  cases: z.array(redteamCaseResultSchema),
});
export type RedteamResult = z.infer<typeof redteamResultSchema>;
