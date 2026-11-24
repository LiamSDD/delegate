import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { memberRole, userKind } from "./enums";
import { admins, appRole, currentUserId, hasWorkspaceRole, readers } from "./rls";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").unique(),
    displayName: text("display_name").notNull(),
    kind: userKind("kind").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy("users_select", {
      for: "select",
      to: appRole,
      using: sql`${t.id} = ${currentUserId} or app_shares_workspace(${t.id})`,
    }),
    pgPolicy("users_update_self", {
      for: "update",
      to: appRole,
      using: sql`${t.id} = ${currentUserId}`,
      withCheck: sql`${t.id} = ${currentUserId}`,
    }),
  ],
).enableRLS();

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy("orgs_select", {
      for: "select",
      to: appRole,
      using: sql`app_is_org_member(${t.id})`,
    }),
  ],
).enableRLS();

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDemo: boolean("is_demo").notNull().default(false),
    retentionDays: integer("retention_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workspaces_org_slug_unique").on(t.orgId, t.slug),
    check(
      "workspaces_retention_days_positive",
      sql`${t.retentionDays} is null or ${t.retentionDays} > 0`,
    ),
    pgPolicy("workspaces_select", {
      for: "select",
      to: appRole,
      using: hasWorkspaceRole(t.id, readers),
    }),
    pgPolicy("workspaces_update", {
      for: "update",
      to: appRole,
      using: hasWorkspaceRole(t.id, admins),
      withCheck: hasWorkspaceRole(t.id, admins),
    }),
  ],
).enableRLS();

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => {
    const ownerRowsNeedOwner = sql`(${t.role} <> 'owner' or app_workspace_role(${t.workspaceId}) = 'owner')`;
    const manages = sql`${hasWorkspaceRole(t.workspaceId, admins)} and ${ownerRowsNeedOwner}`;
    return [
      unique("members_workspace_user_unique").on(t.workspaceId, t.userId),
      index("members_user_idx").on(t.userId),
      pgPolicy("members_select", {
        for: "select",
        to: appRole,
        using: hasWorkspaceRole(t.workspaceId, readers),
      }),
      pgPolicy("members_insert", {
        for: "insert",
        to: appRole,
        withCheck: manages,
      }),
      pgPolicy("members_update", {
        for: "update",
        to: appRole,
        using: manages,
        withCheck: manages,
      }),
      pgPolicy("members_delete", {
        for: "delete",
        to: appRole,
        using: manages,
      }),
    ];
  },
).enableRLS();
