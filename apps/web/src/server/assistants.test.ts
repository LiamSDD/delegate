import { createMemoryKnowledgeStore, type RunMissionOptions } from "@delegate/runtime/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workspaceKnowledge } from "./assistants";
import { type ChatDeps, handleAssistantChat } from "./chat";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createRuntimeRunner, loadRepoPrompts } from "./runtime-runner";
import { createRateLimiter, resolveGuest } from "./session";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const page = (collection: string) => ({
  collection,
  url: "https://docs.acme.test/rls",
  title: "Row Level Security",
  contentHash: "h1",
  fetchedAt: "2026-11-27T10:00:00.000Z",
  bytes: 120,
  links: [],
  chunks: [
    {
      ordinal: 0,
      heading: "Enable RLS",
      text: "To turn on Row Level Security for a table, run alter table enable row level security.",
      tokenCount: 18,
      flagged: false,
    },
  ],
});

describe("assistant knowledge across server instances", () => {
  it("finds chunks indexed by one instance from a fresh store in another, scoped to the workspace", async () => {
    const { session } = await resolveGuest(app, undefined, "s".repeat(32));
    const scope = { userId: session.userId, workspaceId: session.workspaceId };
    const collection = "build-agent:6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10";
    await workspaceKnowledge(() => Promise.resolve(app), scope).putPage(page(collection));

    const otherInstance = workspaceKnowledge(() => Promise.resolve(app), scope);
    const hits = await otherInstance.searchFullText({
      collection,
      query: "How do I turn on Row Level Security for a table?",
      limit: 5,
    });
    expect(hits.map((hit) => hit.url)).toEqual(["https://docs.acme.test/rls"]);
    const memory = createMemoryKnowledgeStore();
    expect(await memory.listChunks(collection)).toEqual([]);

    const stranger = await resolveGuest(app, undefined, "s".repeat(32));
    const theirs = workspaceKnowledge(() => Promise.resolve(app), {
      userId: stranger.session.userId,
      workspaceId: stranger.session.workspaceId,
    });
    expect(await theirs.listChunks(collection)).toEqual([]);
  });

  it("gives missions a workspace-scoped knowledge store instead of the process memory", async () => {
    const calls: RunMissionOptions[] = [];
    const knowledge = createMemoryKnowledgeStore();
    const scopes: unknown[] = [];
    const runner = createRuntimeRunner({
      env: { NODE_ENV: "production" },
      loadPrompts: loadRepoPrompts,
      knowledge: (scope) => {
        scopes.push(scope);
        return knowledge;
      },
      runMission: (options) => {
        calls.push(options);
        return Promise.resolve({ status: "completed" });
      },
    });
    await runner({
      runId: "run-1",
      missionId: "build-agent",
      input: { url: "https://docs.acme.test/" },
      emit: () => Promise.resolve(),
      signal: new AbortController().signal,
      awaitPlanApproval: () => Promise.resolve({ decision: "approved" }),
      planApprover: { type: "guest", id: "g-1" },
      scope: { workspaceId: "w-1", userId: "u-1" },
    });
    expect(scopes).toEqual([{ workspaceId: "w-1", userId: "u-1" }]);
    expect(calls[0]?.knowledge).toBe(knowledge);
  });

  it("answers owner questions from the assistant's workspace", async () => {
    const asked: unknown[] = [];
    const scope = { userId: "u-1", workspaceId: "w-1" };
    const deps: ChatDeps = {
      publicLimiter: createRateLimiter({ limit: 5, windowMs: 3_600_000 }),
      guestLimiter: createRateLimiter({ limit: 5, windowMs: 3_600_000 }),
      exists: () => Promise.resolve(false),
      guest: () => Promise.resolve({ key: "u-1", scope }),
      answer: async function* (options) {
        asked.push(options.scope);
        await Promise.resolve();
        yield { type: "delta", text: "ok" };
      },
    };
    for (const mode of ["owner", "public"] as const) {
      const response = await handleAssistantChat(
        new Request("http://localhost:3000/api/agents/x/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
            host: "localhost:3000",
          },
          body: JSON.stringify({ question: "How do I enable RLS?" }),
        }),
        "6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10",
        mode,
        deps,
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(asked).toEqual([scope, scope]);
  });
});
