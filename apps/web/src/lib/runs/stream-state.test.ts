import type { RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  appendUnique,
  initialStreamState,
  MAX_AUTO_RETRIES,
  reconnectDelayMs,
  streamReducer,
} from "./stream-state";

function event(seq: number): RunEvent {
  return {
    runId: "r",
    seq,
    at: "2026-11-24T10:00:00.000Z",
    type: "run.completed",
    payload: { summary: "x" },
  };
}

describe("streamReducer", () => {
  it("moves connecting → replaying → live → ended", () => {
    let state = initialStreamState;
    expect(state.phase).toBe("connecting");
    state = streamReducer(state, { type: "replay", count: 42 });
    expect(state).toMatchObject({ phase: "replaying", replayCount: 42 });
    state = streamReducer(state, { type: "live" });
    expect(state.phase).toBe("live");
    state = streamReducer(state, { type: "ended" });
    expect(state.phase).toBe("ended");
    expect(streamReducer(state, { type: "dropped" }).phase).toBe("ended");
  });

  it("backs off on drops, gives up after the retry budget, and resets on manual reconnect", () => {
    let state = streamReducer(initialStreamState, { type: "live" });
    for (let attempt = 1; attempt <= MAX_AUTO_RETRIES; attempt += 1) {
      state = streamReducer(state, { type: "dropped" });
      expect(state).toMatchObject({ phase: "reconnecting", attempt });
      expect(state.retryInMs).toBe(reconnectDelayMs(attempt));
    }
    state = streamReducer(state, { type: "dropped" });
    expect(state.phase).toBe("disconnected");
    state = streamReducer(state, { type: "manual_retry" });
    expect(state).toMatchObject({ phase: "connecting", attempt: 0 });
    state = streamReducer(state, { type: "live" });
    expect(state.attempt).toBe(0);
  });

  it("records not found", () => {
    expect(streamReducer(initialStreamState, { type: "not_found" }).phase).toBe("not_found");
  });

  it("grows the backoff exponentially with a cap", () => {
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(10)).toBe(30_000);
  });
});

describe("appendUnique", () => {
  it("drops duplicate and out-of-order seqs after a resume", () => {
    const events = appendUnique([event(1), event(2)], [event(2), event(3), event(1), event(4)]);
    expect(events.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });
});
