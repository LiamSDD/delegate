import { readFileSync } from "node:fs";
import path from "node:path";

import { mcpConnectors, withTenant } from "@delegate/db";
import {
  CAPABILITIES,
  defaultPolicy,
  evaluate,
  evaluateAll,
  type PolicyContext,
  shipConnectedPolicy,
  shipDemoPolicy,
  withConnectorAccess,
} from "@delegate/policy";
import { MISSIONS } from "@delegate/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleCreateRun } from "../api";
import { type AppDatabase, createPgliteAppDatabase, resolveRepoRoot } from "../db";
import type { MissionRunArgs } from "../mission-runner";
import { handleCreateShipRun } from "../ship-api";
import {
  appliedPolicies,
  handleSimulatePolicy,
  hostOf,
  type PolicyFacts,
  policiesForRun,
  policyFacts,
  SIMULATED_MISSION_IDS,
  type SimulateRequest,
  SimulateRequestSchema,
  simulate,
  SimulationInputError,
} from "./policies";
import { errorCode, jsonPost, newGuest, testDeps, type TestGuest } from "./testing";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NO_KEYS = {};

const guestFacts: PolicyFacts = {
  audience: "public-demo",
  tier: "guest",
  connectorHosts: [],
  connectorTools: [],
};

const connectedFacts: PolicyFacts = {
  audience: "public-demo",
  tier: "connected",
  connectorHosts: ["mcp.tickets.example"],
  connectorTools: [
    { name: "mcp__tickets__list_open", readOnly: true, host: "mcp.tickets.example" },
    { name: "mcp__tickets__add_comment", readOnly: false, host: "mcp.tickets.example" },
  ],
};

function request(input: Partial<SimulateRequest> & Pick<SimulateRequest, "missionId">) {
  return SimulateRequestSchema.parse({ sideEffect: false, ...input });
}

async function addConnector(guest: TestGuest) {
  await withTenant(app.db, guest.session.userId, (tx) =>
    tx.insert(mcpConnectors).values({
      workspaceId: guest.session.workspaceId,
      name: "tickets",
      url: "https://mcp.tickets.example/mcp",
      tools: [
        {
          name: "list_open",
          description: "List open tickets",
          readOnly: true,
          withheld: false,
          inputSchema: {},
        },
        {
          name: "add_comment",
          description: "Comment on a ticket",
          readOnly: false,
          withheld: false,
          inputSchema: {},
        },
        {
          name: "poisoned",
          description: "",
          readOnly: true,
          withheld: true,
          inputSchema: {},
        },
      ],
    }),
  );
}

describe("which policy set a run gets", () => {
  it("mirrors the runtime's policiesFor, whose source is pinned here", () => {
    const source = readFileSync(
      path.join(resolveRepoRoot(), "packages", "runtime", "src", "server.ts"),
      "utf8",
    );
    const match = /function policiesFor\([\s\S]*?\n}\n/.exec(source);
    expect(
      match?.[0],
      "policiesFor changed in packages/runtime/src/server.ts: update policiesForRun in apps/web/src/server/control/policies.ts to match, then this snapshot",
    ).toMatchInlineSnapshot(`
      "function policiesFor(missionId: MissionId, audience: Audience, connected: boolean): Policy[] {
        if (missionId === "ship-a-pr")
          return [
            audience === "owner" ? shipOwnerPolicy : connected ? shipConnectedPolicy : shipDemoPolicy,
          ];
        return [audience === "public-demo" ? defaultPolicy : ownerDefaultPolicy];
      }
      "
    `);
    expect(source).toContain(
      "policies: policiesFor(mission.id, audience, options.findInstallation !== undefined).map(\n      (policy) => withConnectorAccess(policy, options.connections?.hosts ?? []),\n    ),",
    );
  });

  it("gives a guest the demo set for every mission and patches only from Autopilot", () => {
    const ids = (origin: "direct" | "autopilot") =>
      Object.fromEntries(
        SIMULATED_MISSION_IDS.map((missionId) => [
          missionId,
          policiesForRun(guestFacts, missionId, origin).map((policy) => policy.id),
        ]),
      );
    expect(ids("direct")).toEqual({
      "company-xray": ["guest-demo"],
      "automation-audit": ["guest-demo"],
      "build-agent": ["guest-demo"],
      "custom-goal": ["guest-demo"],
      "repo-xray": ["guest-demo"],
      "ship-a-pr": ["ship-connected"],
    });
    expect(ids("autopilot")).toMatchObject({
      "custom-goal": ["guest-demo"],
      "ship-a-pr": ["ship-demo"],
    });
  });

  it("adds connector access where the run really receives the connectors", () => {
    const id = (
      missionId: (typeof SIMULATED_MISSION_IDS)[number],
      origin: "direct" | "autopilot",
    ) => policiesForRun(connectedFacts, missionId, origin)[0]?.id;
    expect(id("company-xray", "direct")).toBe("guest-demo+connectors");
    expect(id("custom-goal", "direct")).toBe("guest-demo+connectors");
    expect(id("ship-a-pr", "direct")).toBe("ship-connected");
    expect(id("custom-goal", "autopilot")).toBe("guest-demo+connectors");
    expect(id("company-xray", "autopilot")).toBe("guest-demo");
    expect(id("ship-a-pr", "autopilot")).toBe("ship-connected");
    expect(policiesForRun(connectedFacts, "custom-goal", "direct")[0]).toEqual(
      withConnectorAccess(defaultPolicy, ["mcp.tickets.example"]),
    );
  });

  it("uses the owner sets only in owner mode", () => {
    const owner: PolicyFacts = { ...guestFacts, audience: "owner" };
    expect(policiesForRun(owner, "company-xray", "direct")[0]?.id).toBe("owner-research");
    expect(policiesForRun(owner, "ship-a-pr", "autopilot")[0]?.id).toBe("ship-owner");
  });

  it("groups the sets for the settings page with every use listed once", () => {
    const applied = appliedPolicies(guestFacts);
    expect(applied.map((entry) => entry.policy.id)).toEqual([
      "guest-demo",
      "ship-connected",
      "ship-demo",
    ]);
    expect(applied.reduce((sum, entry) => sum + entry.uses.length, 0)).toBe(
      SIMULATED_MISSION_IDS.length * 2,
    );
    expect(applied[2]?.uses).toEqual([{ missionId: "ship-a-pr", origin: "autopilot" }]);
  });

  it("matches what a run started from the web app is actually handed", async () => {
    const guest = await newGuest(app);
    const seen: MissionRunArgs[] = [];
    const deps = testDeps(app, {
      shipEnabled: true,
      shipInstallations: () => () => Promise.resolve(null),
      runner: () => ({
        execution: "live",
        run: (args) => {
          seen.push(args);
          return Promise.resolve({ status: "completed" });
        },
      }),
      connections: () => Promise.resolve({ tools: [], hosts: ["mcp.tickets.example"] }),
    });
    const bodies = [
      { missionId: "company-xray", input: { url: "acme.com" } },
      { missionId: "automation-audit", input: { url: "acme.com" } },
      { missionId: "build-agent", input: { url: "acme.com", goal: "Answer support questions" } },
      { missionId: "custom-goal", input: { goal: "Cut support load" } },
      { missionId: "repo-xray", input: { url: "github.com/acme/widget" } },
    ];
    for (const body of bodies)
      expect((await handleCreateRun(jsonPost("/api/runs", guest.cookie, body), deps)).status).toBe(
        201,
      );
    const shipped = await handleCreateShipRun(
      jsonPost("/api/ship", guest.cookie, {
        repoUrl: "https://github.com/acme/widget",
        improvement: {
          id: "imp-1",
          title: "Make sum handle empty lists",
          rationale: "sum([]) throws.",
          files: ["src/sum.js"],
          kind: "bugfix",
          effort: "S",
          acceptance: ["sum([]) returns 0"],
        },
      }),
      deps,
    );
    expect(shipped.status).toBe(201);
    while (deps.tasks.length > 0) await deps.tasks.shift()?.();

    expect(seen.map((args) => args.missionId)).toEqual([...SIMULATED_MISSION_IDS]);
    for (const args of seen) {
      const mirrored = policiesForRun(connectedFacts, args.missionId, "direct")[0];
      expect(mirrored?.id.endsWith("+connectors"), args.missionId).toBe(
        args.connections !== undefined,
      );
      expect(args.findInstallation !== undefined, args.missionId).toBe(
        args.missionId === "ship-a-pr",
      );
    }
  });
});

describe("workspace facts", () => {
  it("are empty without a session and list connector hosts and usable tools with one", async () => {
    expect(await policyFacts(app, null, {})).toEqual(guestFacts);
    expect(
      (await policyFacts(app, null, { DELEGATE_OWNER_MODE: "1", NODE_ENV: "development" }))
        .audience,
    ).toBe("owner");
    expect(
      (await policyFacts(app, null, { DELEGATE_OWNER_MODE: "1", NODE_ENV: "production" })).audience,
    ).toBe("public-demo");

    const guest = await newGuest(app);
    expect(await policyFacts(app, guest.session, {})).toEqual(guestFacts);
    await addConnector(guest);
    expect(await policyFacts(app, guest.session, {})).toEqual(connectedFacts);
  });
});

describe("the dry-run simulator", () => {
  function context(overrides: Partial<PolicyContext>): PolicyContext {
    return {
      workspaceId: "dry-run",
      runId: "dry-run",
      stepId: "dry-run",
      actor: { type: "agent", id: "dry-run" },
      tool: "any-web.fetch-tool",
      capability: CAPABILITIES.webFetch,
      grantedCapabilities: [...MISSIONS["company-xray"].capabilities],
      argsSummary: "dry run",
      dataClassification: "public",
      provider: { id: "pollinations", terms: "public-demo-ok" },
      estimatedCostMicroUsd: 0,
      spentRunMicroUsd: 0,
      spentDayMicroUsd: 0,
      ...overrides,
    };
  }

  it("returns exactly what the policy engine returns for the same call", () => {
    const fetched = simulate(
      request({ missionId: "company-xray", capability: "web.fetch", host: "example.com" }),
      guestFacts,
      NO_KEYS,
    );
    const expected = context({ targetDomain: "example.com" });
    expect(fetched.decision).toEqual(evaluate([defaultPolicy], expected));
    expect(fetched.matched).toEqual(evaluateAll([defaultPolicy], expected));
    expect(fetched.decision).toMatchObject({
      decision: "allow",
      policyId: "builtin",
      ruleId: "default-allow",
    });
    expect(fetched.call).toEqual({
      missionId: "company-xray",
      origin: "direct",
      tool: "any-web.fetch-tool",
      capability: "web.fetch",
      host: "example.com",
      sideEffect: false,
      caller: "agent",
      provider: { id: "pollinations", terms: "public-demo-ok" },
      granted: true,
    });
    expect(fetched.policies).toEqual([{ id: "guest-demo", name: defaultPolicy.name }]);
  });

  it.each([
    ["localhost", "builtin", "blocked-host"],
    ["169.254.169.254", "builtin", "blocked-host"],
    ["http://intranet.internal/admin", "builtin", "blocked-host"],
    [undefined, "guest-demo", "fetch-only-egress"],
  ])("denies web.fetch to %s by %s/%s", (host, policyId, ruleId) => {
    const result = simulate(
      request({
        missionId: "company-xray",
        capability: "web.fetch",
        ...(host === undefined ? {} : { host }),
      }),
      guestFacts,
      NO_KEYS,
    );
    expect(result.decision).toMatchObject({ decision: "deny", policyId, ruleId });
    if (host === undefined)
      expect(result.matched.map((entry) => entry.ruleId)).toContain("egress-target-required");
  });

  it("denies a capability the mission's steps never hold", () => {
    const result = simulate(
      request({
        missionId: "company-xray",
        capability: "connector.write",
        host: "crm.example",
        sideEffect: true,
      }),
      guestFacts,
      NO_KEYS,
    );
    expect(result.call.granted).toBe(false);
    expect(result.decision).toMatchObject({
      decision: "deny",
      policyId: "builtin",
      ruleId: "capability-not-granted",
    });
    expect(result.matched.map((entry) => `${entry.policyId}/${entry.ruleId}`)).toEqual([
      "builtin/capability-not-granted",
      "guest-demo/read-only-capabilities",
      "guest-demo/fetch-only-egress",
      "builtin/side-effect-approval",
      "builtin/egress-not-allowlisted",
    ]);
  });

  it("classifies an unconnected connector tool from the side-effect answer", () => {
    const write = simulate(
      request({
        missionId: "custom-goal",
        tool: "mcp__crm__update_contact",
        host: "crm.example",
        sideEffect: true,
      }),
      guestFacts,
      NO_KEYS,
    );
    expect(write.call).toMatchObject({ capability: "connector.write", sideEffect: true });
    expect(write.decision).toMatchObject({
      decision: "deny",
      policyId: "guest-demo",
      ruleId: "read-only-capabilities",
    });
    expect(write.notes.join(" ")).toContain("not a tool of a connector in this workspace");
    const read = simulate(
      request({ missionId: "custom-goal", tool: "mcp__crm__find_contact", host: "crm.example" }),
      guestFacts,
      NO_KEYS,
    );
    expect(read.call).toMatchObject({ capability: "connector.read", sideEffect: false });
  });

  it("uses a connected tool's own classification and host, whatever the checkbox says", () => {
    const write = simulate(
      request({ missionId: "custom-goal", tool: "mcp__tickets__add_comment", sideEffect: false }),
      connectedFacts,
      NO_KEYS,
    );
    expect(write.call).toMatchObject({
      capability: "connector.write",
      host: "mcp.tickets.example",
      sideEffect: true,
    });
    expect(write.decision).toMatchObject({
      decision: "require_approval",
      policyId: "builtin",
      ruleId: "side-effect-approval",
    });
    expect(write.notes.join(" ")).toContain("always counts as a side effect");
    const read = simulate(
      request({ missionId: "custom-goal", tool: "mcp__tickets__list_open", sideEffect: true }),
      connectedFacts,
      NO_KEYS,
    );
    expect(read.decision).toMatchObject({ decision: "allow", ruleId: "default-allow" });
    expect(read.notes.join(" ")).toContain("never counts as a side effect");
    const elsewhere = simulate(
      request({
        missionId: "custom-goal",
        tool: "mcp__tickets__list_open",
        host: "evil.example",
      }),
      connectedFacts,
      NO_KEYS,
    );
    expect(elsewhere.decision).toMatchObject({ decision: "deny" });
  });

  it("checks a pull request as the system call it is: approval when direct, denied for a guest's Autopilot", () => {
    const direct = simulate(
      request({ missionId: "ship-a-pr", tool: "github.open_pr", sideEffect: true }),
      guestFacts,
      NO_KEYS,
    );
    const expected: PolicyContext = context({
      actor: { type: "system", id: "dry-run" },
      tool: "github.open_pr",
      capability: CAPABILITIES.repoWrite,
      grantedCapabilities: [...MISSIONS["ship-a-pr"].capabilities],
      targetDomain: "api.github.com",
    });
    delete expected.provider;
    expect(direct.decision).toEqual(evaluate([shipConnectedPolicy], expected));
    expect(direct.decision).toMatchObject({
      decision: "require_approval",
      policyId: "ship-connected",
      ruleId: "pull-request-approval",
    });
    expect(direct.call).toMatchObject({
      caller: "system",
      provider: null,
      host: "api.github.com",
      sideEffect: true,
    });

    const byCapability = simulate(
      request({ missionId: "ship-a-pr", capability: "repo.write", sideEffect: true }),
      guestFacts,
      NO_KEYS,
    );
    expect(byCapability.call.tool).toBe("github.open_pr");
    expect(byCapability.decision).toEqual(direct.decision);

    const child = simulate(
      request({
        missionId: "ship-a-pr",
        origin: "autopilot",
        tool: "github.open_pr",
        sideEffect: true,
      }),
      guestFacts,
      NO_KEYS,
    );
    expect(child.decision).toEqual(evaluate([shipDemoPolicy], expected));
    expect(child.decision).toMatchObject({ decision: "deny", policyId: "ship-demo" });
    expect(child.matched.map((entry) => entry.ruleId)).toContain("no-pull-requests");
  });

  it("agrees with the engine over the whole grid of missions and capabilities", () => {
    for (const facts of [guestFacts, connectedFacts])
      for (const missionId of SIMULATED_MISSION_IDS)
        for (const origin of ["direct", "autopilot"] as const)
          for (const capability of Object.values(CAPABILITIES))
            for (const host of [
              "example.com",
              "mcp.tickets.example",
              "api.github.com",
              undefined,
            ]) {
              const result = simulate(
                request({
                  missionId,
                  origin,
                  capability,
                  sideEffect: false,
                  ...(host === undefined ? {} : { host }),
                }),
                facts,
                NO_KEYS,
              );
              const system = result.call.caller === "system";
              const expected: PolicyContext = context({
                actor: { type: result.call.caller, id: "dry-run" },
                tool: result.call.tool,
                capability,
                grantedCapabilities: [...MISSIONS[missionId].capabilities],
                ...(result.call.host === null ? {} : { targetDomain: result.call.host }),
              });
              if (system) delete expected.provider;
              const policies = policiesForRun(facts, missionId, origin);
              expect(
                result.decision,
                `${missionId} ${origin} ${capability} ${String(host)}`,
              ).toEqual(evaluate(policies, expected));
            }
  });

  it("reads hosts out of URLs and refuses what is not a host", () => {
    expect(hostOf(" https://Docs.Example.com:8443/path?q=1 ")).toBe("docs.example.com");
    expect(hostOf("example.com/pricing")).toBe("example.com");
    expect(hostOf("[::1]")).toBe("::1");
    expect(hostOf("")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
    expect(() => hostOf("http://")).toThrow(SimulationInputError);
    expect(() => hostOf("not a host")).toThrow(SimulationInputError);
  });

  it("asks for a capability when it cannot classify a tool by name", () => {
    expect(() =>
      simulate(request({ missionId: "company-xray", tool: "launch_rocket" }), guestFacts, NO_KEYS),
    ).toThrow(SimulationInputError);
    const named = simulate(
      request({
        missionId: "company-xray",
        tool: "fetch_page",
        capability: "web.fetch",
        host: "example.com",
      }),
      guestFacts,
      NO_KEYS,
    );
    expect(named.call.tool).toBe("fetch_page");
    expect(
      SimulateRequestSchema.safeParse({ missionId: "company-xray", sideEffect: false }).success,
    ).toBe(false);
    expect(
      SimulateRequestSchema.safeParse({
        missionId: "autopilot",
        capability: "web.fetch",
        sideEffect: false,
      }).success,
    ).toBe(false);
  });
});

describe("POST /settings/policies/simulate", () => {
  const body = { missionId: "custom-goal", tool: "mcp__tickets__add_comment", sideEffect: true };

  it("answers from the workspace's own connectors without calling a model or the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const guest = await newGuest(app);
    await addConnector(guest);
    const response = await handleSimulatePolicy(
      jsonPost("/settings/policies/simulate", guest.cookie, body),
      testDeps(app),
      NO_KEYS,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      decision: {
        decision: "require_approval",
        policyId: "builtin",
        ruleId: "side-effect-approval",
      },
      call: { capability: "connector.write", host: "mcp.tickets.example" },
      policies: [{ id: "guest-demo+connectors" }],
    });

    const stranger = await newGuest(app);
    const theirs = await handleSimulatePolicy(
      jsonPost("/settings/policies/simulate", stranger.cookie, body),
      testDeps(app),
      NO_KEYS,
    );
    expect(await theirs.json()).toMatchObject({
      decision: { decision: "deny" },
      policies: [{ id: "guest-demo" }],
    });

    const anonymous = await handleSimulatePolicy(
      jsonPost("/settings/policies/simulate", null, {
        missionId: "company-xray",
        capability: "web.fetch",
        host: "example.com",
        sideEffect: false,
      }),
      testDeps(app),
      NO_KEYS,
    );
    expect(await anonymous.json()).toMatchObject({ decision: { decision: "allow" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses other origins and explains invalid input", async () => {
    const deps = testDeps(app);
    const crossSite = await handleSimulatePolicy(
      jsonPost("/settings/policies/simulate", null, body, { origin: "https://evil.example" }),
      deps,
      NO_KEYS,
    );
    expect(crossSite.status).toBe(403);
    const invalid = await handleSimulatePolicy(
      jsonPost("/settings/policies/simulate", null, { missionId: "company-xray" }),
      deps,
      NO_KEYS,
    );
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe("invalid_request");
    const badHost = await handleSimulatePolicy(
      jsonPost("/settings/policies/simulate", null, {
        missionId: "company-xray",
        capability: "web.fetch",
        host: "not a host",
        sideEffect: false,
      }),
      deps,
      NO_KEYS,
    );
    expect(badHost.status).toBe(400);
    expect(await badHost.json()).toMatchObject({
      error: { message: expect.stringContaining("not a host name") as unknown },
    });
  });
});
