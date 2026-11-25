import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseModelsConfig } from "../models";
import { type ModelProvider, type ModelStreamEvent } from "../providers/types";
import {
  TEST_MODELS_CONFIG,
  TEST_USAGE,
  scriptedProvider,
  testRun,
  textTurn,
} from "../testing/fakes";
import { ModelStreamError } from "./model-call";
import {
  STREAM_RETRY_BACKOFF_MS,
  StructuredOutputError,
  callStructured,
  callStructuredReviewed,
  extractJson,
} from "./structured";

const Schema = z.object({ name: z.string(), count: z.number().int() });

describe("extractJson", () => {
  it("repairs bare and half-quoted keys as a last resort", () => {
    expect(
      extractJson(
        '{"facts":[{"claim":"Collects payments.",quote":"Collect payments.", topic:"offering"}]}',
      ),
    ).toEqual({
      facts: [{ claim: "Collects payments.", quote: "Collect payments.", topic: "offering" }],
    });
  });

  it.each([
    ['{"a":1}', { a: 1 }],
    ['Here you go:\n```json\n{"a":2}\n```', { a: 2 }],
    ['noise {"a":{"b":[1,2]}} trailing', { a: { b: [1, 2] } }],
    ["no json here", undefined],
    ['{"a":[1,2,],"b":{"c":3,},}', { a: [1, 2], b: { c: 3 } }],
    ['{"a":{"b":[{"c":"x}]"}]}', { a: { b: [{ c: "x}]" }] } }],
    ['{"a":{"b":"cut off', { a: {} }],
    ['{"a":1,"b":{"c":"kept","d":"cut off', { a: 1, b: { c: "kept" } }],
    ['{"a":', undefined],
  ])("extracts from %j", (text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });
});

describe("callStructured", () => {
  const options = {
    role: "fast" as const,
    stepId: "s1",
    system: "Return JSON.",
    user: "Describe.",
    schema: Schema,
    maxTokens: 200,
  };

  it("parses valid output on the first try", async () => {
    const provider = scriptedProvider("fake", [textTurn('{"name":"Acme","count":3}')]);
    const { ctx } = testRun({ provider });
    const result = await callStructured(ctx, options);
    expect(result).toMatchObject({ value: { name: "Acme", count: 3 }, repaired: false });
  });

  it("repairs once with the validation issues and the previous answer", async () => {
    const provider = scriptedProvider("fake", [
      textTurn('{"name":"Acme","count":"three"}'),
      textTurn('{"name":"Acme","count":3}'),
    ]);
    const { ctx, events } = testRun({ provider });
    const result = await callStructured(ctx, options);
    expect(result.repaired).toBe(true);
    expect(result.value.count).toBe(3);
    const repair = provider.requests[1];
    expect(repair?.system).toBe("Return JSON.");
    expect(repair?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(repair?.messages[2]?.content).toContain("count");
    expect(events.filter((event) => event.type === "usage.updated")).toHaveLength(2);
  });

  it("explains which union branch failed instead of a bare invalid input", async () => {
    const Union = z.object({
      section: z.union([
        z
          .object({ status: z.literal("ok"), claims: z.array(z.string()).min(1) })
          .refine(() => true),
        z.object({ status: z.literal("none"), note: z.string() }),
      ]),
    });
    const provider = scriptedProvider("fake", [
      textTurn('{"section":{"status":"ok","claims":[{"text":"a claim"}]}}'),
      textTurn('{"section":{"status":"none","note":"x"}}'),
    ]);
    const { ctx } = testRun({ provider });
    await callStructured(ctx, { ...options, schema: Union });
    const repair = provider.requests[1]?.messages[2]?.content ?? "";
    expect(repair).toContain("section.claims.0");
    expect(repair).not.toMatch(/section: Invalid input/);
  });

  it("fails after a single unsuccessful repair", async () => {
    const provider = scriptedProvider("fake", [textTurn("nope"), textTurn("still nope")]);
    const { ctx } = testRun({ provider });
    await expect(callStructured(ctx, options)).rejects.toBeInstanceOf(StructuredOutputError);
    expect(provider.requests).toHaveLength(2);
  });

  it("says when the model returned no answer text at all", async () => {
    const provider = scriptedProvider("fake", [
      [
        { type: "reasoning_delta", text: "thinking only" },
        { type: "stop", reason: "end" },
      ],
      [
        { type: "reasoning_delta", text: "still thinking" },
        { type: "stop", reason: "end" },
      ],
    ]);
    const { ctx } = testRun({ provider });
    const error = await callStructured(ctx, options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).issues).toMatch(/empty/);
  });

  it("does not repair a refusal", async () => {
    const provider = scriptedProvider("fake", [
      [
        { type: "text_delta", text: "I can't help" },
        { type: "stop", reason: "refusal" },
      ],
    ]);
    const { ctx } = testRun({ provider });
    await expect(callStructured(ctx, options)).rejects.toThrow(/refus/);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("callStructured follow-up turn", () => {
  const Items = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })).min(2) });
  const options = {
    role: "fast" as const,
    stepId: "s1",
    system: "Return JSON.",
    user: "List.",
    schema: Items,
    maxTokens: 200,
  };
  const cut = (text: string): ModelStreamEvent[] => [
    { type: "text_delta", text },
    { type: "usage", usage: TEST_USAGE },
    { type: "stop", reason: "max_tokens" },
  ];
  const full = {
    items: [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ],
  };

  it("accepts the complete items of a cut-off answer without another call", async () => {
    const provider = scriptedProvider("fake", [
      cut('{"items":[{"id":"a","text":"first"},{"id":"b","text":"second"},{"id":"c","text":"thi'),
    ]);
    const result = await callStructured(testRun({ provider }).ctx, options);
    expect(result).toMatchObject({ value: full, repaired: false });
    expect(provider.requests).toHaveLength(1);
  });

  it("asks a cut-off answer to continue and joins the reply to it", async () => {
    const provider = scriptedProvider("fake", [
      cut('{"items":[{"id":"a","text":"first"},{"id":"b","text":"sec'),
      textTurn('ond"}]}'),
    ]);
    const result = await callStructured(testRun({ provider }).ctx, options);
    expect(result).toMatchObject({ value: full, repaired: true });
    const asked = provider.requests[1]?.messages ?? [];
    expect(asked[1]?.content).toBe('{"items":[{"id":"a","text":"first"},{"id":"b","text":"sec');
    expect(asked[2]?.content).toMatch(/cut off before the JSON was complete/);
    expect(asked[2]?.content).not.toMatch(/failed validation/);
  });

  it("uses a shorter restatement when the model does not continue", async () => {
    const provider = scriptedProvider("fake", [
      cut('{"items":[{"id":"a","text":"first"},{"id":"b","text":"sec'),
      textTurn(JSON.stringify(full)),
    ]);
    const result = await callStructured(testRun({ provider }).ctx, options);
    expect(result).toMatchObject({ value: full, repaired: true });
  });

  it("makes one continuation at most", async () => {
    const provider = scriptedProvider("fake", [
      cut('{"items":[{"id":"a","text":"fir'),
      cut('st"},{"id":"b","text":"sec'),
    ]);
    await expect(callStructured(testRun({ provider }).ctx, options)).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
    expect(provider.requests).toHaveLength(2);
  });

  it("explains validation issues instead of asking to continue when the JSON was complete", async () => {
    const provider = scriptedProvider("fake", [
      cut('{"items":[{"id":"a","text":"first"}]}'),
      textTurn(JSON.stringify(full)),
    ]);
    await callStructured(testRun({ provider }).ctx, options);
    expect(provider.requests[1]?.messages[2]?.content).toMatch(/failed validation/);
  });

  it("does not start a follow-up turn the step budget cannot pay for", async () => {
    const provider = scriptedProvider("fake", [
      textTurn("not json"),
      textTurn(JSON.stringify(full)),
    ]);
    const { ctx, events } = testRun({ provider, maxTokens: 170 });
    const error = await callStructured(ctx, options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as Error).message).toMatch(/budget cannot pay/);
    expect(provider.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === "usage.updated")).toHaveLength(1);
  });

  it("retries a stream that fails mid-answer once, after a short backoff", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "fake",
      async *stream() {
        calls += 1;
        await Promise.resolve();
        if (calls === 1) {
          yield { type: "text_delta", text: '{"items":[' };
          throw new Error("socket hang up");
        }
        yield* textTurn(JSON.stringify(full));
      },
    };
    const { ctx, sleeps } = testRun({ provider });
    const result = await callStructured(ctx, options);
    expect(result).toMatchObject({ value: full, repaired: false });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([STREAM_RETRY_BACKOFF_MS]);
  });

  it("gives up after a second stream failure", async () => {
    const provider: ModelProvider = {
      id: "fake",
      async *stream() {
        await Promise.resolve();
        yield { type: "text_delta", text: "{" };
        throw new Error("socket hang up");
      },
    };
    await expect(callStructured(testRun({ provider }).ctx, options)).rejects.toBeInstanceOf(
      ModelStreamError,
    );
  });

  it("asks for a JSON object only from entries that support JSON mode", async () => {
    const plain = scriptedProvider("fake", [textTurn(JSON.stringify(full))]);
    await callStructured(testRun({ provider: plain }).ctx, options);
    expect(plain.requests[0]?.responseFormat).toBeUndefined();

    const config = parseModelsConfig({
      ...TEST_MODELS_CONFIG,
      roles: {
        ...TEST_MODELS_CONFIG.roles,
        fast: [
          {
            provider: "fake",
            model: "fake-fast",
            contextWindow: 32000,
            supportsTools: true,
            quirks: ["json-object"],
          },
        ],
      },
    });
    const json = scriptedProvider("fake", [textTurn(JSON.stringify(full))]);
    await callStructured(testRun({ provider: json, config }).ctx, options);
    expect(json.requests[0]?.responseFormat).toEqual({ type: "json_object" });
  });
});

describe("callStructuredReviewed", () => {
  const Items = z.object({ items: z.array(z.string()) });
  const options = {
    role: "fast" as const,
    stepId: "s1",
    system: "Return JSON.",
    user: "List.",
    schema: Items,
    maxTokens: 200,
  };
  const review = (value: z.infer<typeof Items>) => {
    const kept = value.items.filter((item) => item.startsWith("ok"));
    const rejected = value.items.filter((item) => !item.startsWith("ok"));
    return {
      result: kept,
      score: kept.length,
      feedback:
        kept.length >= 2
          ? undefined
          : `- ${rejected.map((item) => `${item}: does not start with ok`).join("\n- ")}`,
    };
  };

  it("accepts a first answer that passes review without a second call", async () => {
    const provider = scriptedProvider("fake", [textTurn('{"items":["ok a","ok b"]}')]);
    const { ctx } = testRun({ provider });
    const result = await callStructuredReviewed(ctx, { ...options, review });
    expect(result).toMatchObject({ result: ["ok a", "ok b"], revised: false });
    expect(provider.requests).toHaveLength(1);
  });

  it("asks once to fix rejected items with the reasons and keeps the better answer", async () => {
    const provider = scriptedProvider("fake", [
      textTurn('{"items":["ok a","bad b"]}'),
      textTurn('{"items":["ok a","ok b","ok c"]}'),
    ]);
    const { ctx } = testRun({ provider });
    const result = await callStructuredReviewed(ctx, { ...options, review });
    expect(result).toMatchObject({ result: ["ok a", "ok b", "ok c"], revised: true });
    const revision = provider.requests[1];
    expect(revision?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(revision?.messages[2]?.content).toContain("bad b: does not start with ok");
    expect(result.calls).toHaveLength(2);
  });

  it("keeps the first answer when the revision is worse, invalid or unavailable", async () => {
    const worse = scriptedProvider("fake", [
      textTurn('{"items":["ok a","bad b"]}'),
      textTurn('{"items":["bad"]}'),
    ]);
    const first = await callStructuredReviewed(testRun({ provider: worse }).ctx, {
      ...options,
      review,
    });
    expect(first).toMatchObject({ result: ["ok a"], revised: false });

    const invalid = scriptedProvider("fake", [
      textTurn('{"items":["ok a","bad b"]}'),
      textTurn("not json"),
    ]);
    const second = await callStructuredReviewed(testRun({ provider: invalid }).ctx, {
      ...options,
      review,
    });
    expect(second).toMatchObject({ result: ["ok a"], revised: false });
  });

  it("skips the revision when the step budget cannot pay for it", async () => {
    const provider = scriptedProvider("fake", [
      textTurn('{"items":["ok a","bad b"]}'),
      textTurn('{"items":["ok a","ok b"]}'),
    ]);
    const { ctx } = testRun({ provider, maxTokens: 170 });
    const result = await callStructuredReviewed(ctx, { ...options, review });
    expect(result).toMatchObject({ result: ["ok a"], revised: false });
    expect(provider.requests).toHaveLength(1);
  });

  it("skips the revision when the caller has no time for it", async () => {
    const provider = scriptedProvider("fake", [textTurn('{"items":["bad"]}')]);
    const { ctx } = testRun({ provider });
    const result = await callStructuredReviewed(ctx, {
      ...options,
      review,
      canRevise: () => false,
    });
    expect(result).toMatchObject({ result: [], revised: false });
    expect(provider.requests).toHaveLength(1);
  });
});
