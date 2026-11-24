import { describe, expect, it } from "vitest";

import { createMemorySink, parseEventLog, serialiseEventLog } from "./event-log";

const created = {
  runId: "run_1",
  type: "run.created" as const,
  payload: {
    workspaceId: "eval",
    missionId: "company-xray",
    input: { url: "https://example.com/" },
    actor: { type: "system" as const, id: "eval" },
    budget: { maxTokens: 1000, maxMicroUsd: 0 },
  },
};

describe("createMemorySink", () => {
  it("assigns sequence numbers and timestamps and validates every event", async () => {
    let tick = Date.parse("2026-11-24T10:00:00.000Z");
    const sink = createMemorySink(() => new Date((tick += 1000)));
    await sink.emit(created);
    await sink.emit({ runId: "run_1", type: "run.completed", payload: { summary: "done" } });
    expect(sink.events.map((event) => [event.seq, event.at])).toEqual([
      [1, "2026-11-24T10:00:01.000Z"],
      [2, "2026-11-24T10:00:02.000Z"],
    ]);
    await expect(
      sink.emit({ runId: "run_1", type: "run.completed", payload: {} } as never),
    ).rejects.toThrow();
  });
});

describe("event log files", () => {
  it("round-trips through JSONL", async () => {
    const sink = createMemorySink(() => new Date("2026-11-24T10:00:00.000Z"));
    await sink.emit(created);
    const text = serialiseEventLog(sink.events);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseEventLog(text)).toEqual(sink.events);
  });

  it("names the broken line", () => {
    expect(() => parseEventLog('{"type":"nope"}\n')).toThrow(/line 1/);
  });
});
