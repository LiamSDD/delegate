import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type RunView } from "@delegate/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { handleMcpHttpRequest, mcpMethodNotAllowed, packageName } from "./index";
import { createDelegateMcpServer, type DelegateBackend } from "./server";

const RUN_ID = "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f";
const MISSIONS = [{ id: "company-xray", title: "Company X-ray", description: "Brief" }];

function fakeBackend() {
  let status: RunView["status"] = "planning";
  const decisions: string[] = [];
  const view = (): RunView => ({
    id: RUN_ID,
    mission: "company-xray",
    status,
    terminal: status === "completed" || status === "failed",
    createdAt: "2026-11-25T10:00:00.000Z",
    finishedAt: status === "completed" ? "2026-11-25T10:02:00.000Z" : null,
    totals: { inputTokens: 10, outputTokens: 5, costMicroUsd: 0, toolCalls: 2 },
    pendingPlan:
      status === "awaiting_plan_approval"
        ? [{ id: "research", objective: "Research", status: "pending" }]
        : null,
    pendingApprovals: [],
    steps: [],
    artifacts: [],
    deliverable:
      status === "completed"
        ? {
            artifactId: "brief",
            kind: "company-xray-brief",
            title: "Brief",
            version: 1,
            content: { ok: 1 },
          }
        : null,
    summary: null,
    error: null,
  });
  const backend: DelegateBackend = {
    startMission: () => {
      status = "awaiting_plan_approval";
      return Promise.resolve({ runId: RUN_ID, webUrl: `https://delegate.example/runs/${RUN_ID}` });
    },
    getRun: (runId) => Promise.resolve(runId === RUN_ID ? view() : null),
    listRuns: () =>
      Promise.resolve([
        {
          id: RUN_ID,
          mission: "company-xray",
          target: "acme.example",
          status,
          createdAt: "2026-11-25T10:00:00.000Z",
          finishedAt: null,
        },
      ]),
    decidePlan: (_runId, decision) => {
      decisions.push(decision.decision);
      status = decision.decision === "approved" ? "running" : "failed";
      return Promise.resolve({ decision: decision.decision });
    },
    getArtifact: () => Promise.resolve(null),
    runUrl: (runId) => `https://delegate.example/runs/${runId}`,
  };
  return {
    backend,
    decisions,
    finish: () => {
      status = "completed";
    },
  };
}

function text(result: unknown): unknown {
  const parsed = z
    .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) })
    .parse(result);
  return JSON.parse(parsed.content[0]?.text ?? "null");
}

async function connected(backend: DelegateBackend, onSleep: () => void = () => undefined) {
  const server = createDelegateMcpServer(backend, {
    missions: MISSIONS,
    sleep: () => {
      onSleep();
      return Promise.resolve();
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("@delegate/mcp-server", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/mcp-server");
  });

  it("lists the mission tools and the deliverable resource template", async () => {
    const client = await connected(fakeBackend().backend);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "approve_plan",
      "get_artifact",
      "get_run",
      "list_runs",
      "reject_plan",
      "start_mission",
      "wait_for_run",
    ]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates[0]?.uriTemplate).toBe("delegate://runs/{runId}/deliverable");
  });

  it("starts, approves and waits for a run, then returns the deliverable", async () => {
    const fake = fakeBackend();
    let polls = 0;
    const client = await connected(fake.backend, () => {
      polls += 1;
      if (polls === 2) fake.finish();
    });
    const started = text(
      await client.callTool({
        name: "start_mission",
        arguments: { missionId: "company-xray", input: { url: "acme.example" } },
      }),
    );
    expect(started).toMatchObject({
      runId: RUN_ID,
      webUrl: `https://delegate.example/runs/${RUN_ID}`,
    });
    const waiting = text(await client.callTool({ name: "get_run", arguments: { runId: RUN_ID } }));
    expect(waiting).toMatchObject({
      status: "awaiting_plan_approval",
      pendingPlan: [{ id: "research" }],
    });
    await client.callTool({ name: "approve_plan", arguments: { runId: RUN_ID } });
    expect(fake.decisions).toEqual(["approved"]);
    const done = text(
      await client.callTool({
        name: "wait_for_run",
        arguments: { runId: RUN_ID, timeoutSeconds: 60 },
      }),
    );
    expect(done).toMatchObject({
      status: "completed",
      terminal: true,
      deliverable: { kind: "company-xray-brief", content: { ok: 1 } },
    });
    const resource = await client.readResource({ uri: `delegate://runs/${RUN_ID}/deliverable` });
    expect(resource.contents[0]?.uri).toBe(`delegate://runs/${RUN_ID}/deliverable`);
  });

  it("bounds wait_for_run by its timeout", async () => {
    const fake = fakeBackend();
    await fake.backend.startMission({ missionId: "company-xray", input: { url: "acme.example" } });
    await fake.backend.decidePlan(RUN_ID, { decision: "approved" });
    let clock = 0;
    const server = createDelegateMcpServer(fake.backend, {
      missions: MISSIONS,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    const result = text(
      await client.callTool({
        name: "wait_for_run",
        arguments: { runId: RUN_ID, timeoutSeconds: 5 },
      }),
    );
    expect(result).toMatchObject({ status: "running", terminal: false });
    expect(clock).toBeLessThanOrEqual(5_000);
  });

  it("reports unknown runs as tool errors", async () => {
    const client = await connected(fakeBackend().backend);
    const result = await client.callTool({
      name: "get_run",
      arguments: { runId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("handleMcpHttpRequest", () => {
  const post = (body: unknown) =>
    new Request("https://delegate.example/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    });

  it("answers initialize and tools/list statelessly with JSON", async () => {
    const { backend } = fakeBackend();
    const init = await handleMcpHttpRequest(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "curl", version: "1" },
        },
      }),
      backend,
      { missions: MISSIONS },
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: "delegate" } } });
    const listed = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      backend,
      { missions: MISSIONS },
    );
    expect(listed.status).toBe(200);
    const body = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(await listed.json());
    expect(body.result.tools.map((tool) => tool.name)).toContain("start_mission");
  });

  it("refuses GET and DELETE", async () => {
    const { backend } = fakeBackend();
    const response = await handleMcpHttpRequest(
      new Request("https://delegate.example/api/mcp", { method: "GET" }),
      backend,
      { missions: MISSIONS },
    );
    expect(response.status).toBe(405);
    expect(mcpMethodNotAllowed().status).toBe(405);
  });
});
