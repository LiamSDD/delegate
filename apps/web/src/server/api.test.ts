import { foldRun, parseRunEvent, type RunEvent } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ApiDeps,
  CreateRunRequestSchema,
  handleCancelRun,
  handleCreateRun,
  handleGetArtifact,
  handleGetRun,
  handleRunEvents,
  missionInput,
} from "./api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import type { MissionRunner } from "./mission-runner";
import { createRunRegistry } from "./run-registry";
import { MAX_RUN_DURATION_MS } from "./runs";
import { createRateLimiter } from "./session";

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
    guestLimiter: createRateLimiter({ limit: 5, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => ({ execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }),
    schedule: (task) => {
      tasks.push(task);
    },
    production: false,
    stream: { pollMs: 1, heartbeatMs: 60_000 },
    tasks,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(path: string, cookie: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    headers: { cookie, host: "localhost:3000", ...headers },
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const pair = header.split(";")[0] ?? "";
  expect(pair).toMatch(/^delegate_session=/);
  return pair;
}

const validBody = { missionId: "company-xray", input: { url: "www.acme.com/pricing" } };

async function sseEvents(response: Response): Promise<{ frames: string[]; events: RunEvent[] }> {
  const text = await response.text();
  const frames = text.split("\n\n").filter((frame) => frame.trim() !== "");
  const events = frames
    .filter((frame) => frame.startsWith("id: "))
    .map((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: ")) ?? "";
      return parseRunEvent(JSON.parse(data.slice(6)));
    });
  return { frames, events };
}

describe("POST /api/runs", () => {
  it("creates a run, issues a signed cookie and schedules execution", async () => {
    const d = deps();
    const response = await handleCreateRun(post(validBody), d);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { runId: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    expect(d.tasks).toHaveLength(1);
  });

  it("starts a Repo X-ray from a GitHub URL and keeps a tree ref", async () => {
    const d = deps();
    const response = await handleCreateRun(
      post({ missionId: "repo-xray", input: { url: "github.com/pallets/click/tree/8.1.x" } }),
      d,
    );
    expect(response.status).toBe(201);
    expect(d.tasks).toHaveLength(1);
    const request = CreateRunRequestSchema.parse({
      missionId: "repo-xray",
      input: { url: "https://github.com/sindresorhus/ky", ref: "v1.0.0" },
    });
    expect(missionInput(request, "https://github.com/sindresorhus/ky", undefined)).toEqual({
      url: "https://github.com/sindresorhus/ky",
      ref: "v1.0.0",
    });
  });

  it("rejects cross-origin and origin-less requests (CSRF)", async () => {
    const d = deps();
    const evil = await handleCreateRun(post(validBody, { origin: "https://evil.example" }), d);
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: { code: "forbidden_origin" } });
    const request = new Request(`${ORIGIN}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000" },
      body: JSON.stringify(validBody),
    });
    expect((await handleCreateRun(request, d)).status).toBe(403);
    expect(d.tasks).toHaveLength(0);
  });

  it("validates the body and the URL with typed errors", async () => {
    const d = deps();
    const cases: [unknown, number, string][] = [
      ["{not json", 400, "invalid_json"],
      [{ missionId: "repo-xray", input: { url: "acme.com" } }, 400, "invalid_url"],
      [{ missionId: "ship-a-pr", input: { url: "github.com/a/b" } }, 400, "invalid_request"],
      [
        { missionId: "company-xray", input: { url: "acme.com", ref: "main" } },
        400,
        "invalid_request",
      ],
      [
        { missionId: "repo-xray", input: { url: "github.com/a/b", ref: "../x" } },
        400,
        "invalid_request",
      ],
      [{ missionId: "company-xray", input: { url: "acme.com", extra: 1 } }, 400, "invalid_request"],
      [{ missionId: "company-xray", input: { url: "http://127.0.0.1" } }, 400, "invalid_url"],
      [{ missionId: "company-xray", input: { url: "localhost" } }, 400, "invalid_url"],
    ];
    for (const [body, status, code] of cases) {
      const response = await handleCreateRun(post(body), d);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    const wrongType = await handleCreateRun(post(validBody, { "content-type": "text/plain" }), d);
    expect(wrongType.status).toBe(415);
  });

  it("stores the normalised https homepage and optional focus", async () => {
    const d = deps();
    const response = await handleCreateRun(
      post({
        missionId: "company-xray",
        input: { url: "http://WWW.Acme.com/x?y", focus: "pricing" },
      }),
      d,
    );
    const { runId } = (await response.json()) as { runId: string };
    const summary = await handleGetRun(get(`/api/runs/${runId}`, cookieFrom(response)), runId, d);
    expect(await summary.json()).toMatchObject({
      run: { input: { url: "https://www.acme.com/", focus: "pricing" }, target: "acme.com" },
    });
  });

  it("starts build-agent from a visible parent audit with its goal and provenance", async () => {
    const d = deps();
    const parent = await handleCreateRun(
      post({ missionId: "automation-audit", input: { url: "acme.com" } }),
      d,
    );
    const cookie = cookieFrom(parent);
    const { runId: parentRunId } = (await parent.json()) as { runId: string };
    const response = await handleCreateRun(
      post(
        {
          missionId: "build-agent",
          input: {
            url: "acme.com",
            goal: "Answer billing questions from the help centre",
            name: "Billing helper",
            opportunityId: "opp-1",
            fromAuditRunId: "ignored-client-value",
          },
          parentRunId,
        },
        { cookie },
      ),
      d,
    );
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };
    const summary = await handleGetRun(get(`/api/runs/${runId}`, cookie), runId, d);
    expect(await summary.json()).toMatchObject({
      run: {
        mission: "build-agent",
        input: {
          url: "https://acme.com/",
          goal: "Answer billing questions from the help centre",
          name: "Billing helper",
          opportunityId: "opp-1",
          fromAuditRunId: parentRunId,
        },
      },
    });
  });

  it("requires a goal for build-agent and rejects goals on other missions", async () => {
    const d = deps();
    const missingGoal = await handleCreateRun(
      post({ missionId: "build-agent", input: { url: "acme.com" } }),
      d,
    );
    expect(missingGoal.status).toBe(400);
    expect(await missingGoal.json()).toMatchObject({ error: { code: "invalid_request" } });
    const stray = await handleCreateRun(
      post({ missionId: "company-xray", input: { url: "acme.com", goal: "x" } }),
      d,
    );
    expect(stray.status).toBe(400);
  });

  it("starts a live custom-goal run from free text, the path /runs/new takes", async () => {
    let scheduled: { missionId: string; input: Record<string, unknown> } | undefined;
    const runner: MissionRunner = (args) => {
      scheduled = { missionId: args.missionId, input: args.input };
      return Promise.resolve({ status: "completed" });
    };
    const d = deps({ runner: () => ({ execution: "live", run: runner }) });
    const goal = "I want to achieve nike's marketing and agentic work";
    const response = await handleCreateRun(post({ missionId: "custom-goal", input: { goal } }), d);
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };
    const cookie = cookieFrom(response);
    const summary = await handleGetRun(get(`/api/runs/${runId}`, cookie), runId, d);
    expect(await summary.json()).toMatchObject({
      run: { mission: "custom-goal", input: { goal }, target: goal },
    });
    expect(d.tasks).toHaveLength(1);
    await d.tasks[0]?.();
    expect(scheduled).toEqual({ missionId: "custom-goal", input: { goal } });
  });

  it("validates custom-goal requests", async () => {
    const d = deps();
    const cases: [unknown, number, string][] = [
      [{ missionId: "custom-goal", input: {} }, 400, "invalid_request"],
      [{ missionId: "custom-goal", input: { goal: "hi" } }, 400, "invalid_request"],
      [{ missionId: "custom-goal", input: { goal: "Grow", focus: "x" } }, 400, "invalid_request"],
      [{ missionId: "custom-goal", input: { goal: "Grow", url: "localhost" } }, 400, "invalid_url"],
      [{ missionId: "company-xray", input: {} }, 400, "invalid_request"],
    ];
    for (const [body, status, code] of cases) {
      const response = await handleCreateRun(post(body), d);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    const withUrl = await handleCreateRun(
      post({ missionId: "custom-goal", input: { goal: "Grow EU sales", url: "acme.com" } }),
      d,
    );
    expect(withUrl.status).toBe(201);
  });

  it("rate limits run creation per guest", async () => {
    const d = deps({ guestLimiter: createRateLimiter({ limit: 2, windowMs: 3_600_000 }) });
    const first = await handleCreateRun(post(validBody), d);
    const cookie = cookieFrom(first);
    expect((await handleCreateRun(post(validBody, { cookie }), d)).status).toBe(201);
    const limited = await handleCreateRun(post(validBody, { cookie }), d);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("rate limits cookie-less clients per IP so dropping the cookie does not reset the quota", async () => {
    const d = deps({ ipLimiter: createRateLimiter({ limit: 1, windowMs: 3_600_000 }) });
    const ip = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    expect((await handleCreateRun(post(validBody, ip), d)).status).toBe(201);
    expect((await handleCreateRun(post(validBody, ip), d)).status).toBe(429);
  });
});

describe("GET /api/runs/:id/events", () => {
  it("replays then streams live events until terminal, and folds cleanly", async () => {
    const d = deps();
    const created = await handleCreateRun(post(validBody), d);
    const cookie = cookieFrom(created);
    const { runId } = (await created.json()) as { runId: string };
    const execution = d.tasks[0]?.();
    const response = await handleRunEvents(get(`/api/runs/${runId}/events`, cookie), runId, d);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const { frames, events } = await sseEvents(response);
    await execution;
    expect(frames.some((frame) => frame.startsWith("event: stream.replay"))).toBe(true);
    expect(events[0]?.type).toBe("run.created");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(foldRun(events).status).toBe("completed");
    expect(frames.at(-1)).toContain("event: stream.end");
  });

  it("resumes after Last-Event-ID and returns 204 once nothing is left", async () => {
    const d = deps();
    const created = await handleCreateRun(post(validBody), d);
    const cookie = cookieFrom(created);
    const { runId } = (await created.json()) as { runId: string };
    await d.tasks[0]?.();
    const all = await sseEvents(
      await handleRunEvents(get(`/api/runs/${runId}/events`, cookie), runId, d),
    );
    const total = all.events.length;
    const resumed = await sseEvents(
      await handleRunEvents(
        get(`/api/runs/${runId}/events`, cookie, { "last-event-id": String(total - 3) }),
        runId,
        d,
      ),
    );
    expect(resumed.events.map((event) => event.seq)).toEqual([total - 2, total - 1, total]);
    const viaQuery = await sseEvents(
      await handleRunEvents(get(`/api/runs/${runId}/events?after=${total - 1}`, cookie), runId, d),
    );
    expect(viaQuery.events.map((event) => event.seq)).toEqual([total]);
    const done = await handleRunEvents(
      get(`/api/runs/${runId}/events`, cookie, { "last-event-id": String(total) }),
      runId,
      d,
    );
    expect(done.status).toBe(204);
  });

  it("returns 404 to other guests, to missing cookies and for malformed ids", async () => {
    const d = deps();
    const created = await handleCreateRun(post(validBody), d);
    const { runId } = (await created.json()) as { runId: string };
    const other = cookieFrom(await handleCreateRun(post(validBody), d));
    expect((await handleRunEvents(get(`/api/runs/${runId}/events`, other), runId, d)).status).toBe(
      404,
    );
    expect((await handleRunEvents(get(`/api/runs/${runId}/events`, ""), runId, d)).status).toBe(
      404,
    );
    expect((await handleGetRun(get(`/api/runs/nope`, other), "nope", d)).status).toBe(404);
  });

  it("sweeps a stale run to failed: worker lost on read", async () => {
    const d = deps();
    const created = await handleCreateRun(post(validBody), d);
    const cookie = cookieFrom(created);
    const { runId } = (await created.json()) as { runId: string };
    const later = new Date(Date.now() + MAX_RUN_DURATION_MS + 3 * 60_000);
    const swept = deps({ now: () => later });
    const { events } = await sseEvents(
      await handleRunEvents(get(`/api/runs/${runId}/events`, cookie), runId, swept),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: { code: "worker_lost", message: "worker lost" } },
    });
  });
});

describe("POST /api/runs/:id/cancel", () => {
  it("appends run.failed cancelled by user and aborts the in-process runner", async () => {
    let observedAbort = false;
    const waiting: MissionRunner = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve({ status: "failed" });
        });
      });
    const d = deps({ runner: () => ({ execution: "live", run: waiting }) });
    const created = await handleCreateRun(post(validBody), d);
    const cookie = cookieFrom(created);
    const { runId } = (await created.json()) as { runId: string };
    const execution = d.tasks[0]?.();
    const cancel = (headers: Record<string, string>) =>
      new Request(`${ORIGIN}/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie, host: "localhost:3000", ...headers },
      });
    expect(
      (await handleCancelRun(cancel({ origin: "https://evil.example" }), runId, d)).status,
    ).toBe(403);
    const response = await handleCancelRun(cancel({ origin: ORIGIN }), runId, d);
    expect(response.status).toBe(200);
    await execution;
    expect(observedAbort).toBe(true);
    const { events } = await sseEvents(
      await handleRunEvents(get(`/api/runs/${runId}/events`, cookie), runId, d),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: { code: "cancelled", message: "cancelled by user" } },
    });
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
    const again = await handleCancelRun(cancel({ origin: ORIGIN }), runId, d);
    expect(again.status).toBe(409);
  });
});

describe("GET /api/runs/:id/artifacts/:artifactId", () => {
  it("returns stored artifact content to the run's guest only", async () => {
    const d = deps();
    const created = await handleCreateRun(post(validBody), d);
    const cookie = cookieFrom(created);
    const { runId } = (await created.json()) as { runId: string };
    await d.tasks[0]?.();
    const { events } = await sseEvents(
      await handleRunEvents(get(`/api/runs/${runId}/events`, cookie), runId, d),
    );
    const artifact = events.find((event) => event.type === "artifact.created");
    if (artifact?.type !== "artifact.created") throw new Error("no artifact");
    const id = artifact.payload.artifactId;
    const response = await handleGetArtifact(
      get(`/api/runs/${runId}/artifacts/${id}`, cookie),
      runId,
      id,
      d,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ artifact: { artifactId: id, version: 2 } });
    const other = cookieFrom(await handleCreateRun(post(validBody), d));
    expect(
      (await handleGetArtifact(get(`/api/runs/${runId}/artifacts/${id}`, other), runId, id, d))
        .status,
    ).toBe(404);
  });
});
