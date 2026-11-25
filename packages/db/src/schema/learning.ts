import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  appRole,
  currentUserId,
  definerPolicies,
  hasWorkspaceRole,
  operators,
  readers,
} from "./rls";
import { users, workspaces } from "./tenancy";

export const playbooks = pgTable(
  "playbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    runs: integer("runs").notNull().default(0),
    content: jsonb("content").$type<unknown>().notNull(),
    createdBy: uuid("created_by")
      .default(currentUserId)
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("playbooks_scope_known", sql`${t.scope} in ('workspace', 'house')`),
    check(
      "playbooks_house_has_no_workspace",
      sql`(${t.scope} = 'house') = (${t.workspaceId} is null)`,
    ),
    check("playbooks_version_positive", sql`${t.version} > 0`),
    check("playbooks_runs_nonnegative", sql`${t.runs} >= 0`),
    unique("playbooks_workspace_key_version_unique")
      .on(t.workspaceId, t.key, t.version)
      .nullsNotDistinct(),
    index("playbooks_lookup_idx").on(t.workspaceId, t.key, t.version),
    pgPolicy("playbooks_select", {
      for: "select",
      to: appRole,
      using: sql`${t.workspaceId} is null or ${hasWorkspaceRole(t.workspaceId, readers)}`,
    }),
    pgPolicy("playbooks_insert", {
      for: "insert",
      to: appRole,
      withCheck: sql`${t.workspaceId} is not null and ${t.scope} = 'workspace' and ${hasWorkspaceRole(t.workspaceId, operators)}`,
    }),
    ...definerPolicies("playbooks", ["select", "insert"]),
  ],
).enableRLS();
