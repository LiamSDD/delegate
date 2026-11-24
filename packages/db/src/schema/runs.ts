import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { RUN_EVENT_TYPES } from "../event-types";
import { type PromptVersions, type RunBudget, type RunTotals, emptyRunTotals } from "../run-json";
import { approvalStatus, runStatus } from "./enums";
import { operators, readers, tenantPolicies } from "./rls";
import { users, workspaces } from "./tenancy";

const runEventTypeList = sql.raw(RUN_EVENT_TYPES.map((type) => `'${type}'`).join(", "));

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    mission: text("mission").notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    status: runStatus("status").notNull().default("pending"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    parentRunId: uuid("parent_run_id"),
    forkedFromSeq: integer("forked_from_seq"),
    promptVersions: jsonb("prompt_versions").$type<PromptVersions>().notNull().default({}),
    budget: jsonb("budget").$type<RunBudget>().notNull().default({}),
    totals: jsonb("totals").$type<RunTotals>().notNull().default(emptyRunTotals),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("runs_id_workspace_unique").on(t.id, t.workspaceId),
    foreignKey({
      name: "runs_parent_run_fk",
      columns: [t.parentRunId, t.workspaceId],
      foreignColumns: [t.id, t.workspaceId],
    }),
    check(
      "runs_forked_from_seq_needs_parent",
      sql`${t.forkedFromSeq} is null or (${t.parentRunId} is not null and ${t.forkedFromSeq} >= 0)`,
    ),
    index("runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    ...tenantPolicies("runs", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
    }),
  ],
).enableRLS();

const runOf = (runId: AnyPgColumn, workspaceId: AnyPgColumn, name: string) =>
  foreignKey({
    name,
    columns: [runId, workspaceId],
    foreignColumns: [runs.id, runs.workspaceId],
  });

export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    runOf(t.runId, t.workspaceId, "run_events_run_fk"),
    unique("run_events_run_seq_unique").on(t.runId, t.seq),
    index("run_events_run_seq_idx").on(t.runId, t.seq),
    check("run_events_seq_positive", sql`${t.seq} > 0`),
    check("run_events_type_known", sql`${t.type} in (${runEventTypeList})`),
    ...tenantPolicies("run_events", t.workspaceId, {
      select: readers,
      insert: operators,
    }),
  ],
).enableRLS();

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    runOf(t.runId, t.workspaceId, "artifacts_run_fk"),
    index("artifacts_run_idx").on(t.runId),
    check("artifacts_version_positive", sql`${t.version} > 0`),
    ...tenantPolicies("artifacts", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
    }),
  ],
).enableRLS();

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    stepId: text("step_id").notNull(),
    action: jsonb("action").$type<unknown>().notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    runOf(t.runId, t.workspaceId, "approvals_run_fk"),
    index("approvals_run_idx").on(t.runId),
    index("approvals_workspace_status_idx").on(t.workspaceId, t.status),
    check(
      "approvals_resolution_consistent",
      sql`(${t.status} = 'pending') = (${t.resolvedAt} is null)`,
    ),
    ...tenantPolicies("approvals", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
    }),
  ],
).enableRLS();
