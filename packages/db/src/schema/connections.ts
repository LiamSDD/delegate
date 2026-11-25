import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { admins, currentUserId, definerPolicies, readers, tenantPolicies } from "./rls";
import { users, workspaces } from "./tenancy";

export interface StoredConnectorTool {
  name: string;
  description: string;
  readOnly: boolean;
  withheld: boolean;
  inputSchema: Record<string, unknown>;
}

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .default(currentUserId)
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull().unique(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("api_tokens_workspace_idx").on(t.workspaceId, t.createdAt),
    check("api_tokens_name_length", sql`char_length(${t.name}) between 1 and 80`),
    check("api_tokens_prefix_format", sql`${t.prefix} ~ '^dlg_[A-Za-z0-9_-]{8}$'`),
    check("api_tokens_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    ...tenantPolicies(
      "api_tokens",
      t.workspaceId,
      { select: admins, insert: admins, update: admins },
      sql`${t.createdBy} = ${currentUserId}`,
    ),
    ...definerPolicies("api_tokens", ["select", "update"]),
  ],
).enableRLS();

export const mcpConnectors = pgTable(
  "mcp_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .default(currentUserId)
      .references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    authHeaderName: text("auth_header_name"),
    secretCiphertext: text("secret_ciphertext"),
    tools: jsonb("tools").$type<StoredConnectorTool[]>().notNull().default([]),
    toolsRefreshedAt: timestamp("tools_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mcp_connectors_workspace_name_unique").on(t.workspaceId, t.name),
    check("mcp_connectors_name_format", sql`${t.name} ~ '^[a-z0-9][a-z0-9-]{0,31}$'`),
    check(
      "mcp_connectors_secret_needs_header",
      sql`${t.secretCiphertext} is null or ${t.authHeaderName} is not null`,
    ),
    ...tenantPolicies("mcp_connectors", t.workspaceId, {
      select: readers,
      insert: admins,
      update: admins,
      delete: admins,
    }),
  ],
).enableRLS();

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull(),
    repositories: jsonb("repositories").$type<string[]>().notNull().default([]),
    repositoriesVerified: boolean("repositories_verified").notNull().default(false),
    githubUserId: bigint("github_user_id", { mode: "number" }),
    githubLogin: text("github_login"),
    connectedBy: uuid("connected_by")
      .default(currentUserId)
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("github_installations_workspace_installation_unique").on(
      t.workspaceId,
      t.installationId,
    ),
    check(
      "github_installations_selection_known",
      sql`${t.repositorySelection} in ('all', 'selected')`,
    ),
    check("github_installations_id_positive", sql`${t.installationId} > 0`),
    check(
      "github_installations_login_format",
      sql`${t.githubLogin} is null or ${t.githubLogin} ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'`,
    ),
    ...tenantPolicies("github_installations", t.workspaceId, {
      select: readers,
      insert: admins,
      update: admins,
      delete: admins,
    }),
  ],
).enableRLS();

export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    autoApprovePlans: boolean("auto_approve_plans").notNull().default(false),
    preapprovedTools: jsonb("preapproved_tools").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspace_settings_preapproved_is_array",
      sql`jsonb_typeof(${t.preapprovedTools}) = 'array'`,
    ),
    ...tenantPolicies("workspace_settings", t.workspaceId, {
      select: readers,
      insert: admins,
      update: admins,
    }),
  ],
).enableRLS();
