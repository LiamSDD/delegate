import { z } from "zod";

import {
  isProviderAvailable,
  resolveBaseUrl,
  type DataClassification,
  type EmbeddingEntry,
  type Env,
  type ModelsConfig,
} from "../models";

export type EmbeddingInput = "query" | "passage";

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;
  embed(texts: readonly string[], kind: EmbeddingInput, signal?: AbortSignal): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const EmbeddingResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int().optional() })),
});

export const EMBEDDING_TIMEOUT_MS = 20_000;

export function createOpenAICompatibleEmbeddings(options: {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  entry: EmbeddingEntry;
  fetchImpl?: typeof fetch;
}): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const quirks = new Set(options.entry.quirks ?? []);
  return {
    provider: options.provider,
    model: options.entry.model,
    dimensions: options.entry.dimensions,
    maxBatch: options.entry.maxBatch,
    async embed(texts, kind, signal) {
      if (texts.length === 0) return [];
      if (texts.length > options.entry.maxBatch)
        throw new EmbeddingError(`Batch of ${texts.length} exceeds ${options.entry.maxBatch}`);
      const timeout = AbortSignal.timeout(EMBEDDING_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
          },
          body: JSON.stringify({
            model: options.entry.model,
            input: texts,
            encoding_format: "float",
            ...(quirks.has("input-type") ? { input_type: kind } : {}),
            ...(quirks.has("dimensions-param") ? { dimensions: options.entry.dimensions } : {}),
            ...(quirks.has("truncate-end") ? { truncate: "END" } : {}),
          }),
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
      } catch (error) {
        throw new EmbeddingError(
          `${options.provider}/${options.entry.model}: ${error instanceof Error ? error.message : "request failed"}`,
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => ""))
          .replace(/nvapi-[A-Za-z0-9_-]+|Bearer\s+\S+/g, "[redacted]")
          .replace(/\s+/g, " ")
          .slice(0, 160);
        throw new EmbeddingError(
          `${options.provider}/${options.entry.model}: HTTP ${response.status}${detail === "" ? "" : ` ${detail}`}`,
          response.status,
        );
      }
      const parsed = EmbeddingResponseSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new EmbeddingError(`${options.provider}/${options.entry.model}: malformed response`);
      const ordered = [...parsed.data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (ordered.length !== texts.length)
        throw new EmbeddingError(
          `${options.provider}/${options.entry.model}: ${ordered.length} vectors for ${texts.length} inputs`,
        );
      return ordered.map((item) => {
        if (item.embedding.length !== options.entry.dimensions)
          throw new EmbeddingError(
            `${options.provider}/${options.entry.model}: ${item.embedding.length} dimensions, expected ${options.entry.dimensions}`,
          );
        return item.embedding;
      });
    },
  };
}

export function resolveEmbeddings(options: {
  config: ModelsConfig;
  env: Env;
  audience: "public-demo" | "owner";
  classification: DataClassification;
  fetchImpl?: typeof fetch;
}): EmbeddingProvider | undefined {
  const embeddings = options.config.embeddings;
  if (embeddings === undefined) return undefined;
  for (const entry of embeddings.chain) {
    const provider = options.config.providers.find((candidate) => candidate.id === entry.provider);
    if (provider?.kind !== "openai-compatible") continue;
    if (
      !isProviderAvailable(provider, options.env, {
        audience: options.audience,
        environment: "server",
        classification: options.classification,
      })
    )
      continue;
    const baseUrl = resolveBaseUrl(provider, options.env);
    if (baseUrl === undefined) continue;
    const apiKey = provider.apiKeyEnv === undefined ? undefined : options.env[provider.apiKeyEnv];
    return createOpenAICompatibleEmbeddings({
      provider: provider.id,
      baseUrl,
      entry,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  return undefined;
}

export interface EmbedAllResult {
  vectors: (number[] | undefined)[];
  failed: number;
  skipped: number;
  lastError?: string;
}

export interface EmbedAllOptions {
  concurrency?: number;
  budgetMs?: number;
  now?: () => number;
}

export async function embedAll(
  provider: EmbeddingProvider,
  texts: readonly string[],
  kind: EmbeddingInput,
  signal?: AbortSignal,
  options: EmbedAllOptions = {},
): Promise<EmbedAllResult> {
  const now = options.now ?? Date.now;
  const deadline = options.budgetMs === undefined ? Infinity : now() + options.budgetMs;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const vectors: (number[] | undefined)[] = texts.map(() => undefined);
  let failed = 0;
  let skipped = 0;
  let lastError: string | undefined;
  const run = async (batch: readonly string[]): Promise<(number[] | undefined)[]> => {
    try {
      return await provider.embed(batch, kind, signal);
    } catch (error) {
      const rejected =
        error instanceof EmbeddingError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429;
      if (!rejected) throw error;
      lastError = error.message;
      if (batch.length === 1) {
        failed += 1;
        return [undefined];
      }
      const middle = Math.ceil(batch.length / 2);
      return [...(await run(batch.slice(0, middle))), ...(await run(batch.slice(middle)))];
    }
  };
  const starts: number[] = [];
  for (let start = 0; start < texts.length; start += provider.maxBatch) starts.push(start);
  let next = 0;
  let embeddedBatches = 0;
  let halted: Error | undefined;
  const worker = async () => {
    while (next < starts.length) {
      const start = starts[next] ?? 0;
      next += 1;
      const batch = texts.slice(start, start + provider.maxBatch);
      if (halted !== undefined || now() >= deadline || signal?.aborted === true) {
        skipped += batch.length;
        continue;
      }
      try {
        const embedded = await run(batch);
        embedded.forEach((vector, offset) => {
          vectors[start + offset] = vector;
        });
        embeddedBatches += 1;
      } catch (error) {
        halted ??= error instanceof Error ? error : new EmbeddingError("embedding failed");
        skipped += batch.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
  if (halted !== undefined) {
    if (embeddedBatches === 0) throw halted;
    lastError = halted.message;
  }
  return { vectors, failed, skipped, ...(lastError === undefined ? {} : { lastError }) };
}
