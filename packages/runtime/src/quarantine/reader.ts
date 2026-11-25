import { z } from "zod";

import { type RunContext } from "../agent/context";
import { StructuredOutputError, callStructured } from "../agent/structured";

export const READER_DEFAULTS = {
  batchChars: 30_000,
  perSourceChars: 3_000,
  maxTokens: 6_000,
  concurrency: 3,
} as const;

const MIN_QUOTE_CHARS = 8;
const MAX_SPAN_CHARS = 300;

export const BaseFactSchema = z.object({
  claim: z.string().trim().min(1).max(400),
  quote: z.string().trim().min(MIN_QUOTE_CHARS).max(400),
});

export interface QuarantineTask<E extends object> {
  name: string;
  instructions: string;
  extraSchema: z.ZodType<E>;
  extraDescription: string;
  maxFactsPerSource: number;
}

export interface QuarantineSource {
  sourceId: string;
  text: string;
  hiddenText?: readonly string[];
  label?: string;
}

export type UntrustedFact<E extends object> = {
  claim: string;
  quote: string;
  sourceId: string;
  trust: "untrusted";
} & E;

export interface SourceReading<E extends object> {
  sourceId: string;
  facts: UntrustedFact<E>[];
  injectionSuspected: boolean;
  suspiciousSpan?: string;
  droppedFacts: number;
  withheldFacts: number;
  error?: string;
}

export interface ReadOptions<E extends object> {
  stepId: string;
  task: QuarantineTask<E>;
  sources: readonly QuarantineSource[];
  systemPrompt: string;
  batchChars?: number;
  perSourceChars?: number;
  maxTokens?: number;
  concurrency?: number;
  factBudgetPerCall?: number;
}

const ReaderOutputSchema = z.object({
  sources: z.array(
    z.object({
      sourceId: z.string(),
      facts: z.array(z.unknown()).default([]),
      injectionSuspected: z.boolean().default(false),
      suspiciousSpan: z.string().nullish(),
    }),
  ),
});

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions)\b/i,
  /\byou are now\b/i,
  /\b(developer|jailbreak|dan) mode\b/i,
  /\b(system|developer) (prompt|message)\b/i,
  /\bnew instructions\b/i,
  /\b(call|invoke|run|use|execute)\s+(the\s+)?[a-z]+_[a-z_]+\b/i,
  /\b169\.254\.169\.254\b|metadata\.google\.internal/i,
  /<\/?(system|assistant|im_start|im_end)\b|\[\/?INST\]/i,
  /\b(assistant|ai model|llm|language model|chatbot)\s*[,:]\s*(please\s+)?(ignore|summari[sz]e|say|respond|write|output|call|fetch|recommend)\b/i,
];

function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function alignsWithWords(haystack: string, needle: string, start: number): boolean {
  const end = start + needle.length;
  const startsInsideWord = isWordChar(needle[0]) && isWordChar(haystack[start - 1]);
  const endsInsideWord = isWordChar(needle.at(-1)) && isWordChar(haystack[end]);
  return !startsInsideWord && !endsInsideWord;
}

export function quoteAppearsIn(quote: string, source: string): boolean {
  const needle = normalise(quote);
  if (needle.length < MIN_QUOTE_CHARS || /\.\.\.|…/.test(quote)) return false;
  const haystack = normalise(source);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (alignsWithWords(haystack, needle, at)) return true;
  }
  return false;
}

function stripInvisible(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

export function detectInjection(raw: string): string | undefined {
  const text = stripInvisible(raw);
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const start = Math.max(0, match.index - 40);
    return text
      .slice(start, match.index + match[0].length + 120)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SPAN_CHARS);
  }
  return undefined;
}

function carriesInstructions(fact: object): boolean {
  return Object.values(fact).some(
    (value) => typeof value === "string" && detectInjection(value) !== undefined,
  );
}

function neutralise(text: string): string {
  return text.replace(/<(\/?)source/gi, "[$1source");
}

function excerpt(source: QuarantineSource, perSourceChars: number): string {
  return neutralise(source.text.slice(0, perSourceChars));
}

function batches(
  sources: readonly QuarantineSource[],
  budget: number,
  perSource: number,
): QuarantineSource[][] {
  const result: QuarantineSource[][] = [];
  let current: QuarantineSource[] = [];
  let used = 0;
  for (const source of sources) {
    const size = Math.min(source.text.length, perSource) + 80;
    if (current.length > 0 && used + size > budget) {
      result.push(current);
      current = [];
      used = 0;
    }
    current.push(source);
    used += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function userPrompt<E extends object>(
  task: QuarantineTask<E>,
  batch: readonly QuarantineSource[],
  perSource: number,
  factsPerSource: number,
  totalFacts: number,
): string {
  const sources = batch
    .map((source) => {
      const label =
        source.label === undefined ? "" : ` label="${neutralise(source.label).replace(/"/g, "'")}"`;
      return `<source id="${source.sourceId}"${label}>\n${excerpt(source, perSource)}\n</source>`;
    })
    .join("\n\n");
  return [
    `## Task: ${task.name}`,
    task.instructions,
    `Each fact has "claim", "quote" and these task fields: ${task.extraDescription}`,
    `At most ${totalFacts} facts in total and at most ${factsPerSource} per source; prefer the most specific facts. Keep claims under 25 words and quotes under 160 characters; the answer must stay short.`,
    "## Sources",
    sources,
  ].join("\n\n");
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await work(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function assemble<E extends object>(
  task: QuarantineTask<E>,
  source: QuarantineSource,
  reported: z.infer<typeof ReaderOutputSchema>["sources"][number] | undefined,
  factsPerSource: number,
): SourceReading<E> {
  const factSchema = BaseFactSchema.and(task.extraSchema);
  const facts: UntrustedFact<E>[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let withheld = 0;
  for (const raw of reported?.facts ?? []) {
    const parsed = factSchema.safeParse(raw);
    if (!parsed.success || !quoteAppearsIn(parsed.data.quote, source.text)) {
      dropped += 1;
      continue;
    }
    if (carriesInstructions(parsed.data)) {
      withheld += 1;
      continue;
    }
    const key = normalise(parsed.data.quote);
    if (seen.has(key) || facts.length >= factsPerSource) continue;
    seen.add(key);
    facts.push({ ...parsed.data, sourceId: source.sourceId, trust: "untrusted" });
  }
  const heuristicSpan =
    detectInjection(source.text) ??
    source.hiddenText?.map((hidden) => detectInjection(hidden)).find((span) => span !== undefined);
  const modelSpan = reported?.suspiciousSpan?.trim();
  const verifiedModelSpan =
    modelSpan !== undefined && modelSpan !== "" && quoteAppearsIn(modelSpan, source.text)
      ? modelSpan.slice(0, MAX_SPAN_CHARS)
      : undefined;
  const injectionSuspected = reported?.injectionSuspected === true || heuristicSpan !== undefined;
  const suspiciousSpan = verifiedModelSpan ?? heuristicSpan;
  return {
    sourceId: source.sourceId,
    facts,
    injectionSuspected,
    ...(injectionSuspected && suspiciousSpan !== undefined ? { suspiciousSpan } : {}),
    droppedFacts: dropped,
    withheldFacts: withheld,
  };
}

export async function readUntrusted<E extends object>(
  ctx: RunContext,
  options: ReadOptions<E>,
): Promise<SourceReading<E>[]> {
  const perSource = options.perSourceChars ?? READER_DEFAULTS.perSourceChars;
  const groups = batches(
    options.sources,
    options.batchChars ?? READER_DEFAULTS.batchChars,
    perSource,
  );
  const grouped = await mapLimited(
    groups,
    options.concurrency ?? READER_DEFAULTS.concurrency,
    async (batch) => {
      const factsPerSource = options.task.maxFactsPerSource;
      const totalFacts = Math.max(1, options.factBudgetPerCall ?? factsPerSource * batch.length);
      try {
        const result = await callStructured(ctx, {
          role: "fast",
          stepId: options.stepId,
          system: options.systemPrompt,
          user: userPrompt(options.task, batch, perSource, factsPerSource, totalFacts),
          schema: ReaderOutputSchema,
          maxTokens: options.maxTokens ?? READER_DEFAULTS.maxTokens,
          temperature: 0,
        });
        let remaining = totalFacts;
        return batch.map((source) => {
          const reading = assemble(
            options.task,
            source,
            result.value.sources.find((entry) => entry.sourceId === source.sourceId),
            factsPerSource,
          );
          const kept = reading.facts.slice(0, Math.max(0, remaining));
          remaining -= kept.length;
          return { ...reading, facts: kept };
        });
      } catch (error) {
        if (!(error instanceof StructuredOutputError)) throw error;
        return batch.map((source) => ({
          ...assemble(options.task, source, undefined, factsPerSource),
          error: error.message,
        }));
      }
    },
  );
  const readings = grouped.flat();
  for (const reading of readings) {
    if (!reading.injectionSuspected) continue;
    await ctx.emitter.emit({
      runId: ctx.runId,
      type: "critic.flagged",
      stepId: options.stepId,
      payload: {
        claimId: `injection:${reading.sourceId}`,
        claim: reading.suspiciousSpan ?? "Source contains text addressed to an AI system",
        reason: `Possible prompt injection in ${reading.sourceId}; the text was quarantined and never shown to a privileged agent`,
        severity: "warn",
        sourceId: reading.sourceId,
        category: "injection_suspected",
      },
    });
  }
  return readings;
}
