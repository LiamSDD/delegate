import { type Policy } from "@delegate/policy";

import { type Budget } from "../budget";
import { type ModelRole } from "../events";
import {
  resolveChain,
  type ChainEntry,
  type DataClassification,
  type Env,
  type LatencyMode,
  type ModelsConfig,
} from "../models";
import { type ModelProvider } from "../providers/types";
import { ModelRouter } from "../router";
import { type RunEmitter } from "./emitter";

export type Audience = "public-demo" | "owner";

export interface RunContext {
  runId: string;
  workspaceId: string;
  audience: Audience;
  classification: DataClassification;
  config: ModelsConfig;
  env: Env;
  router: ModelRouter;
  emitter: RunEmitter;
  budget: Budget;
  policies: Policy[];
  signal?: AbortSignal;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  nextId: (prefix: string) => string;
  attributeTo: (stepId: string | undefined) => void;
  gate: ProviderGate;
}

export interface ProviderGate {
  acquire(role: ModelRole): Promise<() => void>;
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.capacity) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    };
  }
}

export function createProviderGate(
  headOf: (role: ModelRole) => ChainEntry | undefined,
): ProviderGate {
  const semaphores = new Map<string, Semaphore>();
  return {
    acquire(role) {
      const head = headOf(role);
      const capacity = head?.provider.limits?.maxConcurrent;
      if (head === undefined || capacity === undefined) return Promise.resolve(() => undefined);
      let semaphore = semaphores.get(head.provider.id);
      if (semaphore === undefined) {
        semaphore = new Semaphore(capacity);
        semaphores.set(head.provider.id, semaphore);
      }
      return semaphore.acquire();
    },
  };
}

export interface RunContextOptions {
  runId: string;
  workspaceId: string;
  audience: Audience;
  classification: DataClassification;
  config: ModelsConfig;
  env: Env;
  emitter: RunEmitter;
  budget: Budget;
  policies: Policy[];
  createProvider: (entry: ChainEntry) => ModelProvider;
  environment?: "server" | "browser";
  localOptIn?: boolean;
  latency?: LatencyMode;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class RunAbortedError extends Error {
  override readonly name = "RunAbortedError";
  constructor() {
    super("The run was cancelled");
  }
}

export function abortableSleep(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new RunAbortedError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new RunAbortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export function createRunContext(options: RunContextOptions): RunContext {
  const now = options.now ?? (() => new Date());
  let attributedStep: string | undefined;
  const counters = new Map<string, number>();
  const routing = {
    config: options.config,
    audience: options.audience,
    environment: options.environment ?? "server",
    classification: options.classification,
    ...(options.localOptIn === undefined ? {} : { localOptIn: options.localOptIn }),
    ...(options.latency === undefined ? {} : { latency: options.latency }),
  } as const;
  const router = new ModelRouter({
    env: options.env,
    context: {
      config: options.config,
      audience: options.audience,
      environment: options.environment ?? "server",
      classification: options.classification,
      ...(options.localOptIn === undefined ? {} : { localOptIn: options.localOptIn }),
      ...(options.latency === undefined ? {} : { latency: options.latency }),
    },
    createProvider: options.createProvider,
    now: () => now().getTime(),
    emitFallback: (payload) => {
      options.emitter.queue({
        runId: options.runId,
        type: "model.fallback",
        ...(attributedStep === undefined ? {} : { stepId: attributedStep }),
        payload,
      });
    },
  });
  return {
    runId: options.runId,
    workspaceId: options.workspaceId,
    audience: options.audience,
    classification: options.classification,
    config: options.config,
    env: options.env,
    router,
    emitter: options.emitter,
    budget: options.budget,
    policies: options.policies,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    sleep: options.sleep ?? abortableSleep(options.signal),
    nextId: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${next}`;
    },
    attributeTo: (stepId) => {
      attributedStep = stepId;
    },
    gate: createProviderGate((role) => resolveChain(role, options.env, routing)[0]),
  };
}
