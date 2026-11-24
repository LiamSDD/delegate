import {
  ModelRouter,
  NoModelAvailableError,
  createServerProvider,
  loadModelsConfig,
  type ModelFallbackPayload,
} from "@delegate/runtime/server";

import { type JudgeCompleter } from "./xray-judge";

export const JUDGE_ROLE = "planner" as const;

export interface RouterCompleterOptions {
  env: Record<string, string | undefined>;
  audience: "public-demo" | "owner";
  sleep?: (ms: number) => Promise<void>;
  patienceMs?: number;
  onFallback?: (payload: ModelFallbackPayload) => void;
}

const BACKOFF_MS = 5_000;

export function createRouterCompleter(options: RouterCompleterOptions): JudgeCompleter {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const patience = options.patienceMs ?? 120_000;
  const router = new ModelRouter({
    env: options.env,
    context: {
      config: loadModelsConfig(),
      audience: options.audience,
      environment: "server",
      classification: "public",
    },
    createProvider: (entry) => createServerProvider(entry, options.env),
    emitFallback: (payload) => options.onFallback?.(payload),
  });
  return {
    async complete(request) {
      let waited = 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const routed = await router.open(
            JUDGE_ROLE,
            {
              system: request.system,
              messages: request.messages,
              maxTokens: request.maxTokens,
              temperature: 0,
            },
            { classification: "public" },
          );
          let text = "";
          for await (const event of routed.events) {
            if (event.type === "text_delta") text += event.text;
          }
          return { text, provider: routed.provider, model: routed.model };
        } catch (error) {
          if (!(error instanceof NoModelAvailableError)) throw error;
          const waits = error.attempts
            .filter((entry) => entry.reason === "rate_limited" || entry.reason === "unhealthy")
            .map((entry) => entry.retryAfterMs ?? BACKOFF_MS * 2 ** attempt);
          const wait = waits.length === 0 ? undefined : Math.min(...waits);
          if (wait === undefined || waited + wait > patience) throw error;
          await sleep(wait);
          waited += wait;
        }
      }
    },
  };
}
