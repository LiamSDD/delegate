import { z } from "zod";

import { MODEL_ROLES } from "./events";
import { isProviderAvailable, resolveChain, type Env, type ModelsConfig } from "./models";
import { type ToolDefinition } from "./providers/types";
import { createServerProvider } from "./server";

export interface SmokeResult {
  provider: string;
  model: string;
  status: "pass" | "fail" | "skip";
  toolCall: boolean;
  latencyMs?: number;
  detail?: string;
}

export interface SmokeOptions {
  config: ModelsConfig;
  env: Env;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const PING: ToolDefinition = {
  name: "ping",
  description: 'Connectivity check. Call it with value "pong".',
  inputSchema: z.object({ value: z.string() }),
};

const SECRETS = /nvapi-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRETS, "[redacted]");
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult[]> {
  const now = options.now ?? Date.now;
  const context = {
    audience: "owner" as const,
    environment: "server" as const,
    classification: "public" as const,
  };
  const seen = new Set<string>();
  const results: SmokeResult[] = [];
  for (const role of MODEL_ROLES) {
    for (const configured of options.config.roles[role]) {
      const key = `${configured.provider}/${configured.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const provider = options.config.providers.find(
        (candidate) => candidate.id === configured.provider,
      );
      if (provider === undefined || !isProviderAvailable(provider, options.env, context)) {
        results.push({
          provider: configured.provider,
          model: configured.model,
          status: "skip",
          toolCall: false,
          detail: "not configured on this server",
        });
        continue;
      }
      if (configured.interactive === false) {
        results.push({
          provider: configured.provider,
          model: configured.model,
          status: "skip",
          toolCall: false,
          detail: "offline only (interactive: false); exercised by offline runs and evals",
        });
        continue;
      }
      const entry = resolveChain(role, options.env, { config: options.config, ...context }).find(
        (candidate) =>
          candidate.provider.id === configured.provider && candidate.model === configured.model,
      );
      if (entry === undefined) {
        results.push({
          provider: configured.provider,
          model: configured.model,
          status: "skip",
          toolCall: false,
          detail: "not routable",
        });
        continue;
      }
      const started = now();
      try {
        const adapter = createServerProvider(entry, options.env, options.fetchImpl);
        let called = false;
        let stop = "none";
        for await (const event of adapter.stream({
          model: entry.model,
          quirks: entry.quirks,
          ...(entry.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: entry.reasoningEffort }),
          system:
            "You are a connectivity check for an agent platform. Always answer by calling the ping tool exactly once.",
          messages: [{ role: "user", content: 'Call the ping tool with value "pong".' }],
          tools: [PING],
          maxTokens: 400,
        })) {
          if (event.type === "tool_call_complete" && event.call.name === PING.name) called = true;
          if (event.type === "stop") stop = event.reason;
        }
        const latencyMs = now() - started;
        results.push({
          provider: entry.provider.id,
          model: entry.model,
          status: called ? "pass" : "fail",
          toolCall: called,
          latencyMs,
          ...(called ? {} : { detail: stop === "error" ? "stream error" : "no tool call" }),
        });
      } catch (error) {
        results.push({
          provider: entry.provider.id,
          model: entry.model,
          status: "fail",
          toolCall: false,
          latencyMs: now() - started,
          detail: redactSecrets(error instanceof Error ? error.message : "request failed").slice(
            0,
            160,
          ),
        });
      }
    }
  }
  return results;
}

export function formatSmokeReport(results: readonly SmokeResult[]): string {
  const lines = results.map((result) => {
    const latency = result.latencyMs === undefined ? "-" : `${result.latencyMs} ms`;
    const detail = result.detail === undefined ? "" : `  (${redactSecrets(result.detail)})`;
    return `${result.status.toUpperCase().padEnd(4)}  ${`${result.provider}/${result.model}`.padEnd(52)}  tool call: ${result.toolCall ? "yes" : "no "}  ${latency.padStart(9)}${detail}`;
  });
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  return [
    ...lines,
    `${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped`,
  ].join("\n");
}
