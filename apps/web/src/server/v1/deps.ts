import { assistantStores } from "../assistants";
import { chatDeps } from "../chat-deps";
import { apiDeps } from "../deps";
import type { V1Deps } from "./handlers";
import { v1RequestLimiter } from "./rate-limit";

export function v1Deps(): V1Deps {
  const chat = chatDeps();
  return {
    api: apiDeps(),
    limiter: v1RequestLimiter(),
    chat: { limiter: chat.guestLimiter, answer: chat.answer, stores: assistantStores },
  };
}
