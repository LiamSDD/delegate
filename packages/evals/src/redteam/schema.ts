import { z } from "zod";

export const REDTEAM_SUITE = "redteam/v2" as const;

export const REDTEAM_CATEGORIES = [
  "indirect-injection",
  "exfiltration",
  "ssrf",
  "capability-escalation",
  "approval-bypass",
  "quote-forgery",
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
]);

export const OrchestratorPayloadSchema = z.strictObject({
  executorCapabilities: z.array(z.string()),
  planCapabilities: z.array(z.string()),
  calls: z.array(ToolCallSchema).min(1),
});

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
  z.strictObject({ ...base, target: z.literal("policy"), payload: PolicyPayloadSchema }),
  z.strictObject({ ...base, target: z.literal("plan"), payload: PlanPayloadSchema }),
  z.strictObject({
    ...base,
    target: z.literal("orchestrator"),
    payload: OrchestratorPayloadSchema,
  }),
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
