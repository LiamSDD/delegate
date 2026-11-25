import { parseRunEvent, type RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { buildRunView } from "./run-view";
import {
  initialReplayState,
  MAX_REPLAY_GAP_MS,
  MIN_REPLAY_FRAME_MS,
  replayClock,
  replayDelayMs,
  replayFrame,
  replayMarkers,
  replayReducer,
  type ReplayAction,
  type ReplayState,
} from "./replay";

const step = (id: string) => ({
  id,
  role: "researcher" as const,
  objective: `Do ${id}`,
  inputs: [],
  capabilities: [],
  acceptance: ["ok"],
  budgetShare: 0.5,
});

function log(): RunEvent[] {
  const drafts: Record<string, unknown>[] = [
    {
      type: "run.created",
      payload: {
        workspaceId: "ws",
        missionId: "company-xray",
        input: { url: "https://acme.com" },
        actor: { type: "guest", id: "g" },
        budget: { maxTokens: 1, maxMicroUsd: 0 },
      },
    },
    { type: "plan.proposed", payload: { version: 1, steps: [step("a"), step("b")] } },
    { type: "plan.approved", payload: { version: 1, approvedBy: { type: "system", id: "x" } } },
    { type: "step.started", stepId: "a", payload: {} },
    {
      type: "step.completed",
      stepId: "a",
      payload: { outcome: "succeeded", summary: "a", artifactIds: [] },
    },
    { type: "step.started", stepId: "b", payload: {} },
    {
      type: "step.completed",
      stepId: "b",
      payload: { outcome: "succeeded", summary: "b", artifactIds: [] },
    },
    { type: "run.completed", payload: { summary: "done" } },
  ];
  const start = Date.parse("2026-11-25T10:00:00.000Z");
  const offsets = [0, 100, 200, 1200, 61_200, 61_300, 62_300, 62_400];
  return drafts.map((draft, index) =>
    parseRunEvent({
      runId: "r",
      seq: index + 1,
      at: new Date(start + (offsets[index] ?? 0)).toISOString(),
      ...draft,
    }),
  );
}

function run(actions: ReplayAction[], state: ReplayState = initialReplayState): ReplayState {
  return actions.reduce(replayReducer, state);
}

describe("replayReducer", () => {
  const total = 8;

  it("starts at the first event and plays to the end, then stops", () => {
    const started = run([{ type: "start", total }]);
    expect(started).toMatchObject({ active: true, playing: true, cursor: 1 });
    const ticks: ReplayAction[] = Array.from({ length: 20 }, () => ({ type: "tick", total }));
    expect(run(ticks, started)).toMatchObject({ active: true, playing: false, cursor: total });
  });

  it("pauses, resumes, and restarts from the beginning once finished", () => {
    const paused = run([
      { type: "start", total },
      { type: "tick", total },
      { type: "toggle", total },
    ]);
    expect(paused).toMatchObject({ playing: false, cursor: 2 });
    expect(run([{ type: "tick", total }], paused).cursor).toBe(2);
    expect(run([{ type: "toggle", total }], paused)).toMatchObject({ playing: true, cursor: 2 });
    const finished = run([{ type: "seek", cursor: total, total }], paused);
    expect(run([{ type: "toggle", total }], finished)).toMatchObject({ playing: true, cursor: 1 });
  });

  it("clamps seeks to the log and ignores actions while inactive", () => {
    const started = run([{ type: "start", total }]);
    expect(run([{ type: "seek", cursor: 99, total }], started)).toMatchObject({
      cursor: total,
      playing: false,
    });
    expect(run([{ type: "seek", cursor: -3, total }], started).cursor).toBe(1);
    expect(
      run([
        { type: "tick", total },
        { type: "toggle", total },
      ]),
    ).toEqual(initialReplayState);
    expect(run([{ type: "start", total: 0 }])).toEqual(initialReplayState);
  });

  it("keeps the chosen speed when replay exits", () => {
    const state = run([{ type: "start", total }, { type: "speed", speed: 16 }, { type: "exit" }]);
    expect(state).toEqual({ ...initialReplayState, speed: 16 });
  });
});

describe("replay timing and markers", () => {
  const events = log();

  it("scales recorded gaps by speed and clamps long and empty gaps", () => {
    const [, plan, approved, started, completed] = events;
    if (
      plan === undefined ||
      approved === undefined ||
      started === undefined ||
      completed === undefined
    )
      throw new Error("log too short");
    expect(replayDelayMs(started, completed, 1)).toBe(MAX_REPLAY_GAP_MS);
    expect(replayDelayMs(approved, started, 4)).toBe(250);
    expect(replayDelayMs(plan, plan, 16)).toBe(MIN_REPLAY_FRAME_MS);
  });

  it("marks the first start of each step and the terminal event", () => {
    expect(replayMarkers(events)).toEqual([
      { cursor: 4, label: "a", kind: "step" },
      { cursor: 6, label: "b", kind: "step" },
      { cursor: 8, label: "done", kind: "end" },
    ]);
  });

  it("rebuilds the view at each cursor with the same fold as the live page", () => {
    const total = events.length;
    const state = run([
      { type: "start", total },
      { type: "seek", cursor: 5, total },
    ]);
    const frame = replayFrame(events, state);
    expect(frame).toHaveLength(5);
    const view = buildRunView(frame);
    expect(view.ok && view.steps.map((s) => s.status)).toEqual(["done", "pending"]);
    expect(view.ok && view.outcome).toBeNull();
    expect(replayClock(events, state)).toBe(Date.parse(events[4]?.at ?? ""));
    expect(replayFrame(events, initialReplayState)).toHaveLength(total);
    expect(replayClock(events, initialReplayState)).toBeNull();
  });
});
