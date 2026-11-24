import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { auditActorType, auditDecision } from "./enums";
import { admins, readers, tenantPolicies } from "./rls";
import { approvals } from "./runs";
import { workspaces } from "./tenancy";

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    definition: jsonb("definition").$type<unknown>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("policies_workspace_name_version_unique").on(t.workspaceId, t.name, t.version),
    check("policies_version_positive", sql`${t.version} > 0`),
    ...tenantPolicies("policies", t.workspaceId, {
      select: readers,
      insert: admins,
      update: admins,
      delete: admins,
    }),
  ],
).enableRLS();

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: auditActorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    target: text("target"),
    decision: auditDecision("decision").notNull(),
    policyId: uuid("policy_id").references(() => policies.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    details: jsonb("details").$type<unknown>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt),
    check("audit_log_actor_identified", sql`${t.actorType} = 'system' or ${t.actorId} is not null`),
    ...tenantPolicies("audit_log", t.workspaceId, {
      select: readers,
      insert: readers,
    }),
  ],
).enableRLS();
