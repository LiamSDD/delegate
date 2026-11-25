import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPolicyDecisions, parseDecisionFilter } from "./audit";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createForkRecord, planRunFork } from "./fork";
import { appendEvent, createRunRecord, type EventDraft, getRunRecord, readAllEvents } from "./runs";
import { createGuest, type GuestSession } from "./session";

let app: AppDatabase;
let guest: GuestSession;
let stranger: GuestSession;
let runId: string;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
  guest = await createGuest(app);
  stranger = await createGuest(app);
  ({ runId } = await createRunRecord(app, guest, {
    missionId: "company-xray",
    input: { url: "https://www.acme.com/" },
    execution: "live",
  }));
  const ctx = { runId, workspaceId: guest.workspaceId, userId: guest.userId };
  for (const [decision, tool, reason] of [
    ["allow", "crawl_site", "acme.com is on the egress allowlist"],
    ["deny", "fetch_page", "169.254.169.254 is a metadata address"],
    ["require_approval", "open_pr", "Pull requests need a human approval"],
  ] as const) {
    await appendEvent(app, ctx, {
      type: "policy.decided",
      stepId: "research",
      payload: { toolCallId: `tc-${tool}`, tool, decision, policyId: "egress", reason },
    });
  }
});

afterAll(async () => {
  await app.close();
});

describe("listPolicyDecisions", () => {
  it("lists the workspace's policy decisions newest first with counts per decision", async () => {
    const listing = await listPolicyDecisions(app, guest);
    expect(listing.entries.map((entry) => entry.decision)).toEqual([
      "require_approval",
      "deny",
      "allow",
    ]);
    expect(listing.entries[1]).toMatchObject({
      runId,
      mission: "company-xray",
      target: "acme.com",
      tool: "fetch_page",
      policyId: "egress",
      stepId: "research",
      reason: "169.254.169.254 is a metadata address",
    });
    expect(listing.counts).toEqual({ allow: 1, deny: 1, require_approval: 1 });
  });

  it("filters by decision", async () => {
    const listing = await listPolicyDecisions(app, guest, { decision: "deny" });
    expect(listing.entries.map((entry) => entry.tool)).toEqual(["fetch_page"]);
    expect(listing.counts.allow).toBe(1);
  });

  it("shows nothing from another workspace", async () => {
    const listing = await listPolicyDecisions(app, stranger);
    expect(listing.entries).toEqual([]);
    expect(listing.counts).toEqual({ allow: 0, deny: 0, require_approval: 0 });
  });
});

describe("listPolicyDecisions with forks", () => {
  it("counts a decision once even after a fork copies the parent's events", async () => {
    const owner = await createGuest(app);
    const parent = await createRunRecord(app, owner, {
      missionId: "company-xray",
      input: { url: "https://acme.com/" },
      execution: "simulated",
    });
    const ctx = { runId: parent.runId, workspaceId: owner.workspaceId, userId: owner.userId };
    const step = (id: string) => ({
      id,
      role: "researcher" as const,
      objective: `Do ${id}`,
      inputs: [],
      capabilities: [],
      acceptance: ["ok"],
      budgetShare: 0.5,
    });
    const decided = (stepId: string, decision: "allow" | "deny" | "require_approval") => ({
      type: "policy.decided" as const,
      stepId,
      payload: {
        toolCallId: `tc-${stepId}-${decision}`,
        tool: "fetch_page",
        decision,
        policyId: "egress",
        reason: `${decision} for ${stepId}`,
      },
    });
    const drafts: EventDraft[] = [
      { type: "plan.proposed", payload: { version: 1, steps: [step("first"), step("second")] } },
      {
        type: "plan.approved",
        payload: { version: 1, approvedBy: { type: "system", id: "auto" } },
      },
      { type: "step.started", stepId: "first", payload: {} },
      decided("first", "allow"),
      {
        type: "step.completed",
        stepId: "first",
        payload: { outcome: "succeeded", summary: "ok", artifactIds: [] },
      },
      { type: "step.started", stepId: "second", payload: {} },
      decided("second", "deny"),
      {
        type: "step.completed",
        stepId: "second",
        payload: { outcome: "failed", summary: "no", artifactIds: [] },
      },
      { type: "run.failed", payload: { error: { code: "denied", message: "denied" } } },
    ];
    for (const draft of drafts) await appendEvent(app, ctx, draft);

    const record = await getRunRecord(app, owner.userId, parent.runId);
    if (record === null) throw new Error("missing parent");
    const plan = planRunFork(await readAllEvents(app, owner.userId, parent.runId), {
      stepId: "second",
    });
    if (!plan.ok) throw new Error(plan.message);
    const fork = await createForkRecord(app, owner, record, plan, "simulated");
    await appendEvent(
      app,
      { runId: fork.runId, workspaceId: owner.workspaceId, userId: owner.userId },
      decided("second", "require_approval"),
    );

    const listing = await listPolicyDecisions(app, owner);
    expect(listing.counts).toEqual({ allow: 1, deny: 1, require_approval: 1 });
    expect(listing.entries.map((entry) => [entry.runId, entry.decision])).toEqual([
      [fork.runId, "require_approval"],
      [parent.runId, "deny"],
      [parent.runId, "allow"],
    ]);
    const allowed = await listPolicyDecisions(app, owner, { decision: "allow" });
    expect(allowed.entries.map((entry) => entry.runId)).toEqual([parent.runId]);
  });
});

describe("parseDecisionFilter", () => {
  it("accepts known decisions only", () => {
    expect(parseDecisionFilter("deny")).toBe("deny");
    expect(parseDecisionFilter(["allow", "deny"])).toBe("allow");
    expect(parseDecisionFilter("drop table")).toBeUndefined();
    expect(parseDecisionFilter(undefined)).toBeUndefined();
  });
});
