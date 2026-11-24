import { type FallbackReason, type ModelFallbackPayload, type ModelRole } from "./events";
import { resolveChain, type ChainContext, type ChainEntry, type Env } from "./models";
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  RateLimitedError,
  toJsonSchema,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StreamOptions,
} from "./providers/types";

export type RouterRequest = Omit<ModelRequest, "model" | "quirks">;

export interface RouterOptions {
  env: Env;
  context: ChainContext;
  createProvider: (entry: ChainEntry) => ModelProvider;
  emitFallback: (payload: ModelFallbackPayload) => void;
  now?: () => number;
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface OpenOptions extends StreamOptions {
  estimatedPromptTokens?: number;
}

export interface RoutedStream {
  provider: string;
  model: string;
  entry: ChainEntry;
  events: AsyncIterable<ModelStreamEvent>;
}

export interface RouteAttempt {
  provider: string;
  model: string;
  reason: FallbackReason;
  retryAfterMs?: number;
}

export interface ProviderHealth {
  healthy: boolean;
  consecutiveFailures: number;
  unhealthyUntil?: number;
  blockedUntil?: number;
}

export class NoModelAvailableError extends Error {
  override readonly name = "NoModelAvailableError";
  constructor(
    readonly role: ModelRole,
    readonly attempts: RouteAttempt[],
  ) {
    super(
      attempts.length === 0
        ? `No model available for role ${role}`
        : `Every model for role ${role} failed: ${attempts.map((attempt) => `${attempt.provider}/${attempt.model} ${attempt.reason}`).join(", ")}`,
    );
  }
}

export function estimatePromptTokens(request: RouterRequest): number {
  let characters = request.system.length;
  for (const message of request.messages) {
    characters += message.content.length;
    if (message.role === "assistant") {
      characters += message.reasoning?.length ?? 0;
      for (const call of message.toolCalls ?? [])
        characters += call.name.length + call.argumentsJson.length;
    }
  }
  for (const tool of request.tools ?? []) {
    characters +=
      tool.name.length +
      tool.description.length +
      JSON.stringify(toJsonSchema(tool.inputSchema)).length;
  }
  if (request.responseFormat?.type === "json_schema") {
    characters += JSON.stringify(toJsonSchema(request.responseFormat.schema)).length;
  }
  return Math.ceil(characters / 4);
}

class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly perMinute: number,
    now: number,
  ) {
    this.tokens = perMinute;
    this.updatedAt = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.perMinute, this.tokens + (elapsed * this.perMinute) / 60_000);
    this.updatedAt = now;
  }

  waitMs(amount: number, now: number): number | undefined {
    this.refill(now);
    if (amount > this.perMinute) return undefined;
    if (this.tokens >= amount) return 0;
    return Math.ceil(((amount - this.tokens) * 60_000) / this.perMinute);
  }

  take(amount: number): void {
    this.tokens -= amount;
  }
}

interface ProviderState {
  consecutiveFailures: number;
  unhealthyUntil: number;
  blockedUntil: number;
  requests?: TokenBucket;
  tokens?: TokenBucket;
}

interface Rejection {
  reason: FallbackReason;
  retryAfterMs?: number;
}

function classify(error: unknown): Rejection | undefined {
  if (error instanceof RateLimitedError) {
    return error.retryAfterMs === undefined
      ? { reason: "rate_limited" }
      : { reason: "rate_limited", retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof ProviderHttpError && error.status >= 500) return { reason: "server_error" };
  if (error instanceof ProviderTimeoutError) return { reason: "timeout" };
  if (error instanceof ProviderNetworkError) return { reason: "network_error" };
  return undefined;
}

export class ModelRouter {
  private readonly states = new Map<string, ProviderState>();
  private readonly providers = new Map<string, ModelProvider>();
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(private readonly options: RouterOptions) {
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  health(providerId: string): ProviderHealth {
    const state = this.states.get(providerId);
    if (state === undefined) return { healthy: true, consecutiveFailures: 0 };
    const now = this.now();
    return {
      healthy: state.unhealthyUntil <= now,
      consecutiveFailures: state.consecutiveFailures,
      ...(state.unhealthyUntil > now ? { unhealthyUntil: state.unhealthyUntil } : {}),
      ...(state.blockedUntil > now ? { blockedUntil: state.blockedUntil } : {}),
    };
  }

  async open(
    role: ModelRole,
    request: RouterRequest,
    options: OpenOptions = {},
  ): Promise<RoutedStream> {
    const chain = resolveChain(role, this.options.env, this.options.context);
    const promptTokens = options.estimatedPromptTokens ?? estimatePromptTokens(request);
    const attempts: RouteAttempt[] = [];

    for (const [index, entry] of chain.entries()) {
      let rejection = this.precheck(entry, request, promptTokens);
      if (rejection === undefined) {
        try {
          return await this.attempt(entry, request, options);
        } catch (error) {
          rejection = classify(error);
          if (rejection === undefined) throw error;
          this.recordFailure(entry.provider.id, rejection);
        }
      }
      attempts.push({
        provider: entry.provider.id,
        model: entry.model,
        ...rejection,
      });
      const next = chain[index + 1];
      this.options.emitFallback({
        role,
        from: { provider: entry.provider.id, model: entry.model },
        to: next === undefined ? null : { provider: next.provider.id, model: next.model },
        ...rejection,
      });
    }
    throw new NoModelAvailableError(role, attempts);
  }

  private state(entry: ChainEntry): ProviderState {
    const existing = this.states.get(entry.provider.id);
    if (existing !== undefined) return existing;
    const now = this.now();
    const limits = entry.provider.limits;
    const created: ProviderState = {
      consecutiveFailures: 0,
      unhealthyUntil: 0,
      blockedUntil: 0,
      ...(limits?.requestsPerMinute === undefined
        ? {}
        : { requests: new TokenBucket(limits.requestsPerMinute, now) }),
      ...(limits?.tokensPerMinute === undefined
        ? {}
        : { tokens: new TokenBucket(limits.tokensPerMinute, now) }),
    };
    this.states.set(entry.provider.id, created);
    return created;
  }

  private precheck(
    entry: ChainEntry,
    request: RouterRequest,
    promptTokens: number,
  ): Rejection | undefined {
    if (promptTokens + request.maxTokens > entry.contextWindow)
      return { reason: "context_too_small" };
    if ((request.tools?.length ?? 0) > 0 && !entry.supportsTools)
      return { reason: "tools_unsupported" };

    const state = this.state(entry);
    const now = this.now();
    if (state.unhealthyUntil > now)
      return { reason: "unhealthy", retryAfterMs: state.unhealthyUntil - now };
    if (state.blockedUntil > now)
      return { reason: "rate_limited", retryAfterMs: state.blockedUntil - now };

    const tokenCost = promptTokens + request.maxTokens;
    const requestWait = state.requests === undefined ? 0 : state.requests.waitMs(1, now);
    const tokenWait = state.tokens === undefined ? 0 : state.tokens.waitMs(tokenCost, now);
    if (requestWait === undefined || tokenWait === undefined) return { reason: "rate_limited" };
    const wait = Math.max(requestWait, tokenWait);
    if (wait > 0) return { reason: "rate_limited", retryAfterMs: wait };
    state.requests?.take(1);
    state.tokens?.take(tokenCost);
    return undefined;
  }

  private provider(entry: ChainEntry): ModelProvider {
    const existing = this.providers.get(entry.provider.id);
    if (existing !== undefined) return existing;
    const created = this.options.createProvider(entry);
    this.providers.set(entry.provider.id, created);
    return created;
  }

  private async attempt(
    entry: ChainEntry,
    request: RouterRequest,
    options: StreamOptions,
  ): Promise<RoutedStream> {
    const streamOptions: StreamOptions =
      options.signal === undefined ? {} : { signal: options.signal };
    const stream = this.provider(entry).stream(
      { ...request, model: entry.model, quirks: entry.quirks },
      streamOptions,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    this.recordSuccess(entry.provider.id);

    const recordFailure = (rejection: Rejection) => {
      this.recordFailure(entry.provider.id, rejection);
    };
    async function* events(): AsyncGenerator<ModelStreamEvent> {
      if (first.done === true) return;
      yield first.value;
      try {
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
          yield next.value;
      } catch (error) {
        const rejection = classify(error);
        if (rejection !== undefined) recordFailure(rejection);
        throw error;
      } finally {
        await iterator.return?.();
      }
    }

    return { provider: entry.provider.id, model: entry.model, entry, events: events() };
  }

  private recordSuccess(providerId: string): void {
    const state = this.states.get(providerId);
    if (state !== undefined) state.consecutiveFailures = 0;
  }

  private recordFailure(providerId: string, rejection: Rejection): void {
    const state = this.states.get(providerId);
    if (state === undefined) return;
    const now = this.now();
    state.consecutiveFailures += 1;
    if (rejection.reason === "rate_limited" && rejection.retryAfterMs !== undefined) {
      state.blockedUntil = Math.max(state.blockedUntil, now + rejection.retryAfterMs);
    }
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.unhealthyUntil = now + this.cooldownMs;
      state.consecutiveFailures = 0;
    }
  }
}
