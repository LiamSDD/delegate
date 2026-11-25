import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPolicyDecisions, parseDecisionFilter } from "./audit";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { appendEvent, createRunRecord } from "./runs";
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

describe("parseDecisionFilter", () => {
  it("accepts known decisions only", () => {
    expect(parseDecisionFilter("deny")).toBe("deny");
    expect(parseDecisionFilter(["allow", "deny"])).toBe("allow");
    expect(parseDecisionFilter("drop table")).toBeUndefined();
    expect(parseDecisionFilter(undefined)).toBeUndefined();
  });
});
