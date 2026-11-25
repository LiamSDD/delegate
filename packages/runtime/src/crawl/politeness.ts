import { type HostGate, type HostOutcome, type HostRelease } from "../tools/fetch";

export const POLITENESS_DEFAULTS = {
  perHost: 6,
  minIntervalMs: 100,
  maxBackoffMs: 60_000,
  baseBackoffMs: 2_000,
  slowLatencyFactor: 4,
  slowLatencyFloorMs: 1_500,
  errorRateLimit: 0.25,
} as const;

export interface PolitenessOptions {
  perHost?: number;
  minIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HostStats {
  host: string;
  active: number;
  limit: number;
  maxConcurrent: number;
  peakActive: number;
  requests: number;
  failures: number;
  rateLimited: number;
  intervalMs: number;
  crawlDelayMs?: number;
  backoffMs: number;
  avgLatencyMs: number;
  requestsPerSecond: number;
}

interface HostState {
  active: number;
  peakActive: number;
  limit: number;
  max: number;
  intervalMs: number;
  crawlDelayMs?: number;
  nextStartAt: number;
  backoffUntil: number;
  strikes: number;
  healthy: number;
  latencyEwma?: number;
  baselineLatency?: number;
  errorEwma: number;
  lastDecreaseAt: number;
  requests: number;
  failures: number;
  rateLimited: number;
  firstStartAt?: number;
  lastEndAt?: number;
  waiters: (() => void)[];
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HostPoliteness implements HostGate {
  readonly perHost: number;
  private readonly minIntervalMs: number;
  private readonly maxBackoffMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: PolitenessOptions = {}) {
    this.perHost = Math.max(1, Math.floor(options.perHost ?? POLITENESS_DEFAULTS.perHost));
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? POLITENESS_DEFAULTS.minIntervalMs);
    this.maxBackoffMs = options.maxBackoffMs ?? POLITENESS_DEFAULTS.maxBackoffMs;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
  }

  private state(host: string): HostState {
    const key = host.toLowerCase();
    let state = this.hosts.get(key);
    if (state === undefined) {
      state = {
        active: 0,
        peakActive: 0,
        limit: this.perHost,
        max: this.perHost,
        intervalMs: this.minIntervalMs,
        nextStartAt: 0,
        backoffUntil: 0,
        strikes: 0,
        healthy: 0,
        errorEwma: 0,
        lastDecreaseAt: Number.NEGATIVE_INFINITY,
        requests: 0,
        failures: 0,
        rateLimited: 0,
        waiters: [],
      };
      this.hosts.set(key, state);
    }
    return state;
  }

  capacity(host: string): number {
    const state = this.state(host);
    return Math.max(0, state.limit - state.active);
  }

  limit(host: string): number {
    return this.state(host).limit;
  }

  readyIn(host: string): number {
    const state = this.state(host);
    return Math.max(0, Math.max(state.nextStartAt, state.backoffUntil) - this.now());
  }

  setCrawlDelay(host: string, delayMs: number): void {
    const state = this.state(host);
    state.crawlDelayMs = delayMs;
    state.max = 1;
    state.limit = 1;
    state.intervalMs = Math.max(this.minIntervalMs, delayMs);
  }

  async acquire(host: string, signal?: AbortSignal): Promise<HostRelease> {
    const state = this.state(host);
    const aborted = () => signal?.aborted === true;
    for (;;) {
      if (aborted()) throw new Error("aborted");
      const at = this.now();
      const startAt = Math.max(at, state.nextStartAt, state.backoffUntil);
      state.nextStartAt = startAt + state.intervalMs;
      if (startAt > at) await this.sleep(startAt - at);
      if (aborted()) throw new Error("aborted");
      if (state.active < state.limit) return this.start(state);
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
  }

  backoffIn(host: string): number {
    return Math.max(0, this.state(host).backoffUntil - this.now());
  }

  private start(state: HostState): HostRelease {
    const at = this.now();
    state.active += 1;
    state.peakActive = Math.max(state.peakActive, state.active);
    state.requests += 1;
    state.firstStartAt ??= at;
    let released = false;
    return (outcome) => {
      if (released) return;
      released = true;
      this.finish(state, outcome);
    };
  }

  private finish(state: HostState, outcome: HostOutcome): void {
    const at = this.now();
    state.active -= 1;
    state.lastEndAt = at;
    const rateLimited = outcome.status === 429 || outcome.status === 503;
    const failed = outcome.failed === true || rateLimited;
    if (failed) state.failures += 1;
    state.errorEwma = state.errorEwma * 0.8 + (failed ? 0.2 : 0);
    if (!failed) {
      state.latencyEwma =
        state.latencyEwma === undefined
          ? outcome.latencyMs
          : state.latencyEwma * 0.7 + outcome.latencyMs * 0.3;
      state.baselineLatency = Math.min(
        state.baselineLatency ?? outcome.latencyMs,
        Math.max(1, outcome.latencyMs),
      );
    }
    if (rateLimited) {
      state.rateLimited += 1;
      state.strikes += 1;
      const backoff =
        outcome.retryAfterMs ??
        Math.min(
          this.maxBackoffMs,
          POLITENESS_DEFAULTS.baseBackoffMs * 2 ** Math.min(5, state.strikes - 1),
        );
      state.backoffUntil = Math.max(state.backoffUntil, at + backoff);
      this.decrease(state, at, true);
    } else if (this.struggling(state)) {
      this.decrease(state, at, false);
    } else if (!failed) {
      state.strikes = 0;
      state.healthy += 1;
      if (state.limit < state.max && state.healthy >= state.limit * 2) {
        state.limit += 1;
        state.healthy = 0;
      }
    }
    const waiters = state.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  private struggling(state: HostState): boolean {
    if (state.errorEwma > POLITENESS_DEFAULTS.errorRateLimit) return true;
    if (state.latencyEwma === undefined || state.baselineLatency === undefined) return false;
    const slow = Math.max(
      POLITENESS_DEFAULTS.slowLatencyFloorMs,
      state.baselineLatency * POLITENESS_DEFAULTS.slowLatencyFactor,
    );
    return state.latencyEwma > slow;
  }

  private decrease(state: HostState, at: number, force: boolean): void {
    state.healthy = 0;
    const cooldown = state.latencyEwma ?? 1_000;
    if (!force && at - state.lastDecreaseAt < cooldown) return;
    state.lastDecreaseAt = at;
    state.limit = Math.max(1, Math.floor(state.limit / 2));
  }

  stats(): HostStats[] {
    return [...this.hosts.entries()].map(([host, state]) => {
      const span =
        state.firstStartAt === undefined
          ? 0
          : Math.max(1, (state.lastEndAt ?? this.now()) - state.firstStartAt);
      return {
        host,
        active: state.active,
        limit: state.limit,
        maxConcurrent: state.max,
        peakActive: state.peakActive,
        requests: state.requests,
        failures: state.failures,
        rateLimited: state.rateLimited,
        intervalMs: state.intervalMs,
        ...(state.crawlDelayMs === undefined ? {} : { crawlDelayMs: state.crawlDelayMs }),
        backoffMs: Math.max(0, state.backoffUntil - this.now()),
        avgLatencyMs: Math.round(state.latencyEwma ?? 0),
        requestsPerSecond: span === 0 ? 0 : Math.round((state.requests / span) * 10_000) / 10,
      };
    });
  }
}
