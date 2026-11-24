import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AppDatabase, createPgliteAppDatabase } from "./db";
import {
  appendEvent,
  artifactContent,
  createRunRecord,
  getRunRecord,
  listRuns,
  MAX_RUN_DURATION_MS,
  readEvents,
  RunAlreadyTerminalError,
  sweepIfStale,
} from "./runs";
import { createGuest, type GuestSession } from "./session";

let app: AppDatabase;
let guest: GuestSession;
let stranger: GuestSession;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
  guest = await createGuest(app);
  stranger = await createGuest(app);
});

afterAll(async () => {
  await app.close();
});

const input = { url: "https://acme.com/", focus: "pricing" };

async function newRun() {
  return createRunRecord(app, guest, { missionId: "company-xray", input, execution: "live" });
}

describe("run store", () => {
  it("creates a run with its run.created event as seq 1", async () => {
    const { runId, event } = await newRun();
    expect(event).toMatchObject({
      runId,
      seq: 1,
      type: "run.created",
      payload: {
        workspaceId: guest.workspaceId,
        missionId: "company-xray",
        input,
        actor: { type: "guest", id: guest.userId },
      },
    });
    const record = await getRunRecord(app, guest.userId, runId);
    expect(record).toMatchObject({
      id: runId,
      status: "planning",
      mission: "company-xray",
      execution: "live",
      eventCount: 1,
      lastEventType: "run.created",
    });
  });

  it("appends events in order, mirrors status and totals, and replays after a seq", async () => {
    const { runId } = await newRun();
    const ctx = { runId, workspaceId: guest.workspaceId, userId: guest.userId };
    await appendEvent(app, ctx, {
      type: "usage.updated",
      payload: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        costMicroUsd: 0,
        provider: "pollinations",
        model: "openai",
      },
    });
    await appendEvent(app, ctx, { type: "run.completed", payload: { summary: "done" } });
    const after1 = await readEvents(app, guest.userId, runId, 1);
    expect(after1.map((event) => [event.seq, event.type])).toEqual([
      [2, "usage.updated"],
      [3, "run.completed"],
    ]);
    const record = await getRunRecord(app, guest.userId, runId);
    expect(record?.status).toBe("completed");
    expect(record?.finishedAt).not.toBeNull();
    expect(record?.totals).toMatchObject({ inputTokens: 100, cacheReadTokens: 50 });
  });

  it("refuses events after a terminal event", async () => {
    const { runId } = await newRun();
    const ctx = { runId, workspaceId: guest.workspaceId, userId: guest.userId };
    await appendEvent(app, ctx, {
      type: "run.failed",
      payload: { error: { code: "cancelled", message: "cancelled by user" } },
    });
    await expect(
      appendEvent(app, ctx, { type: "run.completed", payload: { summary: "late" } }),
    ).rejects.toBeInstanceOf(RunAlreadyTerminalError);
  });

  it("stores artifact content carried by artifact events", async () => {
    const { runId } = await newRun();
    const ctx = { runId, workspaceId: guest.workspaceId, userId: guest.userId };
    await appendEvent(app, ctx, {
      type: "artifact.created",
      payload: {
        artifactId: "brief",
        kind: "company-xray-brief",
        title: "Brief",
        version: 1,
        content: { sections: {} },
      },
    });
    await appendEvent(app, ctx, {
      type: "artifact.updated",
      payload: {
        artifactId: "brief",
        version: 2,
        content: { sections: { offering: { status: "insufficient_evidence", note: "none" } } },
      },
    });
    expect(await artifactContent(app, guest.userId, runId, "brief")).toEqual({
      artifactId: "brief",
      kind: "company-xray-brief",
      title: "Brief",
      version: 2,
      content: { sections: { offering: { status: "insufficient_evidence", note: "none" } } },
    });
    expect(await artifactContent(app, stranger.userId, runId, "brief")).toBeNull();
  });

  it("hides runs from other guests (RLS)", async () => {
    const { runId } = await newRun();
    expect(await getRunRecord(app, stranger.userId, runId)).toBeNull();
    expect(await readEvents(app, stranger.userId, runId, 0)).toEqual([]);
    expect((await listRuns(app, stranger)).map((run) => run.id)).not.toContain(runId);
    expect((await listRuns(app, guest)).map((run) => run.id)).toContain(runId);
  });

  it("marks a silent run older than its max duration as failed: worker lost", async () => {
    const { runId } = await newRun();
    const record = await getRunRecord(app, guest.userId, runId);
    if (record === null) throw new Error("run not found");
    const soon = new Date(record.createdAt.getTime() + 60_000);
    expect(await sweepIfStale(app, guest.userId, record, soon)).toBe(false);
    const later = new Date(record.createdAt.getTime() + MAX_RUN_DURATION_MS + 1);
    expect(await sweepIfStale(app, guest.userId, record, later)).toBe(true);
    const events = await readEvents(app, guest.userId, runId, 0);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: { code: "worker_lost", message: "worker lost" } },
    });
    const swept = await getRunRecord(app, guest.userId, runId);
    if (swept === null) throw new Error("run not found");
    expect(await sweepIfStale(app, guest.userId, swept, later)).toBe(false);
  });
});
