import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { StructuredOutputError, callStructured, extractJson } from "./structured";

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
    ['{"a":{"b":"cut off', { a: { b: "cut off" } }],
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
      textTurn('{"section":{"status":"ok","claims":[3]}}'),
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
