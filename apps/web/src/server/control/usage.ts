import { runEvents, runs, withTenant } from "@delegate/db";
import { AUTOPILOT_MISSION_ID } from "@delegate/runtime";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "../db";
import { GUEST_RUNS_PER_HOUR, type GuestSession } from "../session";

export const USAGE_WINDOW_DAYS = 7;

export const VERCEL_SANDBOX_HOBBY = {
  activeCpuHoursPerMonth: 5,
  source: "https://vercel.com/docs/sandbox/pricing",
  checkedOn: "2026-11-25",
} as const;

export const CRAWL_PAGE_TOOL = "crawl_page";
export const CRAWL_SITE_TOOL = "crawl_site";
export const CRAWL_SITE_SUMMARY = "^Crawled ([0-9]+) pages? of ";

export interface MissionUsage {
  mission: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface WorkspaceUsage {
  now: Date;
  since: Date;
  windowDays: number;
  quota: { limitPerHour: number; lastHour: number; today: number; dayStart: Date };
  missions: MissionUsage[];
  fallbacks: { total: number; exhausted: number; byReason: { reason: string; count: number }[] };
  sandbox: { commands: number; seconds: number };
  crawl: { pages: number; siteCrawls: number; uncountedCrawls: number };
}

const whole = z.coerce.number().int().nonnegative();

const quotaRow = z.object({ lastHour: whole, today: whole });
const runsRow = z.object({ mission: z.string(), runs: whole });
const tokensRow = z.object({ mission: z.string(), inputTokens: whole, outputTokens: whole });
const reasonRow = z.object({ reason: z.string().nullable(), count: whole, exhausted: whole });
const eventsRow = z.object({
  sandboxCommands: whole,
  sandboxMs: whole,
  pageFetches: whole,
  siteCrawls: whole,
  sitePages: whole,
  uncountedCrawls: whole,
});

const recordedByThisRun = sql`${runEvents.seq} > coalesce((
  select (fork_origin.payload->'forkedFrom'->>'seededThrough')::int
  from ${runEvents} as fork_origin
  where fork_origin.run_id = ${runEvents.runId} and fork_origin.type = 'run.created'
  limit 1
), 0)`;

function instant(date: Date) {
  return sql`${date.toISOString()}::timestamptz`;
}

export function emptyUsage(now = new Date()): WorkspaceUsage {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    now,
    since: new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    windowDays: USAGE_WINDOW_DAYS,
    quota: { limitPerHour: GUEST_RUNS_PER_HOUR, lastHour: 0, today: 0, dayStart },
    missions: [],
    fallbacks: { total: 0, exhausted: 0, byReason: [] },
    sandbox: { commands: 0, seconds: 0 },
    crawl: { pages: 0, siteCrawls: 0, uncountedCrawls: 0 },
  };
}

export async function workspaceUsage(
  app: AppDatabase,
  session: GuestSession,
  now = new Date(),
): Promise<WorkspaceUsage> {
  const usage = emptyUsage(now);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const inWorkspace = eq(runEvents.workspaceId, session.workspaceId);
  const inWindow = sql`${runEvents.createdAt} >= ${instant(usage.since)}`;
  const payload = runEvents.payload;
  const isTool = (tool: string) =>
    sql`${runEvents.type} = 'tool.result' and ${payload}->>'tool' = ${tool} and ${payload}->>'ok' = 'true'`;

  return withTenant(app.db, session.userId, async (tx) => {
    const [quota] = await tx
      .select({
        lastHour: sql`count(*) filter (where ${runs.createdAt} >= ${instant(hourAgo)} and ${runs.mission} <> ${AUTOPILOT_MISSION_ID})`,
        today: sql`count(*) filter (where ${runs.createdAt} >= ${instant(usage.quota.dayStart)})`,
      })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, session.workspaceId),
          sql`${runs.createdAt} >= least(${instant(hourAgo)}, ${instant(usage.quota.dayStart)})`,
        ),
      );
    const started = await tx
      .select({ mission: runs.mission, runs: sql`count(*)` })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, session.workspaceId),
          sql`${runs.createdAt} >= ${instant(usage.since)}`,
        ),
      )
      .groupBy(runs.mission);
    const tokens = await tx
      .select({
        mission: runs.mission,
        inputTokens: sql`coalesce(sum((${payload}->>'inputTokens')::bigint), 0)`,
        outputTokens: sql`coalesce(sum((${payload}->>'outputTokens')::bigint), 0)`,
      })
      .from(runEvents)
      .innerJoin(runs, eq(runs.id, runEvents.runId))
      .where(and(inWorkspace, eq(runEvents.type, "usage.updated"), inWindow, recordedByThisRun))
      .groupBy(runs.mission);
    const reasons = await tx
      .select({
        reason: sql`${payload}->>'reason'`,
        count: sql`count(*)`,
        exhausted: sql`count(*) filter (where jsonb_typeof(${payload}->'to') = 'null')`,
      })
      .from(runEvents)
      .where(and(inWorkspace, eq(runEvents.type, "model.fallback"), inWindow, recordedByThisRun))
      .groupBy(sql`${payload}->>'reason'`);
    const [events] = await tx
      .select({
        sandboxCommands: sql`count(*) filter (where ${runEvents.type} = 'sandbox.command')`,
        sandboxMs: sql`coalesce(sum((${payload}->>'durationMs')::bigint) filter (where ${runEvents.type} = 'sandbox.command'), 0)`,
        pageFetches: sql`count(*) filter (where ${isTool(CRAWL_PAGE_TOOL)})`,
        siteCrawls: sql`count(*) filter (where ${isTool(CRAWL_SITE_TOOL)})`,
        sitePages: sql`coalesce(sum((substring(${payload}->>'summary' from ${CRAWL_SITE_SUMMARY}))::int) filter (where ${isTool(CRAWL_SITE_TOOL)}), 0)`,
        uncountedCrawls: sql`count(*) filter (where ${isTool(CRAWL_SITE_TOOL)} and ${payload}->>'summary' !~ ${CRAWL_SITE_SUMMARY})`,
      })
      .from(runEvents)
      .where(
        and(
          inWorkspace,
          inArray(runEvents.type, ["sandbox.command", "tool.result"]),
          inWindow,
          recordedByThisRun,
        ),
      );

    const quotaCounts = quotaRow.parse(quota ?? { lastHour: 0, today: 0 });
    const byMission = new Map<string, MissionUsage>();
    for (const raw of started) {
      const row = runsRow.parse(raw);
      byMission.set(row.mission, { ...row, inputTokens: 0, outputTokens: 0 });
    }
    for (const raw of tokens) {
      const row = tokensRow.parse(raw);
      const known = byMission.get(row.mission) ?? { mission: row.mission, runs: 0 };
      byMission.set(row.mission, { ...known, ...row });
    }
    const byReason = reasons
      .map((raw) => reasonRow.parse(raw))
      .map((row) => ({ ...row, reason: row.reason ?? "unknown" }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    const counted = eventsRow.parse(
      events ?? {
        sandboxCommands: 0,
        sandboxMs: 0,
        pageFetches: 0,
        siteCrawls: 0,
        sitePages: 0,
        uncountedCrawls: 0,
      },
    );
    return {
      ...usage,
      quota: { ...usage.quota, lastHour: quotaCounts.lastHour, today: quotaCounts.today },
      missions: [...byMission.values()].sort(
        (a, b) =>
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
          b.runs - a.runs ||
          a.mission.localeCompare(b.mission),
      ),
      fallbacks: {
        total: byReason.reduce((sum, row) => sum + row.count, 0),
        exhausted: byReason.reduce((sum, row) => sum + row.exhausted, 0),
        byReason: byReason.map(({ reason, count }) => ({ reason, count })),
      },
      sandbox: {
        commands: counted.sandboxCommands,
        seconds: Math.round(counted.sandboxMs / 100) / 10,
      },
      crawl: {
        pages: counted.pageFetches + counted.sitePages,
        siteCrawls: counted.siteCrawls,
        uncountedCrawls: counted.uncountedCrawls,
      },
    };
  });
}
