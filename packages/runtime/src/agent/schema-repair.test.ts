import { describe, expect, it } from "vitest";
import { z } from "zod";

import { describeIssues, fitToSchema } from "./schema-repair";

const Item = z.object({
  id: z.string(),
  score: z.number(),
  verdict: z.enum(["supported", "not_enough_info"]),
  note: z.string().optional(),
  kept: z.boolean(),
});
const Report = z.object({ items: z.array(Item).min(1) });

const item = { id: "c1", score: 0.5, verdict: "supported", kept: true };

function fitted<T>(schema: z.ZodType<T>, input: unknown): T {
  const fit = fitToSchema(schema, input);
  if (!fit.ok) throw new Error(describeIssues(fit.error));
  return fit.value;
}

describe("fitToSchema", () => {
  it("returns a valid value untouched and reports no repairs", () => {
    const input = { items: [item] };
    expect(fitToSchema(Report, input)).toEqual({ ok: true, value: input, input, repairs: [] });
  });

  it.each([
    ["a number written as a string", { ...item, score: "0.5" }],
    ["a boolean written as a string", { ...item, kept: "True" }],
    ["an enum value in another case", { ...item, verdict: "Supported" }],
    ["null for an optional field", { ...item, note: null }],
  ])("repairs %s", (_label, broken) => {
    expect(fitted(Report, { items: [broken] })).toEqual({ items: [item] });
  });

  it("repairs enum values that differ in separators only when one value matches", () => {
    expect(
      fitted(Report, { items: [{ ...item, verdict: "Not enough info" }] }).items[0]?.verdict,
    ).toBe("not_enough_info");
    expect(fitToSchema(Report, { items: [{ ...item, verdict: "maybe" }] }).ok).toBe(false);
  });

  it("writes a number as text where text is expected", () => {
    expect(fitted(Report, { items: [{ ...item, id: 7 }] }).items[0]?.id).toBe("7");
  });

  it("wraps one object where an array of them is expected", () => {
    expect(fitted(Report, { items: item })).toEqual({ items: [item] });
  });

  it("parses a JSON value that was encoded as a string", () => {
    expect(fitted(Report, { items: JSON.stringify([item]) })).toEqual({ items: [item] });
    expect(fitted(Report, JSON.stringify({ items: [item] }))).toEqual({ items: [item] });
  });

  it("unwraps a known wrapper key and places a bare array under the only array field", () => {
    expect(fitted(Report, { result: { items: [item] } })).toEqual({ items: [item] });
    expect(fitted(Report, [item])).toEqual({ items: [item] });
    expect(fitToSchema(Report, { anything: { items: [item] } }).ok).toBe(false);
  });

  it("removes unknown keys from a strict object", () => {
    const Strict = z.strictObject({ a: z.number() });
    expect(fitted(Strict, { a: 1, b: 2 })).toEqual({ a: 1 });
  });

  it("combines repairs across passes and lists them", () => {
    const fit = fitToSchema(Report, { data: [{ ...item, score: "2", kept: "false", note: null }] });
    expect(fit).toMatchObject({
      ok: true,
      value: { items: [{ ...item, score: 2, kept: false }] },
    });
    expect(fit.repairs.length).toBeGreaterThanOrEqual(4);
  });

  it("does not change the caller's value", () => {
    const input = { items: [{ ...item, score: "0.5" }] };
    fitToSchema(Report, input);
    expect(input.items[0]?.score).toBe("0.5");
  });

  it.each([
    ["words where a number is expected", { items: [{ ...item, score: "high" }] }],
    ["a missing required field", { items: [{ id: "c1" }] }],
    ["null for a required field", { items: [{ ...item, kept: null }] }],
    ["an empty list where one item is required", { items: [] }],
  ])("leaves %s to the follow-up turn and reports the original issues", (_label, input) => {
    const fit = fitToSchema(Report, input);
    expect(fit.ok).toBe(false);
    if (!fit.ok) expect(describeIssues(fit.error)).toMatch(/^- items/);
  });

  it("repairs inside the closest branch of a union", () => {
    const Section = z.object({
      section: z.union([
        z.object({ status: z.literal("ok"), count: z.number() }),
        z.object({ status: z.literal("none"), note: z.string() }),
      ]),
    });
    expect(fitted(Section, { section: { status: "ok", count: "3" } })).toEqual({
      section: { status: "ok", count: 3 },
    });
  });
});
