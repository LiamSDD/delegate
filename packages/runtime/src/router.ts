import { type FallbackReason, type ModelFallbackPayload, type ModelRole } from "./events";
import {
  resolveChain,
  type ChainContext,
  type ChainEntry,
  type DataClassification,
  type Env,
} from "./models";
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
  classification?: DataClassification;
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
  blocked: boolean;
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

const CLIENT_ERROR_STATUSES = new Set([401, 402, 403, 408, 422]);
const CONTEXT_ERROR_PATTERN = /context|length|token/i;
const REASONS_WITHOUT_HEALTH_PENALTY = new Set<FallbackReason>([
  "client_error",
  "model_unavailable",
  "context_too_small",
]);

function classifyHttp(error: ProviderHttpError): Rejection | undefined {
  if (error.status >= 500) return { reason: "server_error" };
  if (error.status === 404) return { reason: "model_unavailable" };
  if (error.status === 413) return { reason: "context_too_small" };
  if (CLIENT_ERROR_STATUSES.has(error.status)) return { reason: "client_error" };
  if (error.status === 400 && CONTEXT_ERROR_PATTERN.test(error.bodySnippet))
    return { reason: "context_too_small" };
  return undefined;
}

function classify(error: unknown): Rejection | undefined {
  if (error instanceof RateLimitedError) {
    return error.retryAfterMs === undefined
      ? { reason: "rate_limited" }
      : { reason: "rate_limited", retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof ProviderHttpError) return classifyHttp(error);
  if (error instanceof ProviderTimeoutError) return { reason: "timeout" };
  if (error instanceof ProviderNetworkError) return { reason: "network_error" };
  return undefined;
}

function isInBandError(event: ModelStreamEvent): boolean {
  return event.type === "stop" && event.reason === "error";
}

function outputCharacters(event: ModelStreamEvent): number {
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta":
      return event.text.length;
    case "tool_call_complete":
      return event.call.name.length + event.call.argumentsJson.length;
    default:
      return 0;
  }
}

class RoutedEvents implements AsyncIterableIterator<ModelStreamEvent> {
  private readonly queue: ModelStreamEvent[];
  private closed = false;
  private released = false;
  private sawUsage = false;
  private outputChars = 0;

  constructor(
    private readonly source: AsyncIterator<ModelStreamEvent>,
    first: ModelStreamEvent,
    private readonly promptTokens: number,
    private readonly onFailure: (rejection: Rejection) => void,
  ) {
    this.queue = this.observe(first);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ModelStreamEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<ModelStreamEvent>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return { done: false, value: queued };
    if (this.closed) return { done: true, value: undefined };
    let result: IteratorResult<ModelStreamEvent>;
    try {
      result = await this.source.next();
    } catch (error) {
      this.closed = true;
      this.released = true;
      const rejection = classify(error);
      if (rejection !== undefined) this.onFailure(rejection);
      throw error;
    }
    if (result.done === true) {
      this.closed = true;
      this.released = true;
      return { done: true, value: undefined };
    }
    this.queue.push(...this.observe(result.value));
    return this.next();
  }

  async return(): Promise<IteratorResult<ModelStreamEvent>> {
    this.closed = true;
    this.queue.length = 0;
    await this.release();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<ModelStreamEvent>> {
    await this.return();
    throw error;
  }

  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.source.return?.();
  }

  private observe(event: ModelStreamEvent): ModelStreamEvent[] {
    this.outputChars += outputCharacters(event);
    if (event.type === "usage") this.sawUsage = true;
    if (event.type !== "stop") return [event];
    if (isInBandError(event)) this.onFailure({ reason: "server_error" });
    if (this.sawUsage) return [event];
    this.sawUsage = true;
    return [
      {
        type: "usage",
        estimated: true,
        usage: {
          inputTokens: this.promptTokens,
          outputTokens: Math.ceil(this.outputChars / 4),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      event,
    ];
  }
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
    if (state === undefined) return { healthy: true, blocked: false, consecutiveFailures: 0 };
    const now = this.now();
    const blocked = state.blockedUntil > now;
    return {
      healthy: state.unhealthyUntil <= now && !blocked,
      blocked,
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
    const chain = resolveChain(role, this.options.env, {
      ...this.options.context,
      classification: options.classification ?? this.options.context.classification,
    });
    const promptTokens = options.estimatedPromptTokens ?? estimatePromptTokens(request);
    const attempts: RouteAttempt[] = [];

    for (const [index, entry] of chain.entries()) {
      let rejection = this.precheck(entry, request, promptTokens);
      if (rejection === undefined) {
        let outcome: RoutedStream | Rejection;
        try {
          outcome = await this.attempt(entry, request, options, promptTokens);
        } catch (error) {
          const classified = classify(error);
          if (classified === undefined) throw error;
          outcome = classified;
        }
        if ("events" in outcome) return outcome;
        rejection = outcome;
        this.recordFailure(entry.provider.id, rejection);
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
    if (requestWait === undefined || tokenWait === undefined)
      return { reason: "exceeds_provider_capacity" };
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
    promptTokens: number,
  ): Promise<RoutedStream | Rejection> {
    const streamOptions: StreamOptions =
      options.signal === undefined ? {} : { signal: options.signal };
    const stream = this.provider(entry).stream(
      { ...request, model: entry.model, quirks: entry.quirks },
      streamOptions,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true || isInBandError(first.value)) {
      if (first.done !== true) await iterator.return?.();
      return { reason: "server_error" };
    }
    this.recordSuccess(entry.provider.id);

    const events = new RoutedEvents(iterator, first.value, promptTokens, (rejection) => {
      this.recordFailure(entry.provider.id, rejection);
    });
    return { provider: entry.provider.id, model: entry.model, entry, events };
  }

  private recordSuccess(providerId: string): void {
    const state = this.states.get(providerId);
    if (state !== undefined) state.consecutiveFailures = 0;
  }

  private recordFailure(providerId: string, rejection: Rejection): void {
    const state = this.states.get(providerId);
    if (state === undefined || REASONS_WITHOUT_HEALTH_PENALTY.has(rejection.reason)) return;
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
