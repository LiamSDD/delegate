import {
  artifacts,
  createDbKnowledgeStore,
  runs,
  type TenantScope,
  withTenant,
} from "@delegate/db";
import {
  type AssistantStore,
  createMemoryAssistantStore,
  createMemoryKnowledgeStore,
  type KnowledgeStore,
} from "@delegate/runtime/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ASSISTANT_EVALS_KIND,
  ASSISTANT_KIND,
  type AssistantArtifact,
  AssistantArtifactSchema,
  type AssistantEvals,
  AssistantEvalsSchema,
  GAPS_REPORT_KIND,
  type GapsReport,
  GapsReportSchema,
} from "@/lib/m3-contract";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export interface AssistantStores {
  knowledge: KnowledgeStore;
  assistants: AssistantStore;
}

const holder = globalThis as typeof globalThis & { __delegateAssistantStores?: AssistantStores };

export function assistantStores(): AssistantStores {
  holder.__delegateAssistantStores ??= {
    knowledge: createMemoryKnowledgeStore(),
    assistants: createMemoryAssistantStore(),
  };
  return holder.__delegateAssistantStores;
}

export function workspaceKnowledge(
  app: () => Promise<AppDatabase>,
  scope: TenantScope,
): KnowledgeStore {
  const store = () => app().then((database) => createDbKnowledgeStore(database.db, scope));
  return {
    getPage: (collection, url) => store().then((knowledge) => knowledge.getPage(collection, url)),
    putPage: (page) => store().then((knowledge) => knowledge.putPage(page)),
    listChunks: (collection) => store().then((knowledge) => knowledge.listChunks(collection)),
    setEmbeddings: (entries) => store().then((knowledge) => knowledge.setEmbeddings(entries)),
    searchFullText: (params) => store().then((knowledge) => knowledge.searchFullText(params)),
    searchVector: (params) => store().then((knowledge) => knowledge.searchVector(params)),
  };
}

export function mirroredKnowledge(primary: KnowledgeStore, mirror: KnowledgeStore): KnowledgeStore {
  return {
    getPage: (collection, url) => primary.getPage(collection, url),
    putPage: async (page) => {
      const stored = await primary.putPage(page);
      await mirror.putPage(page).catch(() => undefined);
      return stored;
    },
    listChunks: (collection) => primary.listChunks(collection),
    setEmbeddings: (entries) => primary.setEmbeddings(entries),
    searchFullText: (params) => primary.searchFullText(params),
    searchVector: (params) => primary.searchVector(params),
  };
}

export interface AssistantView {
  assistant: AssistantArtifact;
  workspaceId: string;
  evals: AssistantEvals | null;
  gaps: GapsReport | null;
  runId: string;
  runStatus: string;
  createdAt: string;
}

export interface AssistantListItem {
  id: string;
  name: string;
  url: string;
  status: AssistantArtifact["status"];
  passRate: number | null;
  pages: number;
  runId: string;
  createdAt: string;
}

const idSchema = z.uuid();

export async function findAssistant(
  app: AppDatabase,
  userId: string,
  assistantId: string,
): Promise<AssistantView | null> {
  if (!idSchema.safeParse(assistantId).success) return null;
  return withTenant(app.db, userId, async (tx) => {
    const [row] = await tx
      .select({
        runId: artifacts.runId,
        workspaceId: artifacts.workspaceId,
        content: artifacts.content,
        createdAt: artifacts.createdAt,
        runStatus: runs.status,
      })
      .from(artifacts)
      .innerJoin(runs, eq(runs.id, artifacts.runId))
      .where(
        and(eq(artifacts.kind, ASSISTANT_KIND), sql`${artifacts.content}->>'id' = ${assistantId}`),
      )
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    if (row === undefined) return null;
    const assistant = AssistantArtifactSchema.safeParse(row.content);
    if (!assistant.success) return null;
    const siblings = await tx
      .select({ kind: artifacts.kind, content: artifacts.content })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.runId, row.runId),
          inArray(artifacts.kind, [ASSISTANT_EVALS_KIND, GAPS_REPORT_KIND]),
        ),
      );
    const evals = siblings
      .filter((entry) => entry.kind === ASSISTANT_EVALS_KIND)
      .map((entry) => AssistantEvalsSchema.safeParse(entry.content))
      .find((parsed) => parsed.success)?.data;
    const gaps = siblings
      .filter((entry) => entry.kind === GAPS_REPORT_KIND)
      .map((entry) => GapsReportSchema.safeParse(entry.content))
      .find((parsed) => parsed.success)?.data;
    return {
      assistant: assistant.data,
      workspaceId: row.workspaceId,
      evals: evals ?? null,
      gaps: gaps ?? null,
      runId: row.runId,
      runStatus: row.runStatus,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function listAssistants(
  app: AppDatabase,
  session: GuestSession,
  limit = 50,
): Promise<AssistantListItem[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        runId: artifacts.runId,
        content: artifacts.content,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(
        and(eq(artifacts.workspaceId, session.workspaceId), eq(artifacts.kind, ASSISTANT_KIND)),
      )
      .orderBy(desc(artifacts.createdAt))
      .limit(limit),
  );
  return rows.flatMap((row) => {
    const parsed = AssistantArtifactSchema.safeParse(row.content);
    if (!parsed.success) return [];
    const assistant = parsed.data;
    return [
      {
        id: assistant.id,
        name: assistant.name,
        url: assistant.url,
        status: assistant.status,
        passRate: assistant.passRate ?? null,
        pages: assistant.corpusStats.pages,
        runId: row.runId,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}

export async function ensureLoaded(stores: AssistantStores, view: AssistantView): Promise<void> {
  if ((await stores.assistants.get(view.assistant.id)) !== null) return;
  await stores.assistants.save({
    id: view.assistant.id,
    runId: view.runId,
    name: view.assistant.name,
    collection: view.assistant.collection,
    config: view.assistant,
    ...(view.evals === null ? {} : { evals: view.evals }),
    ...(view.gaps === null ? {} : { gaps: view.gaps }),
  });
}
