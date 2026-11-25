import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultPolicy, withConnectorAccess } from "@delegate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { checkPlanSteps } from "../../agent/planner";
import { type SubAgentTask } from "../../agent/subagent";
import { connectWithTransport, type OpenConnection } from "../../connectors/client";
import { screenRemoteTools } from "../../connectors/screen";
import { createConnectorTools } from "../../connectors/tools";
import { type ModelRequest } from "../../providers/types";
import { loadRuntimePrompts } from "../../server";
import { type ToolApprovalGate } from "../../tools/approvals";
import { createFetcher } from "../../tools/fetch";
import { scriptedProvider, testRun, textTurn, toolTurn } from "../../testing/fakes";
import { GOAL_STEP_IDS } from "./plan";
import { createCustomGoalMission } from "./run";

const OUTPUT = "Ticket 4711 is blocked on the payments migration until the vendor ships v2.";

function server(calls: string[]): OpenConnection {
  return async () => {
    const mcp = new McpServer({ name: "tickets", version: "1.0.0" });
    mcp.registerTool(
      "search_tickets",
      {
        description: "Search tickets.",
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      ({ query }) => {
        calls.push(`search:${query}`);
        return { content: [{ type: "text", text: OUTPUT }] };
      },
    );
    mcp.registerTool(
      "add_comment",
      { description: "Comment on a ticket.", inputSchema: { id: z.string(), body: z.string() } },
      ({ id }) => {
        calls.push(`comment:${id}`);
        return { content: [{ type: "text", text: "Comment added to ticket 4711 by Delegate." }] };
      },
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    return connectWithTransport(client);
  };
}

async function connectorTools(calls: string[]) {
  const open = server(calls);
  const connection = await open();
  const tools = screenRemoteTools(await connection.listTools());
  await connection.close();
  return createConnectorTools({
    readerPrompt: "Quarantined reader.",
    connectors: [{ connectorId: "c1", name: "tickets", host: "mcp.tickets.example", tools, open }],
  });
}

function provider() {
  let worker = 0;
  return scriptedProvider("fake", (request: ModelRequest) => {
    if (request.model === "fake-fast")
      return textTurn(
        JSON.stringify({
          sources: [
            {
              sourceId: "S1",
              facts: [
                {
                  claim: "Ticket 4711 is blocked on the payments migration.",
                  quote: "Ticket 4711 is blocked on the payments migration",
                  kind: "status",
                },
              ],
              injectionSuspected: false,
            },
          ],
        }),
      );
    worker += 1;
    if (worker === 1)
      return toolTurn([
        { id: "c1", name: "mcp__tickets__search_tickets", args: { query: "payments" } },
      ]);
    if (worker === 2)
      return toolTurn([
        { id: "c2", name: "mcp__tickets__add_comment", args: { id: "4711", body: "Escalated" } },
      ]);
    return textTurn("Searched tickets and asked to comment.");
  });
}

async function setup(approvals?: ToolApprovalGate) {
  const calls: string[] = [];
  const tools = await connectorTools(calls);
  const run = testRun({
    provider: provider(),
    policies: [withConnectorAccess(defaultPolicy, ["mcp.tickets.example"])],
    ...(approvals === undefined ? {} : { approvals }),
  });
  const ctx = { ...run.ctx, connectorTools: tools };
  const mission = createCustomGoalMission({
    ctx,
    input: { goal: "Unblock the payments migration tickets" },
    fetcher: createFetcher({
      fetchImpl: () => Promise.reject(new Error("no network in this test")),
      resolveDns: () => Promise.resolve(["93.184.215.14"]),
    }),
    prompts: loadRuntimePrompts(),
  });
  return { calls, mission, events: run.events };
}

function task(step: ReturnType<typeof stepFrom>): SubAgentTask {
  const said: string[] = [];
  return {
    step,
    grant: { id: step.id, capabilities: step.capabilities },
    agent: {
      agentId: "agent_1",
      say: (text) => {
        said.push(text);
        return Promise.resolve();
      },
    },
    inputs: new Map(),
    spawn: () => Promise.reject(new Error("not used")),
  };
}

function stepFrom(mission: Awaited<ReturnType<typeof setup>>["mission"]) {
  const step = mission.defaultPlan.find((entry) => entry.id === GOAL_STEP_IDS.connectors);
  if (step === undefined) throw new Error("no connector step in the default plan");
  return step;
}

describe("custom goal with MCP connectors", () => {
  it("adds a connector step to the plan when the workspace has connector tools", async () => {
    const { mission } = await setup();
    expect(mission.planner.allowedCapabilities).toEqual(
      expect.arrayContaining(["connector.read", "connector.write"]),
    );
    expect(checkPlanSteps(mission.defaultPlan, mission.planner).ok).toBe(true);
    const synthesise = mission.defaultPlan.find((step) => step.id === GOAL_STEP_IDS.synthesise);
    expect(synthesise?.inputs).toContain(GOAL_STEP_IDS.connectors);
  });

  it("turns read-only connector output into cited, untrusted findings and asks before writing", async () => {
    const asked: string[] = [];
    const reject: ToolApprovalGate = {
      decide: (request) => {
        asked.push(request.tool);
        return Promise.resolve({
          resolution: "rejected",
          resolvedBy: { type: "guest", id: "visitor" },
        });
      },
    };
    const { mission, calls, events } = await setup(reject);
    const executor = mission.planner.executors.find(
      (entry) => entry.id === GOAL_STEP_IDS.connectors,
    );
    const result = await executor?.run(task(stepFrom(mission)));
    expect(calls).toEqual(["search:payments"]);
    expect(asked).toEqual(["mcp__tickets__add_comment"]);
    expect(result?.findings).toEqual([
      expect.objectContaining({
        text: "Ticket 4711 is blocked on the payments migration.",
        trust: "untrusted",
      }),
    ]);
    expect(result?.sources[0]).toMatchObject({
      kind: "connector",
      title: "tickets · search_tickets",
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["connector.call", "approval.requested", "approval.resolved"]),
    );
  });

  it("runs the write tool once a human approves it", async () => {
    const approve: ToolApprovalGate = {
      decide: () =>
        Promise.resolve({ resolution: "approved", resolvedBy: { type: "guest", id: "visitor" } }),
    };
    const { mission, calls } = await setup(approve);
    const executor = mission.planner.executors.find(
      (entry) => entry.id === GOAL_STEP_IDS.connectors,
    );
    await executor?.run(task(stepFrom(mission)));
    expect(calls).toEqual(["search:payments", "comment:4711"]);
  });
});
