import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ChatMessage, type ModelStreamEvent, type StopReason } from "../../providers/types";
import { TEST_USAGE, scriptedProvider, testRun } from "../../testing/fakes";
import { defineTool, type RegisteredTool } from "../../tools/registry";
import { type RunContext } from "../context";
import { callModel, type ModelCallResult } from "../model-call";
import { describeIssues } from "../schema-repair";
import { StructuredOutputError, callStructured, type StructuredCallOptions } from "../structured";
import { repairToolCall } from "../tool-args";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const CaseSchema = z.object({
  id: z.string(),
  kind: z.enum(["control", "syntax", "shape", "truncated", "unusable"]),
  schema: z.enum(["facts", "verdicts", "picks", "design"]),
  stop: z.enum(["end", "max_tokens"]),
  acceptable: z.array(z.unknown()),
  repairReply: z.boolean().optional(),
  continueReply: z.boolean().optional(),
  note: z.string().optional(),
});
type Case = z.infer<typeof CaseSchema>;

const cases = z
  .object({ cases: z.array(CaseSchema) })
  .parse(JSON.parse(fixture("index.json"))).cases;

const SCHEMAS: Record<Case["schema"], z.ZodType> = {
  facts: z.object({
    sources: z
      .array(
        z.object({
          sourceId: z.string().regex(/^S\d+$/),
          facts: z
            .array(
              z.object({
                claim: z.string().min(1).max(400),
                quote: z.string().min(1).max(400),
                topic: z.enum(["company", "offering", "customers", "tech", "news", "competitors"]),
              }),
            )
            .max(12),
          injectionSuspected: z.boolean(),
          suspiciousSpan: z.string().nullable().optional(),
        }),
      )
      .min(1),
  }),
  verdicts: z.object({
    results: z
      .array(
        z.object({
          id: z.string().min(1),
          atoms: z
            .array(
              z.object({
                text: z.string().min(1),
                verdict: z.enum(["supported", "contradicted", "not_enough_info"]),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  }),
  picks: z.object({
    picks: z
      .array(z.string().regex(/^C\d+$/))
      .min(1)
      .max(8),
    reason: z.string().max(300).optional(),
  }),
  design: z.strictObject({
    name: z.string().min(1),
    tone: z.enum(["formal", "friendly"]),
    maxAnswerSentences: z.number().int().min(1).max(12),
    topics: z.array(z.string().min(1)).min(1),
    escalate: z.boolean(),
  }),
};

const baseline = (() => {
  const MAX_ECHOED_ANSWER_CHARS = 12_000;
  const MAX_CLOSING_CANDIDATES = 20;

  function parseStrict(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  function withoutTrailingCommas(text: string): string {
    return text.replace(/,\s*([}\]])/g, "$1");
  }

  function quoteBareKeys(text: string): string {
    return text.replace(/([{,]\s*)"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:/g, '$1"$2":');
  }

  function tryParse(text: string): unknown {
    return (
      parseStrict(text) ??
      parseStrict(withoutTrailingCommas(text)) ??
      parseStrict(withoutTrailingCommas(quoteBareKeys(text)))
    );
  }

  function closeUnbalanced(text: string): string {
    const open: string[] = [];
    let inString = false;
    let escaped = false;
    for (const char of text) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") open.push("}");
      else if (char === "[") open.push("]");
      else if ((char === "}" || char === "]") && open.at(-1) === char) open.pop();
    }
    const body = inString ? `${text}"` : text.replace(/[\s,]+$/, "");
    return body + open.reverse().join("");
  }

  function extractJson(text: string): unknown {
    const trimmed = text.trim();
    const direct = tryParse(trimmed);
    if (direct !== undefined) return direct;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
    if (fenced !== undefined) {
      const parsed = tryParse(fenced.trim());
      if (parsed !== undefined) return parsed;
    }
    const start = trimmed.search(/[{[]/);
    if (start === -1) return undefined;
    const balanced = tryParse(closeUnbalanced(trimmed.slice(start)));
    if (balanced !== undefined) return balanced;
    const closer = trimmed[start] === "{" ? "}" : "]";
    let end = trimmed.lastIndexOf(closer);
    for (let attempt = 0; end > start && attempt < MAX_CLOSING_CANDIDATES; attempt += 1) {
      const parsed = tryParse(trimmed.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
      end = trimmed.lastIndexOf(closer, end - 1);
    }
    return undefined;
  }

  function validate<T>(
    schema: z.ZodType<T>,
    result: ModelCallResult,
  ): { ok: true; value: T } | { ok: false; issues: string } {
    if (result.text.trim() === "") return { ok: false, issues: "- (root): the answer was empty." };
    const json = extractJson(result.text);
    if (json === undefined) {
      const truncated =
        result.stopReason === "max_tokens"
          ? " The answer was cut off at the token limit; be more concise."
          : "";
      return {
        ok: false,
        issues: `- (root): the answer did not contain a parseable JSON value.${truncated}`,
      };
    }
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, issues: describeIssues(parsed.error) };
  }

  async function call<T>(ctx: RunContext, options: StructuredCallOptions<T>) {
    const messages: ChatMessage[] = [{ role: "user", content: options.user }];
    const request = (history: ChatMessage[]) => ({
      role: options.role,
      stepId: options.stepId,
      request: { system: options.system, messages: history, maxTokens: options.maxTokens },
    });
    const first = await callModel(ctx, request(messages));
    const firstCheck = validate(options.schema, first);
    if (firstCheck.ok) return { value: firstCheck.value };
    const second = await callModel(
      ctx,
      request([
        ...messages,
        { role: "assistant", content: first.text.slice(0, MAX_ECHOED_ANSWER_CHARS) },
        {
          role: "user",
          content: `Your previous answer could not be used because it failed validation:\n${firstCheck.issues}\n\nReply with only the corrected JSON object. No prose, no code fences.`,
        },
      ]),
    );
    const secondCheck = validate(options.schema, second);
    if (secondCheck.ok) return { value: secondCheck.value };
    throw new StructuredOutputError("failed after one repair attempt", secondCheck.issues);
  }

  return { call };
})();

type Pipeline = (
  ctx: RunContext,
  options: StructuredCallOptions<unknown>,
) => Promise<{ value: unknown }>;

function turn(text: string, reason: StopReason): ModelStreamEvent[] {
  return [
    ...(text === "" ? [] : [{ type: "text_delta" as const, text }]),
    { type: "usage", usage: TEST_USAGE },
    { type: "stop", reason },
  ];
}

const GIVES_UP = "I am sorry, I cannot produce that.";

function optional(present: boolean | undefined, name: string): string | undefined {
  return present === true ? fixture(name) : undefined;
}

interface Outcome {
  id: string;
  kind: Case["kind"];
  result: "sound" | "corrupted" | "failed";
  calls: number;
}

async function measure(entry: Case, pipeline: Pipeline): Promise<Outcome> {
  const repair = optional(entry.repairReply, `outputs/${entry.id}.repair.txt`);
  const continuation = optional(entry.continueReply, `outputs/${entry.id}.continue.txt`);
  const provider = scriptedProvider("fake", (request, index) => {
    if (index === 0) return turn(fixture(`outputs/${entry.id}.txt`), entry.stop);
    const asked = request.messages.at(-1)?.content ?? "";
    const reply = asked.includes("cut off before the JSON was complete")
      ? (continuation ?? repair)
      : repair;
    return turn(reply ?? GIVES_UP, "end");
  });
  const { ctx } = testRun({ provider });
  const base = { id: entry.id, kind: entry.kind };
  try {
    const { value } = await pipeline(ctx, {
      role: "fast",
      stepId: "s1",
      system: "Return only the JSON object.",
      user: "Extract.",
      schema: SCHEMAS[entry.schema],
      maxTokens: 400,
    });
    const plain: unknown = JSON.parse(JSON.stringify(value));
    const sound = entry.acceptable.some((candidate) => isDeepStrictEqual(candidate, plain));
    return { ...base, result: sound ? "sound" : "corrupted", calls: provider.requests.length };
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;
    return { ...base, result: "failed", calls: provider.requests.length };
  }
}

function summarise(outcomes: readonly Outcome[]) {
  const count = (test: (outcome: Outcome) => boolean) => outcomes.filter(test).length;
  return {
    outputs: outcomes.length,
    soundInOneCall: count((outcome) => outcome.result === "sound" && outcome.calls === 1),
    soundAfterFollowUp: count((outcome) => outcome.result === "sound" && outcome.calls === 2),
    corrupted: count((outcome) => outcome.result === "corrupted"),
    failed: count((outcome) => outcome.result === "failed"),
    modelCalls: outcomes.reduce((sum, outcome) => sum + outcome.calls, 0),
  };
}

async function runAll(pipeline: Pipeline): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const entry of cases) outcomes.push(await measure(entry, pipeline));
  return outcomes;
}

const ids = (outcomes: readonly Outcome[], result: Outcome["result"]) =>
  outcomes.filter((outcome) => outcome.result === result).map((outcome) => outcome.id);

describe("structured-output reliability bench (recorded shapes, scripted model, no network)", () => {
  it("has a corpus that covers every class and still contains answers nobody can read", () => {
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    expect(new Set(cases.map((entry) => entry.kind))).toEqual(
      new Set(["control", "syntax", "shape", "truncated", "unusable"]),
    );
  });

  it("before: the reader at ef131fc", async () => {
    const outcomes = await runAll(baseline.call);
    expect(summarise(outcomes)).toEqual({
      outputs: 39,
      soundInOneCall: 7,
      soundAfterFollowUp: 27,
      corrupted: 4,
      failed: 1,
      modelCalls: 67,
    });
    expect(ids(outcomes, "corrupted")).toEqual([
      "cut-in-optional-string",
      "cut-in-last-item-text",
      "cut-in-verbatim-quote",
      "cut-in-number",
    ]);
  });

  it("after: one read, fit and follow-up path", async () => {
    const outcomes = await runAll(callStructured);
    expect(summarise(outcomes)).toEqual({
      outputs: 39,
      soundInOneCall: 29,
      soundAfterFollowUp: 9,
      corrupted: 0,
      failed: 1,
      modelCalls: 49,
    });
    expect(ids(outcomes, "failed")).toEqual(["missing-required-twice"]);
    expect(
      outcomes.filter((outcome) => outcome.kind === "control").every((o) => o.calls === 1),
    ).toBe(true);
  });

  it("needs a second call where the earlier reader made one, or where it accepted a corrupted value", async () => {
    const before = await runAll(baseline.call);
    const after = await runAll(callStructured);
    const extra = after.filter((outcome, index) => outcome.calls > (before[index]?.calls ?? 0));
    expect(extra.map((outcome) => outcome.id)).toEqual(["cut-in-number"]);
    expect(before.find((outcome) => outcome.id === "cut-in-number")?.result).toBe("corrupted");
  });
});

const ToolCaseSchema = z.object({
  id: z.string(),
  tool: z.string(),
  arguments: z.string(),
  expected: z.unknown(),
  note: z.string().optional(),
});

const toolCases = z
  .object({ cases: z.array(ToolCaseSchema) })
  .parse(JSON.parse(fixture("tool-arguments.json"))).cases;

function tool<I>(name: string, inputSchema: z.ZodType<I>): RegisteredTool {
  return defineTool({
    name,
    description: name,
    capability: CAPABILITIES.webFetch,
    inputSchema,
    targetDomain: () => undefined,
    summariseArgs: () => name,
    execute: () => Promise.resolve({ summary: "", forModel: "" }),
  });
}

const TOOLS = [
  tool("fetch_page", z.object({ url: z.url(), maxChars: z.number().int().positive().optional() })),
  tool(
    "search_reference",
    z.object({
      queries: z.array(z.string().min(2)).min(1).max(3),
      target: z.string().min(2).optional(),
    }),
  ),
  tool("list_sources", z.object({})),
];

function accepted(name: string, argumentsJson: string): { args: unknown } | undefined {
  let parsed: unknown = {};
  if (argumentsJson.trim() !== "") {
    try {
      parsed = JSON.parse(argumentsJson);
    } catch {
      return undefined;
    }
  }
  const prepared = TOOLS.find((candidate) => candidate.name === name)?.prepare(parsed);
  return prepared?.ok === true ? { args: prepared.call.args } : undefined;
}

function toolSummary(repair: boolean) {
  let sound = 0;
  let wronglyAccepted = 0;
  let refused = 0;
  for (const entry of toolCases) {
    const call = { id: "call_1", name: entry.tool, argumentsJson: entry.arguments };
    const sent = repair ? repairToolCall(TOOLS, call) : call;
    const outcome = accepted(sent.name, sent.argumentsJson);
    if (outcome === undefined) refused += 1;
    else if (isDeepStrictEqual(outcome.args, entry.expected)) sound += 1;
    else wronglyAccepted += 1;
  }
  return { calls: toolCases.length, sound, wronglyAccepted, refused };
}

describe("tool-call argument bench", () => {
  it("before: arguments must be strict JSON that fits the schema", () => {
    expect(toolSummary(false)).toEqual({ calls: 12, sound: 2, wronglyAccepted: 0, refused: 10 });
  });

  it("after: syntax and type repairs, and nothing that should be refused gets through", () => {
    expect(toolSummary(true)).toEqual({ calls: 12, sound: 9, wronglyAccepted: 0, refused: 3 });
  });
});
