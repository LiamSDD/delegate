import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { documentClassification } from "./enums";
import { definerPolicies, operators, readers, tenantPolicies } from "./rls";
import { runs } from "./runs";
import { workspaces } from "./tenancy";

export const EMBEDDING_DIMENSIONS = 1024;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    createdByAgent: text("created_by_agent").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "memories_run_fk",
      columns: [t.runId, t.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
    }).onDelete("cascade"),
    unique("memories_scope_key_unique").on(t.workspaceId, t.runId, t.key).nullsNotDistinct(),
    ...tenantPolicies("memories", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
      delete: operators,
    }),
    ...definerPolicies("memories", ["select", "delete"]),
  ],
).enableRLS();

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url"),
    collection: text("collection"),
    title: text("title").notNull(),
    contentHash: text("content_hash").notNull(),
    classification: documentClassification("classification").notNull().default("internal"),
    metadata: jsonb("metadata").$type<unknown>().notNull().default({}),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("documents_id_workspace_unique").on(t.id, t.workspaceId),
    unique("documents_collection_url_unique").on(t.workspaceId, t.collection, t.sourceUrl),
    index("documents_workspace_hash_idx").on(t.workspaceId, t.contentHash),
    ...tenantPolicies("documents", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
      delete: operators,
    }),
    ...definerPolicies("documents", ["select", "delete"]),
  ],
).enableRLS();

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    heading: text("heading"),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    flagged: boolean("flagged").notNull().default(false),
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "chunks_document_fk",
      columns: [t.documentId, t.workspaceId],
      foreignColumns: [documents.id, documents.workspaceId],
    }).onDelete("cascade"),
    unique("chunks_document_ordinal_unique").on(t.documentId, t.ordinal),
    index("chunks_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("chunks_tsv_gin_idx").using("gin", t.tsv),
    ...tenantPolicies("chunks", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
      delete: operators,
    }),
  ],
).enableRLS();

export const assistants = pgTable(
  "assistants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    name: text("name").notNull(),
    collection: text("collection").notNull(),
    config: jsonb("config").$type<unknown>().notNull(),
    evals: jsonb("evals").$type<unknown>(),
    gaps: jsonb("gaps").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "assistants_run_fk",
      columns: [t.runId, t.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
    }).onDelete("cascade"),
    index("assistants_workspace_idx").on(t.workspaceId, t.createdAt),
    ...tenantPolicies("assistants", t.workspaceId, {
      select: readers,
      insert: operators,
      update: operators,
      delete: operators,
    }),
    ...definerPolicies("assistants", ["select", "delete"]),
  ],
).enableRLS();
