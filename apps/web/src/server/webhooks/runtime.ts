import type { ResolveDns } from "@delegate/runtime/security";
import { systemResolveDns } from "@delegate/runtime/server";

import { type SecretBox, secretBoxFromEnv, SecretStoreError } from "../secrets";
import { createWebhookTransport, type WebhookTransport } from "./transport";

export interface WebhookRuntime {
  schedule: (task: () => Promise<void>) => void;
  transport: WebhookTransport;
  resolveDns: ResolveDns;
  box: () => SecretBox | null;
  now: () => Date;
}

function logFailure(error: unknown): void {
  console.error("webhook task failed", error instanceof Error ? error.name : "unknown");
}

function runDetached(task: () => Promise<void>): void {
  task().catch(logFailure);
}

export function scheduleAfterResponse(task: () => Promise<void>): void {
  import("next/server").then(
    ({ after }) => {
      try {
        after(task);
      } catch {
        runDetached(task);
      }
    },
    () => {
      runDetached(task);
    },
  );
}

export function boxFromEnvironment(): SecretBox | null {
  try {
    return secretBoxFromEnv(process.env);
  } catch (error) {
    if (error instanceof SecretStoreError) return null;
    throw error;
  }
}

const holder = globalThis as typeof globalThis & {
  __delegateWebhookRuntime?: WebhookRuntime;
  __delegateWebhookOverrides?: Partial<WebhookRuntime>;
};

function defaultRuntime(): WebhookRuntime {
  holder.__delegateWebhookRuntime ??= {
    schedule: scheduleAfterResponse,
    transport: createWebhookTransport({ resolveDns: systemResolveDns }),
    resolveDns: systemResolveDns,
    box: boxFromEnvironment,
    now: () => new Date(),
  };
  return holder.__delegateWebhookRuntime;
}

export function webhookRuntime(): WebhookRuntime {
  return { ...defaultRuntime(), ...holder.__delegateWebhookOverrides };
}

export function configureWebhooks(overrides: Partial<WebhookRuntime> | null): void {
  if (overrides === null) delete holder.__delegateWebhookOverrides;
  else holder.__delegateWebhookOverrides = overrides;
}
