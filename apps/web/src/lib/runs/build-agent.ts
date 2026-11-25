import type { RunEvent } from "@delegate/runtime";

import {
  ASSISTANT_EVALS_KIND,
  ASSISTANT_KIND,
  type AssistantArtifact,
  AssistantArtifactSchema,
  type AssistantEvals,
  AssistantEvalsSchema,
  type CitationRef,
  GAPS_REPORT_KIND,
  type GapsReport,
  GapsReportSchema,
} from "@/lib/m3-contract";

export interface BuildAgentDeliverables {
  assistant: AssistantArtifact | null;
  evals: AssistantEvals | null;
  gaps: GapsReport | null;
  invalid: string[];
}

export function latestContentByKind(events: readonly RunEvent[]): Map<string, unknown> {
  const kindById = new Map<string, string>();
  const latest = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "artifact.created")
      kindById.set(event.payload.artifactId, event.payload.kind);
    if (event.type !== "artifact.created" && event.type !== "artifact.updated") continue;
    const kind = kindById.get(event.payload.artifactId);
    if (kind === undefined || event.payload.content === undefined) continue;
    latest.set(kind, event.payload.content);
  }
  return latest;
}

export function buildAgentDeliverables(events: readonly RunEvent[]): BuildAgentDeliverables {
  const latest = latestContentByKind(events);
  const invalid: string[] = [];
  const parse = <T>(
    kind: typeof ASSISTANT_KIND | typeof ASSISTANT_EVALS_KIND | typeof GAPS_REPORT_KIND,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  ): T | null => {
    if (!latest.has(kind)) return null;
    const parsed = schema.safeParse(latest.get(kind));
    if (parsed.success) return parsed.data;
    invalid.push(kind);
    return null;
  };
  return {
    assistant: parse(ASSISTANT_KIND, AssistantArtifactSchema),
    evals: parse(ASSISTANT_EVALS_KIND, AssistantEvalsSchema),
    gaps: parse(GAPS_REPORT_KIND, GapsReportSchema),
    invalid,
  };
}

export interface EvalRow {
  id: string;
  question: string;
  answerable: boolean;
  expectedAnswer: string;
  verdict: "pass" | "fail" | "pending";
  answer: string | null;
  refused: boolean;
  reason: string | null;
  citations: CitationRef[];
}

export function evalRows(evals: AssistantEvals): EvalRow[] {
  const results = new Map(evals.results.map((result) => [result.caseId, result]));
  return evals.cases.map((testCase) => {
    const result = results.get(testCase.id);
    return {
      id: testCase.id,
      question: testCase.question,
      answerable: testCase.answerable,
      expectedAnswer: testCase.expectedAnswer,
      verdict: result?.verdict ?? "pending",
      answer: result?.answer ?? null,
      refused: result?.refused ?? false,
      reason: result?.reason ?? null,
      citations: result?.citations ?? [],
    };
  });
}

export function passRateLabel(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "n/a";
  return `${Math.round(rate * 100)}%`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
