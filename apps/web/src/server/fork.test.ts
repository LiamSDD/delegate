import { foldRun } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ApiDeps, forkRefusalResponse, handleCreateRun, handleForkRun } from "./api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import type { MissionRunner } from "./mission-runner";
import { createRunRegistry } from "./run-registry";
import { artifactContent, type EventDraft, getRunRecord, readAllEvents } from "./runs";
import { createRateLimiter, readGuest, SESSION_COOKIE } from "./session";

const ORIGIN = "http://localhost:3000";
const secret = "s".repeat(32);

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps & { tasks: (() => Promise<void>)[] } {
  const tasks: (() => Promise<void>)[] = [];
  return {
    app: () => Promise.resolve(app),
    secret: () => secret,
    guestLimiter: createRateLimiter({ limit: 10, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => ({ execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }),
    schedule: (task) => {
      tasks.push(task);
    },
    production: false,
    tasks,
    ...overrides,
  };
}

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function finishedRun(d: ReturnType<typeof deps>, missionId = "company-xray") {
  const created = await handleCreateRun(
    request(
      "/api/runs",
      { missionId, input: { url: "acme.com" } },
      { cookie: "delegate_auto_approve=1" },
    ),
    d,
  );
  const cookie = cookieFrom(created);
  const { runId } = (await created.json()) as { runId: string };
  await d.tasks.shift()?.();
  return { runId, cookie };
}

async function userOf(cookie: string): Promise<string> {
  const session = await readGuest(app, cookie.slice(SESSION_COOKIE.length + 1), secret);
  if (session === null) throw new Error("no session");
  return session.userId;
}

describe("POST /api/runs/[id]/fork", () => {
  it("seeds a new run with the parent's events before the step and continues from it", async () => {
    const d = deps();
    const parent = await finishedRun(d);
    const userId = await userOf(parent.cookie);
    const parentEvents = await readAllEvents(app, userId, parent.runId);
    const readStart = parentEvents.find(
      (event) => event.type === "step.started" && event.stepId === "read-pages",
    );
    if (readStart === undefined) throw new Error("missing step");

    const response = await handleForkRun(
      request(
        `/api/runs/${parent.runId}/fork`,
        { stepId: "read-pages", objective: "Read only the pricing page" },
        { cookie: parent.cookie },
      ),
      parent.runId,
      d,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runId: string;
      parentRunId: string;
      seededEvents: number;
      reusedSteps: string[];
    };
    expect(body.parentRunId).toBe(parent.runId);
    expect(body.runId).not.toBe(parent.runId);
    expect(body.reusedSteps).toEqual(["map-site"]);
    expect(body.seededEvents).toBe(readStart.seq - 2 + 1);

    const seeded = await readAllEvents(app, userId, body.runId);
    const created = seeded[0];
    expect(created?.type === "run.created" && created.payload.forkedFrom).toEqual({
      runId: parent.runId,
      stepId: "read-pages",
      parentSeq: readStart.seq - 1,
      seededThrough: body.seededEvents + 1,
      objectiveEdited: true,
    });
    expect(seeded.slice(1, -1).map((event) => event.type)).toEqual(
      parentEvents.slice(1, readStart.seq - 1).map((event) => event.type),
    );
    expect(seeded.at(-1)?.type).toBe("plan.revised");

    const record = await getRunRecord(app, userId, body.runId);
    expect(record?.totals.inputTokens).toBe(1800);
    expect(record?.status).toBe("running");

    await d.tasks.shift()?.();
    const finished = await readAllEvents(app, userId, body.runId);
    const state = foldRun(finished);
    expect(state.status).toBe("completed");
    expect(state.forkedFrom?.runId).toBe(parent.runId);
    expect(
      finished.filter((event) => event.type === "step.started").map((event) => event.stepId),
    ).toEqual(["map-site", "read-pages", "write-brief"]);
    expect(
      finished
        .filter((event) => event.seq > body.seededEvents + 1 && event.type === "step.started")
        .map((event) => event.stepId),
    ).toEqual(["read-pages", "write-brief"]);
    expect(state.plan?.steps.find((step) => step.id === "read-pages")?.objective).toBe(
      "Read only the pricing page",
    );
    const brief = Object.values(state.artifacts).find((a) => a.kind === "company-xray-brief");
    expect(brief).toBeDefined();
    if (brief === undefined) return;
    expect(await artifactContent(app, userId, body.runId, brief.artifactId)).not.toBeNull();
    expect((await readAllEvents(app, userId, parent.runId)).length).toBe(parentEvents.length);
  });

  it("copies artifact rows and usage that earlier steps produced", async () => {
    const steps = [
      {
        id: "collect",
        role: "researcher" as const,
        objective: "Collect",
        inputs: [],
        capabilities: [],
        acceptance: ["ok"],
        budgetShare: 0.5,
      },
      {
        id: "write",
        role: "editor" as const,
        objective: "Write",
        inputs: ["collect"],
        capabilities: [],
        acceptance: ["ok"],
        budgetShare: 0.5,
      },
    ];
    const scripted: MissionRunner = async ({ emit, resumeFrom }) => {
      const drafts: EventDraft[] =
        resumeFrom === undefined
          ? [
              { type: "plan.proposed", payload: { version: 1, steps } },
              {
                type: "plan.approved",
                payload: { version: 1, approvedBy: { type: "system", id: "auto" } },
              },
              { type: "step.started", stepId: "collect", payload: {} },
              {
                type: "artifact.created",
                stepId: "collect",
                payload: {
                  artifactId: "notes",
                  kind: "notes",
                  title: "Notes",
                  version: 1,
                  content: { lines: ["a"] },
                },
              },
              {
                type: "artifact.updated",
                stepId: "collect",
                payload: { artifactId: "notes", version: 2, content: { lines: ["a", "b"] } },
              },
              {
                type: "usage.updated",
                stepId: "collect",
                payload: {
                  inputTokens: 10,
                  outputTokens: 5,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  costMicroUsd: 0,
                  provider: "test",
                  model: "test-model",
                },
              },
              {
                type: "step.completed",
                stepId: "collect",
                payload: { outcome: "succeeded", summary: "ok", artifactIds: ["notes"] },
              },
              { type: "step.started", stepId: "write", payload: {} },
              {
                type: "step.completed",
                stepId: "write",
                payload: { outcome: "failed", summary: "no", artifactIds: [] },
              },
            ]
          : [];
      for (const draft of drafts) await emit(draft);
      return { status: resumeFrom === undefined ? "failed" : "completed" };
    };
    const d = deps({ runner: () => ({ execution: "simulated", run: scripted }) });
    const parent = await finishedRun(d);
    const userId = await userOf(parent.cookie);
    const response = await handleForkRun(
      request(`/api/runs/${parent.runId}/fork`, { stepId: "write" }, { cookie: parent.cookie }),
      parent.runId,
      d,
    );
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };
    expect(await artifactContent(app, userId, runId, "notes")).toMatchObject({
      version: 2,
      content: { lines: ["a", "b"] },
    });
    expect((await getRunRecord(app, userId, runId))?.totals).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    await d.tasks.shift()?.();
    expect((await getRunRecord(app, userId, runId))?.status).toBe("completed");
  });

  it("rejects cross-origin requests, other guests and missing cookies", async () => {
    const d = deps();
    const parent = await finishedRun(d);
    const path = `/api/runs/${parent.runId}/fork`;
    const evil = await handleForkRun(
      request(path, { stepId: "map-site" }, { cookie: parent.cookie, origin: "https://evil.test" }),
      parent.runId,
      d,
    );
    expect(evil.status).toBe(403);
    const anonymous = await handleForkRun(request(path, { stepId: "map-site" }), parent.runId, d);
    expect(anonymous.status).toBe(404);
    const other = await finishedRun(d);
    const stranger = await handleForkRun(
      request(path, { stepId: "map-site" }, { cookie: other.cookie }),
      parent.runId,
      d,
    );
    expect(stranger.status).toBe(404);
    expect(d.tasks).toHaveLength(0);
  });

  it("validates the body and the step", async () => {
    const d = deps();
    const parent = await finishedRun(d);
    const path = `/api/runs/${parent.runId}/fork`;
    const cases: [unknown, number, string][] = [
      [{}, 400, "invalid_request"],
      [{ stepId: "map-site", extra: true }, 400, "invalid_request"],
      [{ stepId: "map-site", objective: "x".repeat(2001) }, 400, "invalid_request"],
      [{ stepId: "no-such-step" }, 400, "invalid_step"],
    ];
    for (const [body, status, code] of cases) {
      const response = await handleForkRun(
        request(path, body, { cookie: parent.cookie }),
        parent.runId,
        d,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(d.tasks).toHaveLength(0);
  });

  it("answers every fork refusal with a 4xx, never a 500", async () => {
    const cases = [
      ["run_not_finished", 409, "run_not_finished"],
      ["unknown_step", 400, "invalid_step"],
      ["step_not_completed", 400, "invalid_step"],
      ["invalid_objective", 400, "invalid_step"],
    ] as const;
    for (const [reason, status, code] of cases) {
      const response = forkRefusalResponse({ ok: false, reason, message: "refused" });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code, message: "refused" } });
    }
  });

  it("refuses to fork a run that has not finished", async () => {
    const d = deps();
    const created = await handleCreateRun(
      request("/api/runs", { missionId: "company-xray", input: { url: "acme.com" } }),
      d,
    );
    const cookie = cookieFrom(created);
    const { runId } = (await created.json()) as { runId: string };
    const response = await handleForkRun(
      request(`/api/runs/${runId}/fork`, { stepId: "map-site" }, { cookie }),
      runId,
      d,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_finished" } });
  });

  it("rate limits forks with the run quota", async () => {
    const d = deps({ guestLimiter: createRateLimiter({ limit: 1, windowMs: 3_600_000 }) });
    const parent = await finishedRun(d);
    const response = await handleForkRun(
      request(`/api/runs/${parent.runId}/fork`, { stepId: "map-site" }, { cookie: parent.cookie }),
      parent.runId,
      d,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
  });
});
