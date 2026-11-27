import modelsConfig from "@config/models.json";
import { answerQuestion } from "@delegate/runtime/server";

import { isOwnerModeEnabled } from "@/flags";

import { readCookie } from "./api";
import { assistantStores, ensureLoaded, findAssistant, workspaceKnowledge } from "./assistants";
import type { ChatDeps } from "./chat";
import { getAppDatabase } from "./db";
import { loadRepoPrompts } from "./runtime-runner";
import {
  createRateLimiter,
  type RateLimiter,
  readGuest,
  SESSION_COOKIE,
  sessionSecret,
} from "./session";
import { OWNER_QUESTIONS_PER_HOUR, PUBLIC_QUESTIONS_PER_HOUR } from "./chat";

const holder = globalThis as typeof globalThis & {
  __delegateChatLimiters?: { public: RateLimiter; guest: RateLimiter };
};

function limiters() {
  holder.__delegateChatLimiters ??= {
    public: createRateLimiter({ limit: PUBLIC_QUESTIONS_PER_HOUR, windowMs: 3_600_000 }),
    guest: createRateLimiter({ limit: OWNER_QUESTIONS_PER_HOUR, windowMs: 3_600_000 }),
  };
  return holder.__delegateChatLimiters;
}

let prompts: ReturnType<typeof loadRepoPrompts> | undefined;

export function chatDeps(): ChatDeps {
  const stores = assistantStores();
  const env = process.env;
  return {
    publicLimiter: limiters().public,
    guestLimiter: limiters().guest,
    exists: async (id) => (await stores.assistants.get(id)) !== null,
    guest: async (request, assistantId) => {
      const app = await getAppDatabase();
      const session = await readGuest(app, readCookie(request, SESSION_COOKIE), sessionSecret());
      if (session === null) return null;
      const view = await findAssistant(app, session.userId, assistantId);
      if (view === null) return null;
      await ensureLoaded(stores, view);
      return {
        key: session.userId,
        scope: { userId: session.userId, workspaceId: view.workspaceId },
      };
    },
    answer: ({ assistantId, question, history, signal, scope }) => {
      prompts ??= loadRepoPrompts();
      return answerQuestion({
        assistantId,
        question,
        history,
        signal,
        env,
        audience: isOwnerModeEnabled(env) ? "owner" : "public-demo",
        assistants: stores.assistants,
        knowledge:
          scope === undefined ? stores.knowledge : workspaceKnowledge(getAppDatabase, scope),
        modelsConfig,
        prompts,
        latency: "interactive",
      });
    },
  };
}
