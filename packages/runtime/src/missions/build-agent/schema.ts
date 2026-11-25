import { z } from "zod";

import { ServingModelSchema } from "../../events";

export const ASSISTANT_KIND = "assistant";
export const ASSISTANT_EVALS_KIND = "assistant-evals";
export const GAPS_REPORT_KIND = "gaps-report";
export const CRAWL_REPORT_KIND = "crawl-report";

export const CorpusStatsSchema = z.object({
  pages: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  flaggedChunks: z.number().int().nonnegative(),
  embeddedChunks: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  skippedPages: z.number().int().nonnegative(),
});
export type CorpusStats = z.infer<typeof CorpusStatsSchema>;

export const CrawlReportSchema = z.object({
  collection: z.string().min(1),
  startUrl: z.string().min(1),
  pages: z.array(
    z.object({
      url: z.string().min(1),
      title: z.string(),
      documentId: z.string().min(1),
      chunks: z.number().int().nonnegative(),
      flaggedChunks: z.number().int().nonnegative(),
      cached: z.boolean(),
    }),
  ),
  skipped: z.array(z.object({ url: z.string(), reason: z.string().max(200) })).max(200),
  bytes: z.number().int().nonnegative(),
  sitemapUrls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  stats: CorpusStatsSchema.optional(),
  retrieval: z
    .object({
      mode: z.enum(["hybrid", "full-text"]),
      embeddingModel: z.string().optional(),
      note: z.string().max(300).optional(),
    })
    .optional(),
});
export type CrawlReport = z.infer<typeof CrawlReportSchema>;

export const ASSISTANT_STATUSES = ["draft", "ready"] as const;

export const AssistantArtifactSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  url: z.string().min(1),
  collection: z.string().min(1),
  goal: z.string().min(1).max(900),
  opportunityId: z.string().optional(),
  fromAuditRunId: z.string().optional(),
  systemPrompt: z.string().min(1).max(12_000),
  persona: z.string().min(1).max(1_500),
  scope: z.object({
    covers: z.array(z.string().min(1).max(200)).min(1).max(10),
    excludes: z.array(z.string().min(1).max(200)).max(10),
  }),
  refusalPolicy: z.string().min(1).max(600),
  starterQuestions: z.array(z.string().min(1).max(200)).min(1).max(6),
  contactUrl: z.string().optional(),
  corpusStats: CorpusStatsSchema,
  retrieval: z.object({
    mode: z.enum(["hybrid", "full-text"]),
    rerank: z.boolean(),
    embeddingModel: z.string().optional(),
  }),
  modelChain: z.object({
    answer: z.array(ServingModelSchema),
    rerank: z.array(ServingModelSchema),
    embeddings: z
      .object({ provider: z.string(), model: z.string(), dimensions: z.number().int() })
      .optional(),
  }),
  prompts: z.record(z.string(), z.number().int().positive()),
  passRate: z.number().min(0).max(1).nullable().optional(),
  gapsCount: z.number().int().nonnegative().optional(),
  status: z.enum(ASSISTANT_STATUSES),
});
export type AssistantArtifact = z.infer<typeof AssistantArtifactSchema>;

export const CitationRefSchema = z.object({
  chunkId: z.string().min(1),
  url: z.string().min(1),
  title: z.string().optional(),
  quote: z.string().max(400).optional(),
});
export type CitationRef = z.infer<typeof CitationRefSchema>;

export const EvalCaseSchema = z.object({
  id: z.string().min(1).max(20),
  question: z.string().min(1).max(300),
  answerable: z.boolean(),
  expectedAnswer: z.string().max(600),
  expectedCitations: z.array(CitationRefSchema).max(4),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalResultSchema = z.object({
  caseId: z.string().min(1),
  answer: z.string().max(4_000),
  refused: z.boolean(),
  citations: z.array(CitationRefSchema).max(10),
  verdict: z.enum(["pass", "fail"]),
  reason: z.string().max(400),
  durationMs: z.number().int().nonnegative(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

export const AssistantEvalsSchema = z.object({
  assistantId: z.uuid(),
  cases: z.array(EvalCaseSchema).max(20),
  results: z.array(EvalResultSchema).max(20),
  passRate: z.number().min(0).max(1).nullable(),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  grader: ServingModelSchema.optional(),
  note: z.string().max(400).optional(),
});
export type AssistantEvals = z.infer<typeof AssistantEvalsSchema>;

export const GAP_KINDS = ["unanswerable", "thin_coverage", "contradiction", "failed_eval"] as const;

export const GapSchema = z.object({
  id: z.string().min(1).max(20),
  kind: z.enum(GAP_KINDS),
  topic: z.string().min(1).max(200),
  detail: z.string().min(1).max(600),
  evidence: z.array(CitationRefSchema).max(4),
  suggestion: z.string().max(300),
});
export type Gap = z.infer<typeof GapSchema>;

export const GapsReportSchema = z.object({
  assistantId: z.uuid(),
  gaps: z.array(GapSchema).max(30),
  coverage: z.object({
    topicsTotal: z.number().int().nonnegative(),
    topicsCovered: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1).nullable(),
    pages: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
  }),
});
export type GapsReport = z.infer<typeof GapsReportSchema>;

export const AssistantRecordSchema = z.object({
  id: z.uuid(),
  runId: z.string().optional(),
  name: z.string().min(1).max(80),
  collection: z.string().min(1),
  config: AssistantArtifactSchema,
  evals: AssistantEvalsSchema.optional(),
  gaps: GapsReportSchema.optional(),
});
export type AssistantRecord = z.infer<typeof AssistantRecordSchema>;

export interface AssistantStore {
  save(record: AssistantRecord): Promise<void>;
  get(id: string): Promise<AssistantRecord | null>;
}

export function createMemoryAssistantStore(): AssistantStore & {
  records: Map<string, AssistantRecord>;
} {
  const records = new Map<string, AssistantRecord>();
  return {
    records,
    save: (record) => {
      records.set(record.id, AssistantRecordSchema.parse(record));
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(records.get(id) ?? null),
  };
}
