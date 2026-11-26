import { describe, expect, it } from "vitest";

import { joinContinuation, readJson } from "./json-repair";

const value = (text: string) => {
  const reading = readJson(text);
  return reading.ok ? reading.value : undefined;
};

describe("readJson", () => {
  it("reads strict JSON without calling it repaired", () => {
    expect(readJson(' {"a":[1,2,{"b":null}]} ')).toEqual({
      ok: true,
      value: { a: [1, 2, { b: null }] },
      truncated: false,
      repaired: false,
    });
  });

  it.each([
    ["single quotes", "{'a': 'it's fine', 'b': ['x']}", { a: "it's fine", b: ["x"] }],
    ["Python literals", '{"a": True, "b": False, "c": None}', { a: true, b: false, c: null }],
    ["comments", '{"a": 1, // one\n /* two */ "b": 2}', { a: 1, b: 2 }],
    ["trailing commas", '{"a":[1,2,],"b":{"c":3,},}', { a: [1, 2], b: { c: 3 } }],
    ["bare and half-quoted keys", '{a: 1, b": 2, "c": 3}', { a: 1, b: 2, c: 3 }],
    ["missing commas", '{"a": "x"\n "b": ["y" "z"]}', { a: "x", b: ["y", "z"] }],
    ["unescaped inner quotes", '{"a":"the "big" one","b":1}', { a: 'the "big" one', b: 1 }],
    ["a raw newline in a string", '{"a":"line one\nline two"}', { a: "line one\nline two" }],
    ["a missing closing bracket", '{"a":[{"b":[1,2}],"c":3}', { a: [{ b: [1, 2] }], c: 3 }],
    ["text around the value", 'Sure:\n```json\n{"a":1}\n```\nDone.', { a: 1 }],
    ["braces in the prose before it", 'Shape {a: ...} gives {"a":1}', { a: 1 }],
    ["a citation marker before it", 'As noted [1], {"a":{"b":2}}', { a: { b: 2 } }],
    ["an escaped unicode character", '{"a":"caf\\u00e9",}', { a: "café" }],
  ])("repairs %s", (_label, text, expected) => {
    const reading = readJson(text);
    expect(reading).toEqual({ ok: true, value: expected, truncated: false, repaired: true });
  });

  it("does not let a key named __proto__ reach the prototype", () => {
    const parsed = value('{"__proto__": {"polluted": true}, "a": 1,}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["__proto__", "a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["inside a string", '{"a":1,"b":"cut of', { a: 1 }],
    ["after a key", '{"a":1,"b":', { a: 1 }],
    ["inside a key", '{"a":1,"b', { a: 1 }],
    ["inside a number", '{"a":1,"b":12', { a: 1 }],
    ["inside a literal", '{"a":1,"b":tr', { a: 1 }],
    ["inside an escape", '{"a":1,"b":"x\\', { a: 1 }],
    ["inside an array item", '{"items":[{"id":1},{"id":2,"text":"cu', { items: [{ id: 1 }] }],
    ["inside a nested object", '{"a":{"b":1,"c":"cu', { a: { b: 1 } }],
    ["inside an unterminated fence", '```json\n{"a":[1,2,3', { a: [1, 2] }],
  ])("keeps only complete elements when the answer stops %s", (_label, text, expected) => {
    expect(readJson(text)).toEqual({ ok: true, value: expected, truncated: true, repaired: true });
  });

  it("never completes a string, a number or a literal that was cut", () => {
    expect(JSON.stringify(value('{"quote":"Leases start at 1,9'))).toBeUndefined();
    expect(readJson('{"quote":"Leases start at 1,9')).toEqual({ ok: false, truncated: true });
    expect(readJson('{"count":1')).toEqual({ ok: false, truncated: true });
  });

  it("reports an answer without any JSON as unreadable, not truncated", () => {
    expect(readJson("I could not find anything.")).toEqual({ ok: false, truncated: false });
    expect(readJson("")).toEqual({ ok: false, truncated: false });
  });

  it("refuses absurd nesting instead of overflowing the stack", () => {
    expect(readJson(`${"[".repeat(5000)}1`)).toMatchObject({ ok: false });
  });
});

describe("joinContinuation", () => {
  it("appends a reply that continues exactly where the answer stopped", () => {
    expect(joinContinuation('{"a":"pass', 'word","b":1}')).toBe('{"a":"password","b":1}');
  });

  it("removes a repeated tail and a code fence from the reply", () => {
    expect(
      joinContinuation('{"a":1,"topics":["x","le', '```json\n"topics":["x","left"]}\n```'),
    ).toBe('{"a":1,"topics":["x","left"]}');
  });

  it("does not treat a short coincidence as a repeat", () => {
    expect(joinContinuation('{"a":"miss', 'ssippi"}')).toBe('{"a":"missssippi"}');
  });
});
