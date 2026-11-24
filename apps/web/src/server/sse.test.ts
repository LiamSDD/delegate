import type { RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { createRunEventStream, formatSseEvent, parseResumeSeq } from "./sse";

const runId = "5d1f6a0e-8b8f-4f53-9a43-3f0f1d2b7c11";

function created(): RunEvent {
  return {
    runId,
    seq: 1,
    at: "2026-11-24T10:00:00.000Z",
    type: "run.created",
    payload: {
      workspaceId: "w",
      missionId: "company-xray",
      input: { url: "https://acme.com/" },
      actor: { type: "guest", id: "u" },
      budget: { maxTokens: 1, maxMicroUsd: 0 },
    },
  };
}

function message(seq: number): RunEvent {
  return {
    runId,
    seq,
    at: "2026-11-24T10:00:01.000Z",
    type: "run.completed",
    payload: { summary: `done ${seq}` },
  };
}

function usage(seq: number): RunEvent {
  return {
    runId,
    seq,
    at: "2026-11-24T10:00:01.000Z",
    type: "usage.updated",
    payload: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0,
      provider: "p",
      model: "m",
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

function frames(text: string) {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const fields: Record<string, string> = {};
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) fields.comment = line.slice(1).trim();
        const match = /^(id|event|data|retry): ?(.*)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2];
      }
      return fields;
    });
}

describe("formatSseEvent", () => {
  it("writes id as seq, event as type and data as JSON on one line", () => {
    expect(formatSseEvent(message(7))).toBe(
      `id: 7\nevent: run.completed\ndata: ${JSON.stringify(message(7))}\n\n`,
    );
  });
});

describe("parseResumeSeq", () => {
  it("prefers Last-Event-ID, then ?after, and ignores junk", () => {
    expect(parseResumeSeq("12", "3")).toBe(12);
    expect(parseResumeSeq(null, "3")).toBe(3);
    expect(parseResumeSeq("x", null)).toBe(0);
    expect(parseResumeSeq("-4", null)).toBe(0);
    expect(parseResumeSeq(null, null)).toBe(0);
  });
});

describe("createRunEventStream", () => {
  it("replays, announces live, then streams polled events until terminal", async () => {
    const log: RunEvent[] = [created(), usage(2)];
    const loads: number[] = [];
    let polls = 0;
    const stream = createRunEventStream({
      afterSeq: 0,
      signal: new AbortController().signal,
      pollMs: 250,
      heartbeatMs: 15_000,
      sleep: () => {
        polls += 1;
        if (polls === 2) log.push(usage(3));
        if (polls === 3) log.push(message(4));
        return Promise.resolve();
      },
      now: () => 0,
      source: {
        load: (after) => {
          loads.push(after);
          return Promise.resolve(log.filter((event) => event.seq > after));
        },
      },
    });
    const result = frames(await readAll(stream));
    expect(result[0]).toEqual({ retry: "2000" });
    expect(result[1]).toEqual({ event: "stream.replay", data: '{"count":2}' });
    expect(result.slice(2, 4).map((frame) => frame.id)).toEqual(["1", "2"]);
    expect(result[4]).toEqual({ event: "stream.live", data: "{}" });
    expect(result.slice(5, 7).map((frame) => [frame.id, frame.event])).toEqual([
      ["3", "usage.updated"],
      ["4", "run.completed"],
    ]);
    expect(result[7]).toEqual({ event: "stream.end", data: '{"seq":4}' });
    expect(result).toHaveLength(8);
    expect(loads.at(-1)).toBe(3);
  });

  it("resumes after Last-Event-ID without repeating earlier events", async () => {
    const log = [created(), usage(2), message(3)];
    const stream = createRunEventStream({
      afterSeq: 2,
      signal: new AbortController().signal,
      sleep: () => Promise.resolve(),
      source: { load: (after) => Promise.resolve(log.filter((event) => event.seq > after)) },
    });
    const result = frames(await readAll(stream));
    expect(result.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([
      "3",
    ]);
    expect(result[1]).toEqual({ event: "stream.replay", data: '{"count":1}' });
  });

  it("sends heartbeats while idle, runs the idle hook, and stops when the client aborts", async () => {
    const controller = new AbortController();
    let clock = 0;
    let idle = 0;
    const stream = createRunEventStream({
      afterSeq: 0,
      signal: controller.signal,
      pollMs: 250,
      heartbeatMs: 1000,
      idleHookMs: 1000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        if (clock >= 2500) controller.abort();
        return Promise.resolve();
      },
      source: {
        load: (after) => Promise.resolve([created()].filter((event) => event.seq > after)),
        onIdle: () => {
          idle += 1;
          return Promise.resolve();
        },
      },
    });
    const result = frames(await readAll(stream));
    expect(result.filter((frame) => frame.comment === "heartbeat")).toHaveLength(2);
    expect(idle).toBe(2);
  });
});
