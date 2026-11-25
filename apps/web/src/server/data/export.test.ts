import { auditLog, mcpConnectors, withTenant } from "@delegate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiToken } from "../api-tokens";
import { jsonPost, newGuest, newRun, ORIGIN, type TestGuest, testDeps } from "../control/testing";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { appendEvent, type RunContext } from "../runs";
import { createRateLimiter } from "../session";
import { setRunsPaused, updateAutomation } from "../workspace-settings";
import {
  DATA_EXPORTED_ACTION,
  DEFAULT_EXPORT_LIMITS,
  EXPORT_FORMAT,
  EXPORT_MAX_BYTES,
  EXPORT_MIN_BYTES,
  type ExportDeps,
  exportChunks,
  type ExportLimits,
  handleExportData,
} from "./export";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const archiveSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  limits: z.object({ maxBytes: z.number(), maxDurationMs: z.number() }),
  workspace: z.object({ id: z.uuid(), tier: z.string().optional() }),
  settings: z.object({
    autoApprovePlans: z.boolean(),
    preapprovedTools: z.array(z.string()),
    runsPausedAt: z.string().nullable(),
  }),
  connections: z.object({
    connectors: z.array(z.object({ name: z.string(), url: z.string(), hasSecret: z.boolean() })),
    apiTokens: z.array(z.object({ name: z.string(), prefix: z.string() })),
    githubInstallations: z.array(z.unknown()),
  }),
  runs: z.array(
    z.object({
      id: z.uuid(),
      mission: z.string(),
      status: z.string(),
      input: z.unknown(),
      artifacts: z.array(z.object({ kind: z.string(), title: z.string(), content: z.unknown() })),
      events: z.array(z.object({ seq: z.number(), type: z.string(), payload: z.unknown() })),
      truncated: z.boolean(),
    }),
  ),
  truncated: z
    .object({
      reason: z.enum(["size_limit", "time_limit"]),
      message: z.string(),
      runsIncluded: z.number(),
      runsOmitted: z.number(),
      omittedRunIds: z.array(z.uuid()),
      partialRunId: z.uuid().nullable(),
    })
    .nullable(),
  complete: z.literal(true),
});

async function collect(guest: TestGuest, limits: Partial<ExportLimits> = {}) {
  let text = "";
  for await (const chunk of exportChunks(app, guest.session, {
    ...DEFAULT_EXPORT_LIMITS,
    ...limits,
  }))
    text += chunk;
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    archive: archiveSchema.parse(JSON.parse(text)),
  };
}

async function artifact(ctx: RunContext, kind: string, content: unknown) {
  await appendEvent(app, ctx, {
    type: "artifact.created",
    payload: { artifactId: crypto.randomUUID(), kind, title: `A ${kind}`, version: 1, content },
  });
}

async function note(ctx: RunContext, text: string) {
  await appendEvent(app, ctx, {
    type: "policy.decided",
    payload: { tool: "fetch_page", decision: "allow", policyId: "builtin", reason: text },
  });
}

function exportDeps(overrides: Partial<ExportDeps> = {}): ExportDeps {
  return {
    ...testDeps(app),
    exportLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    ...overrides,
  };
}

function form(cookie: string | null, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/settings/data/export`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      host: "localhost:3000",
      ...(cookie === null ? {} : { cookie }),
      ...headers,
    },
    body: "",
  });
}

describe("the export archive", () => {
  it("is a valid, empty archive for a workspace that has not run anything", async () => {
    const guest = await newGuest(app);
    const { archive } = await collect(guest);
    expect(archive).toMatchObject({
      workspace: { id: guest.session.workspaceId, tier: "guest" },
      runs: [],
      truncated: null,
      complete: true,
    });
    expect(archive.limits.maxBytes).toBe(EXPORT_MAX_BYTES);
  });

  it("holds every run with its events and artifacts, newest first, and nothing of another workspace", async () => {
    const guest = await newGuest(app);
    const other = await newGuest(app);
    const first = await newRun(app, guest, { missionId: "automation-audit" });
    await note(first, "first run decision");
    await artifact(first, "automation-audit", { opportunities: ["triage"] });
    const second = await newRun(app, guest, { missionId: "company-xray" });
    await artifact(second, "company-xray-brief", { company: "Acme" });
    await appendEvent(app, second, { type: "run.completed", payload: { summary: "done" } });
    const foreign = await newRun(app, other);
    await note(foreign, "another tenant's secret decision");

    const { token } = await createApiToken(app, guest.session, "laptop");
    await withTenant(app.db, guest.session.userId, (tx) =>
      tx.insert(mcpConnectors).values({
        workspaceId: guest.session.workspaceId,
        name: "tickets",
        url: "https://mcp.tickets.example/mcp",
        authHeaderName: "Authorization",
        secretCiphertext: "v1.sealed-secret-value",
        tools: [
          { name: "list", description: "", readOnly: true, withheld: false, inputSchema: {} },
        ],
      }),
    );
    await updateAutomation(app, guest.session, { autoApprovePlans: true });
    await setRunsPaused(app, guest.session, true);

    const { text, archive } = await collect(guest);
    expect(archive.runs.map((run) => run.id)).toEqual([second.runId, first.runId]);
    expect(archive.runs[0]).toMatchObject({
      mission: "company-xray",
      status: "completed",
      truncated: false,
      artifacts: [{ kind: "company-xray-brief", content: { company: "Acme" } }],
    });
    expect(archive.runs[0]?.events.map((event) => event.type)).toEqual([
      "run.created",
      "artifact.created",
      "run.completed",
    ]);
    expect(archive.runs[1]?.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(archive.settings).toMatchObject({ autoApprovePlans: true });
    expect(archive.settings.runsPausedAt).not.toBeNull();
    expect(archive.connections.connectors).toEqual([
      expect.objectContaining({
        name: "tickets",
        url: "https://mcp.tickets.example/mcp",
        hasSecret: true,
      }),
    ]);
    expect(archive.connections.apiTokens).toEqual([
      expect.objectContaining({ name: "laptop", prefix: token.slice(0, 12) }),
    ]);
    expect(text).not.toContain(token);
    expect(text).not.toContain("sealed-secret-value");
    expect(text).not.toContain(foreign.runId);
    expect(text).not.toContain("another tenant's secret decision");
    expect(archive.truncated).toBeNull();
  });

  it("stops at the size cap, stays valid JSON and says what is missing", async () => {
    const guest = await newGuest(app);
    const runsInOrder: RunContext[] = [];
    for (let index = 0; index < 6; index += 1) {
      const ctx = await newRun(app, guest);
      for (let event = 0; event < 12; event += 1) await note(ctx, `${"x".repeat(400)} ${event}`);
      await artifact(ctx, "report", { body: "y".repeat(600) });
      runsInOrder.push(ctx);
    }
    const full = await collect(guest);
    expect(full.archive.truncated).toBeNull();
    expect(full.archive.runs).toHaveLength(6);

    const maxBytes = 20 * 1024;
    expect(full.bytes).toBeGreaterThan(maxBytes);
    const capped = await collect(guest, { maxBytes });
    expect(capped.bytes).toBeLessThanOrEqual(maxBytes);
    const { truncated } = capped.archive;
    if (truncated === null) throw new Error("expected a truncated archive");
    expect(truncated.reason).toBe("size_limit");
    expect(truncated.message).toContain("size limit");
    expect(capped.archive.complete).toBe(true);

    const newestFirst = [...runsInOrder].reverse().map((ctx) => ctx.runId);
    expect(capped.archive.runs.map((run) => run.id)).toEqual(
      newestFirst.slice(0, capped.archive.runs.length),
    );
    expect(truncated.runsIncluded).toBe(capped.archive.runs.length);
    expect(truncated.runsIncluded + truncated.runsOmitted).toBe(6);
    expect(truncated.omittedRunIds).toEqual(newestFirst.slice(truncated.runsIncluded));
    const partial = capped.archive.runs.filter((run) => run.truncated).map((run) => run.id);
    expect(partial).toEqual(truncated.partialRunId === null ? [] : [truncated.partialRunId]);
    for (const run of capped.archive.runs.filter((entry) => !entry.truncated))
      expect(run.events).toHaveLength(14);
    expect(capped.archive.runs.length).toBeLessThan(6);
    expect(capped.archive.runs.length).toBeGreaterThan(0);

    for (const size of [EXPORT_MIN_BYTES, 9_000, 12_345, 16_384, 31_000]) {
      const sized = await collect(guest, { maxBytes: size });
      expect(sized.bytes, String(size)).toBeLessThanOrEqual(size);
      expect(sized.archive.truncated?.reason).toBe("size_limit");
    }
    await expect(collect(guest, { maxBytes: EXPORT_MIN_BYTES - 1 })).rejects.toThrow(/at least/);
  });

  it("stops at the time limit with the same kind of note", async () => {
    const guest = await newGuest(app);
    for (let index = 0; index < 3; index += 1) await note(await newRun(app, guest), "decision");
    let clock = 0;
    const { archive } = await collect(guest, {
      maxDurationMs: 1_000,
      now: () => (clock += 400),
    });
    expect(archive.truncated).toMatchObject({ reason: "time_limit" });
    expect(archive.truncated?.message).toContain("1 second time limit");
    expect(archive.runs.length).toBeLessThan(3);
    expect(archive.complete).toBe(true);
  });
});

describe("POST /settings/data/export", () => {
  it("streams the archive as a download and records the export first", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    await note(ctx, "a decision");
    const response = await handleExportData(form(guest.cookie), exportDeps());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      new RegExp(
        `^attachment; filename="delegate-export-${guest.session.workspaceId.slice(0, 8)}-\\d{4}-\\d{2}-\\d{2}\\.json"$`,
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const archive = archiveSchema.parse(JSON.parse(await response.text()));
    expect(archive.runs.map((run) => run.id)).toEqual([ctx.runId]);

    const audit = await withTenant(app.db, guest.session.userId, (tx) =>
      tx
        .select({ action: auditLog.action, actorId: auditLog.actorId })
        .from(auditLog)
        .where(eq(auditLog.workspaceId, guest.session.workspaceId)),
    );
    expect(audit).toEqual([{ action: DATA_EXPORTED_ACTION, actorId: guest.session.userId }]);
  });

  it("applies the configured size cap to the response body", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    for (let event = 0; event < 80; event += 1) await note(ctx, "z".repeat(500));
    const maxBytes = 16 * 1024;
    const response = await handleExportData(
      form(guest.cookie),
      exportDeps({ exportLimits: { ...DEFAULT_EXPORT_LIMITS, maxBytes } }),
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBeLessThanOrEqual(maxBytes);
    const archive = archiveSchema.parse(JSON.parse(new TextDecoder().decode(body)));
    expect(archive.truncated).toMatchObject({ reason: "size_limit", partialRunId: ctx.runId });
    expect(archive.runs[0]?.truncated).toBe(true);
  });

  it("refuses other origins and API tokens, and sends a visitor with nothing back to the page", async () => {
    const guest = await newGuest(app);
    const { token } = await createApiToken(app, guest.session, "cli");
    const deps = exportDeps();
    expect(
      (await handleExportData(form(guest.cookie, { origin: "https://evil.example" }), deps)).status,
    ).toBe(403);
    expect(
      (await handleExportData(form(null, { authorization: `Bearer ${token}` }), deps)).status,
    ).toBe(403);
    const anonymous = await handleExportData(form(null), deps);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe("/settings/data?export=nothing");
  });

  it("limits how often one visitor can export", async () => {
    const guest = await newGuest(app);
    const deps = exportDeps({
      exportLimiter: createRateLimiter({ limit: 1, windowMs: 3_600_000 }),
    });
    expect((await handleExportData(form(guest.cookie), deps)).status).toBe(200);
    const limited = await handleExportData(form(guest.cookie), deps);
    expect(limited.status).toBe(303);
    expect(limited.headers.get("location")).toBe("/settings/data?export=rate_limited");
  });

  it("is not reachable with a JSON post from another visitor's page", async () => {
    const guest = await newGuest(app);
    const stranger = await newGuest(app);
    const ctx = await newRun(app, guest);
    const response = await handleExportData(
      jsonPost("/settings/data/export", stranger.cookie, {
        workspaceId: guest.session.workspaceId,
      }),
      exportDeps(),
    );
    const text = await response.text();
    expect(text).not.toContain(ctx.runId);
    expect(archiveSchema.parse(JSON.parse(text)).workspace.id).toBe(stranger.session.workspaceId);
  });
});
