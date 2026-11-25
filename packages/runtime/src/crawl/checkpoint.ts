import { z } from "zod";

export const CRAWL_STATE_KIND = "crawl-state";

export const STOP_REASONS = [
  "exhausted",
  "page_budget",
  "byte_budget",
  "time_budget",
  "fetch_budget",
  "page_cap",
  "aborted",
] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

const count = z.number().int().nonnegative();

export const CrawlStatsSchema = z.object({
  fetched: count,
  stored: count,
  cached: count,
  skipped: count,
  retries: count,
  bytes: count,
  sitemapsFetched: count,
  sitemapUrls: count,
  feedsFetched: count,
  skippedByCode: z.record(z.string(), count),
  durationMs: count,
});
export type CrawlStats = z.infer<typeof CrawlStatsSchema>;

export const FrontierEntrySchema = z.object({
  url: z.string().min(1),
  key: z.string().min(1),
  host: z.string(),
  depth: count,
  score: z.number(),
  source: z.enum(["seed", "sitemap", "feed", "link"]),
  topic: z.string().optional(),
  lastmod: z.string().optional(),
  attempts: count,
  seq: count,
});

export const CrawlPageRecordSchema = z.object({
  url: z.string().min(1),
  finalUrl: z.string().min(1),
  key: z.string().min(1),
  title: z.string(),
  depth: count,
  score: z.number(),
  topic: z.string().optional(),
  source: z.enum(["seed", "sitemap", "feed", "link"]),
  bytes: count,
  cached: z.boolean(),
  language: z.string(),
  extraction: z.string(),
});
export type CrawlPageRecord = z.infer<typeof CrawlPageRecordSchema>;

export const CrawlCheckpointSchema = z.object({
  version: z.literal(1),
  discovered: z.boolean(),
  languages: z.array(z.string()).optional(),
  pages: z.array(CrawlPageRecordSchema),
  done: z.array(z.string()),
  frontier: z.array(FrontierEntrySchema),
  duplicates: z.array(z.object({ hash: z.string(), simhash: z.string(), url: z.string() })),
  patterns: z.array(z.tuple([z.string(), count])),
  sitemaps: z.array(z.string()),
  stats: CrawlStatsSchema,
});
export type CrawlCheckpoint = z.infer<typeof CrawlCheckpointSchema>;

export const CrawlStateArtifactSchema = z.object({
  startUrl: z.string(),
  finished: z.boolean(),
  progress: z.object({
    fetched: count,
    stored: count,
    queued: count,
    skipped: count,
    inFlight: count,
    bytes: count,
    elapsedMs: count,
    hosts: z.array(
      z.object({
        host: z.string(),
        requestsPerSecond: z.number(),
        active: count,
        limit: count,
        avgLatencyMs: count,
        rateLimited: count,
        crawlDelayMs: z.number().optional(),
      }),
    ),
  }),
  checkpoint: CrawlCheckpointSchema,
});
export type CrawlStateArtifact = z.infer<typeof CrawlStateArtifactSchema>;

export function parseCheckpoint(value: unknown): CrawlCheckpoint | undefined {
  const parsed = CrawlStateArtifactSchema.safeParse(value);
  if (parsed.success) return parsed.data.checkpoint;
  const bare = CrawlCheckpointSchema.safeParse(value);
  return bare.success ? bare.data : undefined;
}
