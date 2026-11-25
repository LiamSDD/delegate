import { describe, expect, it } from "vitest";

import {
  DelegateApiError,
  DelegateConnectionError,
  DelegateResponseError,
  DelegateTimeoutError,
  type Run,
  type RunEvent,
  createDelegateClient,
  isCancelled,
  packageName,
  runNeedsAttention,
} from "./index";

const BASE = "https://delegate.example";
const RUN_ID = "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f";
const OTHER_RUN_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const ASSISTANT_ID = "9b2f0c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d";

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

function fakeApi(respond: Responder) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: Call = {
      url: new URL(href),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    return respond(call, calls.length - 1);
  };
  return { impl, calls };
}

function clientFor(respond: Responder, extra: { maxRetries?: number; timeoutMs?: number } = {}) {
  const api = fakeApi(respond);
  const sleeps: number[] = [];
  const clock = { now: 0 };
  const client = createDelegateClient({
    baseUrl: BASE,
    token: "dlg_test",
    fetch: api.impl,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
    now: () => clock.now,
    ...extra,
  });
  return { client, calls: api.calls, sleeps, clock };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    mission: "repo-xray",
    status: "running",
    terminal: false,
    createdAt: "2026-11-25T10:00:00.000Z",
    finishedAt: null,
    totals: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, toolCalls: 0 },
    pendingPlan: null,
    pendingApprovals: [],
    steps: [],
    artifacts: [],
    deliverable: null,
    summary: null,
    error: null,
    target: "pallets/click",
    execution: "live",
    startedAt: null,
    webUrl: `${BASE}/runs/${RUN_ID}`,
    ...overrides,
  };
}

function event(seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent {
  return { runId: RUN_ID, seq, at: "2026-11-25T10:00:00.000Z", type, payload };
}

function sse(frames: readonly string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function frame(item: RunEvent): string {
  return `id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message, requestId: "req_test" } },
    { status, headers: { "x-request-id": "req_test", ...headers } },
  );
}

async function drain(items: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _item of items) count += 1;
  return count;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("@delegate/sdk", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/sdk");
  });

  it("refuses plain http except for localhost", () => {
    expect(() => createDelegateClient({ baseUrl: "http://delegate.example", token: "t" })).toThrow(
      /https/,
    );
    expect(createDelegateClient({ baseUrl: "http://localhost:3000", token: "t" }).baseUrl).toBe(
      "http://localhost:3000",
    );
    expect(
      createDelegateClient({ baseUrl: "https://delegate.example/ignored/path", token: "t" })
        .baseUrl,
    ).toBe(BASE);
  });
});

describe("requests", () => {
  it("sends the bearer token, never follows redirects and reads rate-limit headers", async () => {
    const { client, calls } = clientFor(() =>
      Response.json(run(), {
        headers: {
          "RateLimit-Limit": "1200",
          "RateLimit-Remaining": "1187",
          "RateLimit-Reset": "42",
        },
      }),
    );
    expect(client.rateLimit()).toBeNull();
    await client.runs.get(RUN_ID);
    expect(calls[0]?.url.href).toBe(`${BASE}/api/v1/runs/${RUN_ID}`);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer dlg_test");
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
    expect(calls[0]?.headers.get("user-agent")).toMatch(/^delegate-sdk\//);
    expect(client.rateLimit()).toEqual({ limit: 1200, remaining: 1187, resetSeconds: 42 });
  });

  it("creates a run with a generated Idempotency-Key and returns the typed run", async () => {
    const { client, calls } = clientFor(() => Response.json(run(), { status: 201 }));
    const created = await client.runs.create({
      missionId: "repo-xray",
      input: { url: "https://github.com/pallets/click" },
    });
    expect(created.id).toBe(RUN_ID);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/runs");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.body).toEqual({
      missionId: "repo-xray",
      input: { url: "https://github.com/pallets/click" },
    });
  });

  it("uses the caller's Idempotency-Key when one is given", async () => {
    const { client, calls } = clientFor(() => Response.json(run(), { status: 201 }));
    await client.runs.create(
      { missionId: "custom-goal", input: { goal: "Summarise the open tickets" } },
      { idempotencyKey: "order-42" },
    );
    expect(calls[0]?.headers.get("idempotency-key")).toBe("order-42");
  });

  it("rejects a request the contract rejects without calling the server", async () => {
    const { client, calls } = clientFor(() => Response.json(run()));
    const error = await failure(
      client.runs.create({ missionId: "build-agent", input: { url: "acme.example" } }),
    );
    expect(error).toBeInstanceOf(DelegateApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid_request", requestId: null });
    expect((error as DelegateApiError).issues).toEqual(["input.goal: build-agent needs goal"]);
    expect(await failure(client.runs.get("not-a-uuid"))).toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("turns the error envelope into DelegateApiError", async () => {
    const { client } = clientFor(() =>
      Response.json(
        {
          error: {
            code: "not_found",
            message: "No run with that id is visible to this token.",
            requestId: "req_abc",
          },
        },
        { status: 404 },
      ),
    );
    const error = await failure(client.runs.get(RUN_ID));
    expect(error).toBeInstanceOf(DelegateApiError);
    expect(error).toMatchObject({
      name: "DelegateApiError",
      status: 404,
      code: "not_found",
      requestId: "req_abc",
      retryable: false,
    });
  });

  it("keeps the status when the server answers without an envelope", async () => {
    const { client } = clientFor(() => new Response("<html>Bad gateway</html>", { status: 400 }));
    expect(await failure(client.runs.get(RUN_ID))).toMatchObject({
      status: 400,
      code: "http_error",
      message: "Delegate answered HTTP 400",
    });
  });

  it("refuses a 2xx body that does not match the contract", async () => {
    const { client } = clientFor(() =>
      Response.json({ ...run(), status: "paused" }, { headers: { "x-request-id": "req_9" } }),
    );
    const error = await failure(client.runs.get(RUN_ID));
    expect(error).toBeInstanceOf(DelegateResponseError);
    expect(error).toMatchObject({ operation: "getRun", requestId: "req_9" });
    expect((error as DelegateResponseError).issues[0]).toMatch(/^status:/);
  });
});

describe("retries", () => {
  it("retries a GET after 503 and after a network failure, backing off", async () => {
    const { client, calls, sleeps } = clientFor((_call, index) => {
      if (index === 0) return errorResponse(503, "unavailable", "Try again");
      if (index === 1) throw new TypeError("fetch failed");
      return Response.json(run());
    });
    expect((await client.runs.get(RUN_ID)).id).toBe(RUN_ID);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("waits as long as Retry-After says", async () => {
    const { client, sleeps } = clientFor((_call, index) =>
      index === 0
        ? errorResponse(429, "rate_limited", "Slow down", { "retry-after": "7" })
        : Response.json(run()),
    );
    await client.runs.get(RUN_ID);
    expect(sleeps).toEqual([7000]);
  });

  it("does not sleep through a long Retry-After; it reports it", async () => {
    const { client, calls, sleeps } = clientFor(() =>
      errorResponse(429, "rate_limited", "Run quota used up", { "retry-after": "1800" }),
    );
    const error = await failure(client.runs.get(RUN_ID));
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 1_800_000, retryable: true });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a POST with the same Idempotency-Key", async () => {
    const { client, calls } = clientFor((_call, index) =>
      index === 0 ? errorResponse(503, "unavailable", "Try again") : Response.json(run()),
    );
    await client.runs.cancel(RUN_ID);
    expect(calls).toHaveLength(2);
    const keys = calls.map((call) => call.headers.get("idempotency-key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("gives up after maxRetries and never retries a definite answer", async () => {
    const flaky = clientFor(() => errorResponse(503, "unavailable", "Down"), { maxRetries: 1 });
    expect(await failure(flaky.client.runs.get(RUN_ID))).toMatchObject({ status: 503 });
    expect(flaky.calls).toHaveLength(2);
    const definite = clientFor(() => errorResponse(404, "not_found", "No run"));
    await failure(definite.client.runs.get(RUN_ID));
    expect(definite.calls).toHaveLength(1);
  });

  it("reports an unreachable server as DelegateConnectionError", async () => {
    const { client, calls } = clientFor(
      () => {
        throw new TypeError("fetch failed");
      },
      { maxRetries: 0 },
    );
    const error = await failure(client.runs.get(RUN_ID));
    expect(error).toBeInstanceOf(DelegateConnectionError);
    expect((error as Error).message).toContain(BASE);
    expect(calls).toHaveLength(1);
  });

  it("gives up on a request that exceeds the timeout", async () => {
    const api = fakeApi(() => Response.json(run()));
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const client = createDelegateClient({
      baseUrl: BASE,
      token: "dlg_test",
      fetch: hanging,
      timeoutMs: 20,
      maxRetries: 0,
    });
    const error = await failure(client.runs.get(RUN_ID));
    expect(error).toBeInstanceOf(DelegateConnectionError);
    expect((error as Error).message).toMatch(/20 ms/);
    expect(api.calls).toHaveLength(0);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client, calls } = clientFor(() => Response.json(run()));
    await expect(client.runs.get(RUN_ID, { signal: controller.signal })).rejects.toThrow("stop");
    expect(calls).toHaveLength(0);
  });
});

describe("runs", () => {
  it("lists a page and follows cursors when iterating", async () => {
    const summary = (id: string) => ({
      id,
      mission: "company-xray",
      target: "acme.example",
      status: "completed",
      execution: "live",
      createdAt: "2026-11-25T10:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-11-25T10:02:00.000Z",
      webUrl: `${BASE}/runs/${id}`,
    });
    const { client, calls } = clientFor((call) =>
      call.url.searchParams.get("cursor") === null
        ? Response.json({ data: [summary(RUN_ID)], nextCursor: "c2" })
        : Response.json({ data: [summary(OTHER_RUN_ID)], nextCursor: null }),
    );
    const page = await client.runs.list({ limit: 1, status: "completed" });
    expect(page.nextCursor).toBe("c2");
    expect(calls[0]?.url.search).toBe("?limit=1&status=completed");
    const ids: string[] = [];
    for await (const item of client.runs.iterate({ limit: 1 })) ids.push(item.id);
    expect(ids).toEqual([RUN_ID, OTHER_RUN_ID]);
    expect(calls.at(-1)?.url.searchParams.get("cursor")).toBe("c2");
  });

  it("cancels, approves and rejects through their own paths", async () => {
    const { client, calls } = clientFor((call) =>
      call.url.pathname.endsWith("/cancel")
        ? Response.json(
            run({
              status: "failed",
              terminal: true,
              error: { code: "cancelled", message: "cancelled by user" },
            }),
          )
        : Response.json({
            runId: RUN_ID,
            decision: call.url.pathname.endsWith("/approve") ? "approved" : "rejected",
          }),
    );
    const cancelled = await client.runs.cancel(RUN_ID);
    expect(isCancelled(cancelled)).toBe(true);
    expect((await client.runs.approvePlan(RUN_ID)).decision).toBe("approved");
    expect((await client.runs.rejectPlan(RUN_ID, "Too broad")).decision).toBe("rejected");
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `POST /api/v1/runs/${RUN_ID}/cancel`,
      `POST /api/v1/runs/${RUN_ID}/plan/approve`,
      `POST /api/v1/runs/${RUN_ID}/plan/reject`,
    ]);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[1]?.body).toEqual({});
    expect(calls[2]?.body).toEqual({ reason: "Too broad" });
  });

  it("reads one page of events as JSON", async () => {
    const { client, calls } = clientFor(() =>
      Response.json({
        data: [event(3, "step.started")],
        nextAfter: 3,
        hasMore: false,
        terminal: false,
      }),
    );
    const page = await client.runs.listEvents(RUN_ID, { after: 2, limit: 50 });
    expect(page.data[0]?.seq).toBe(3);
    expect(calls[0]?.url.search).toBe("?after=2&limit=50");
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });
});

describe("runs.events", () => {
  it("yields run events in order, skips control frames and stops at the terminal event", async () => {
    const { client, calls } = clientFor(() =>
      sse([
        "retry: 2000\n\n",
        'event: stream.replay\ndata: {"count":2}\n\n',
        frame(event(1, "run.created")),
        frame(event(2, "plan.proposed")),
        "event: stream.live\ndata: {}\n\n",
        ": heartbeat\n\n",
        frame(event(3, "run.completed", { summary: "Done" })),
        'event: stream.end\ndata: {"seq":3}\n\n',
        frame(event(4, "agent.message")),
      ]),
    );
    const seen: string[] = [];
    for await (const item of client.runs.events(RUN_ID)) seen.push(`${item.seq}:${item.type}`);
    expect(seen).toEqual(["1:run.created", "2:plan.proposed", "3:run.completed"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(calls[0]?.url.search).toBe("?after=0&limit=200");
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("reconnects from the last sequence when the stream closes early, without duplicates", async () => {
    const { client, calls, sleeps } = clientFor((call) => {
      const after = call.url.searchParams.get("after");
      if (after === "5")
        return sse([frame(event(6, "step.started")), frame(event(7, "step.completed"))]);
      return sse([
        frame(event(7, "step.completed")),
        frame(event(8, "run.failed", { error: { code: "cancelled", message: "cancelled" } })),
      ]);
    });
    const seen: number[] = [];
    for await (const item of client.runs.events(RUN_ID, { after: 5 })) seen.push(item.seq);
    expect(seen).toEqual([6, 7, 8]);
    expect(calls.map((call) => call.url.searchParams.get("after"))).toEqual(["5", "7"]);
    expect(sleeps).toEqual([500]);
  });

  it("ends at once when the server says the run is finished and nothing follows", async () => {
    const { client, calls } = clientFor(() => new Response(null, { status: 204 }));
    const seen: RunEvent[] = [];
    for await (const item of client.runs.events(RUN_ID, { after: 9 })) seen.push(item);
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("gives up when the stream keeps closing without a single event", async () => {
    const { client, calls } = clientFor(() => sse(["event: stream.live\ndata: {}\n\n"]));
    await expect(drain(client.runs.events(RUN_ID))).rejects.toBeInstanceOf(DelegateConnectionError);
    expect(calls).toHaveLength(6);
  });

  it("surfaces an API error instead of reconnecting", async () => {
    const { client, calls } = clientFor(() => errorResponse(404, "not_found", "No run"));
    await expect(drain(client.runs.events(RUN_ID))).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses an event that does not match the contract", async () => {
    const { client } = clientFor(() => sse(['id: 1\nevent: run.created\ndata: {"seq":"one"}\n\n']));
    await expect(drain(client.runs.events(RUN_ID))).rejects.toBeInstanceOf(DelegateResponseError);
  });
});

describe("waitForRun", () => {
  it("polls until the run is terminal", async () => {
    const { client, calls, sleeps } = clientFor((_call, index) =>
      Response.json(index < 2 ? run() : run({ status: "completed", terminal: true })),
    );
    const polled: string[] = [];
    const finished = await client.waitForRun(RUN_ID, {
      pollIntervalMs: 1_000,
      onPoll: (item) => polled.push(item.status),
    });
    expect(finished.status).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(polled).toEqual(["running", "running", "completed"]);
  });

  it("can return as soon as the run needs a decision", async () => {
    const waiting = run({
      status: "awaiting_plan_approval",
      pendingPlan: [{ id: "research", objective: "Read the repository", status: "pending" }],
    });
    const { client, calls } = clientFor(() => Response.json(waiting));
    expect(runNeedsAttention(waiting)).toBe(true);
    const result = await client.runs.wait(RUN_ID, { until: "attention" });
    expect(result.status).toBe("awaiting_plan_approval");
    expect(calls).toHaveLength(1);
  });

  it("throws DelegateTimeoutError with the last run it saw", async () => {
    const { client, calls } = clientFor(() => Response.json(run()));
    const error = await failure(
      client.waitForRun(RUN_ID, { timeoutMs: 5_000, pollIntervalMs: 2_000 }),
    );
    expect(error).toBeInstanceOf(DelegateTimeoutError);
    expect(error).toMatchObject({ runId: RUN_ID, timeoutMs: 5_000 });
    expect((error as DelegateTimeoutError).lastRun?.status).toBe("running");
    expect(calls).toHaveLength(3);
  });
});

describe("artifacts and assistants", () => {
  it("lists and fetches artifacts", async () => {
    const ref = { artifactId: "report/v1", kind: "repo-xray", title: "Repo X-ray", version: 2 };
    const { client, calls } = clientFor((call) =>
      call.url.pathname.endsWith("/artifacts")
        ? Response.json({ data: [ref] })
        : Response.json({ ...ref, content: { sections: [] } }),
    );
    expect(await client.artifacts.list(RUN_ID)).toEqual([ref]);
    expect((await client.artifacts.get(RUN_ID, "report/v1")).content).toEqual({ sections: [] });
    expect(calls[1]?.url.pathname).toBe(`/api/v1/runs/${RUN_ID}/artifacts/report%2Fv1`);
  });

  it("lists assistants and asks one a question", async () => {
    const answer = {
      answer: "Plans start at 12 euros [1].",
      citations: [{ index: 1, chunkId: "c1", url: "https://acme.example/pricing" }],
      grounded: true,
      refused: false,
      refusal: null,
      servedBy: { provider: "pollinations", model: "gpt-oss-120b" },
      usage: { inputTokens: 900, outputTokens: 40 },
      durationMs: 1200,
    };
    const { client, calls } = clientFor((call) =>
      call.method === "GET"
        ? Response.json({
            data: [
              {
                id: ASSISTANT_ID,
                name: "Acme helper",
                url: "https://acme.example",
                status: "ready",
                passRate: 0.9,
                pages: 12,
                runId: RUN_ID,
                createdAt: "2026-11-25T10:00:00.000Z",
                webUrl: `${BASE}/agents/${ASSISTANT_ID}`,
              },
            ],
          })
        : Response.json(answer),
    );
    expect((await client.assistants.list())[0]?.name).toBe("Acme helper");
    expect(await client.assistants.chat(ASSISTANT_ID, { question: "What does it cost?" })).toEqual(
      answer,
    );
    expect(calls[1]?.url.pathname).toBe(`/api/v1/assistants/${ASSISTANT_ID}/chat`);
    expect(calls[1]?.body).toEqual({ question: "What does it cost?", history: [] });
  });

  it("streams an answer as typed events", async () => {
    const { client, calls } = clientFor(() =>
      sse([
        'event: delta\ndata: {"type":"delta","text":"Plans start "}\n\n',
        'event: delta\ndata: {"type":"delta","text":"at 12 euros."}\n\n',
        `event: done\ndata: ${JSON.stringify({
          type: "done",
          answer: "Plans start at 12 euros.",
          citations: [],
          grounded: true,
          refused: false,
          usage: { inputTokens: 1, outputTokens: 2 },
          retrieval: { mode: "hybrid", candidates: 8, used: 3, reranked: true },
          durationMs: 10,
        })}\n\n`,
      ]),
    );
    const text: string[] = [];
    for await (const item of client.assistants.chatStream(ASSISTANT_ID, { question: "Price?" }))
      if (item.type === "delta") text.push(item.text);
    expect(text.join("")).toBe("Plans start at 12 euros.");
    expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("fetches the OpenAPI document", async () => {
    const { client, calls } = clientFor(() => Response.json({ openapi: "3.1.0", paths: {} }));
    expect((await client.openapi()).openapi).toBe("3.1.0");
    expect(calls[0]?.url.pathname).toBe("/api/v1/openapi.json");
  });
});

describe("methods kept for the MCP server", () => {
  it("startRun returns the run id and its web URL, dropping fields the mission does not take", async () => {
    const { client, calls } = clientFor(() => Response.json(run(), { status: 201 }));
    const started = await client.startRun({
      missionId: "company-xray",
      input: { url: "acme.example", department: "support", focus: "pricing" },
    });
    expect(started).toEqual({ runId: RUN_ID, webUrl: `${BASE}/runs/${RUN_ID}` });
    expect(calls[0]?.body).toEqual({
      missionId: "company-xray",
      input: { url: "acme.example", focus: "pricing" },
    });
  });

  it("startRun reports an unknown mission as an API error", async () => {
    const { client, calls } = clientFor(() => Response.json(run()));
    const error = await failure(
      client.startRun({ missionId: "ship-a-pr", input: { url: "acme.example" } }),
    );
    expect(error).toMatchObject({ name: "DelegateApiError", status: 400, code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("startAutopilot, listRuns, decidePlan and getArtifact map onto v1", async () => {
    const { client, calls } = clientFor((call) => {
      if (call.url.pathname === "/api/v1/runs" && call.method === "POST")
        return Response.json(run({ mission: "autopilot" }), { status: 201 });
      if (call.url.pathname === "/api/v1/runs")
        return Response.json({ data: [], nextCursor: null });
      if (call.url.pathname.endsWith("/plan/reject"))
        return Response.json({ runId: RUN_ID, decision: "rejected" });
      return Response.json({
        artifactId: "a1",
        kind: "brief",
        title: "Brief",
        version: 1,
        content: 1,
      });
    });
    expect((await client.startAutopilot({ goal: "Grow self-serve revenue" })).runId).toBe(RUN_ID);
    expect(calls[0]?.body).toEqual({
      missionId: "autopilot",
      input: { goal: "Grow self-serve revenue" },
    });
    expect(await client.listRuns(500)).toEqual([]);
    expect(calls[1]?.url.search).toBe("?limit=50");
    expect(await client.decidePlan(RUN_ID, { decision: "rejected", reason: "No" })).toEqual({
      decision: "rejected",
    });
    expect((await client.getArtifact(RUN_ID, "a1")).title).toBe("Brief");
    expect(client.runUrl(RUN_ID)).toBe(`${BASE}/runs/${RUN_ID}`);
  });
});
