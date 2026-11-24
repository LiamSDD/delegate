import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";

import { defaultPolicy, ownerDefaultPolicy } from "@delegate/policy";

import { createRunContext, type Audience } from "./agent/context";
import { createRunEmitter } from "./agent/emitter";
import { Budget, type RunBudgetLimits } from "./budget";
import { type RunEventDraft } from "./events";
import {
  parseModelsConfig,
  resolveBaseUrl,
  type ChainEntry,
  type Env,
  type LatencyMode,
  type ModelsConfig,
} from "./models";
import { MISSIONS, type MissionId } from "./missions";
import { XRAY_PLAN } from "./missions/company-xray/plan";
import { runCompanyXray, type CompanyXrayPrompts } from "./missions/company-xray/run";
import { parsePromptFile, type PromptFile } from "./prompts";
import { createAnthropicProvider } from "./providers/anthropic";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible";
import { type ModelProvider } from "./providers/types";
import { createFetcher, type ResolveDns } from "./tools/fetch";
import { createPinnedFetch } from "./tools/node-fetch";

export * from "./index";

export interface RunMissionOptions {
  runId: string;
  missionId: MissionId;
  input: unknown;
  context: { audience: Audience; classification: "public" };
  env: Record<string, string | undefined>;
  emit: (event: RunEventDraft) => Promise<void>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveDns?: (host: string) => Promise<string[]>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  workspaceId?: string;
  modelsConfig?: unknown;
  prompts?: CompanyXrayPrompts;
  latency?: LatencyMode;
}

export interface RunMissionResult {
  status: "completed" | "failed";
}

export const RUN_BUDGETS: Record<Audience, RunBudgetLimits> = {
  "public-demo": { maxTokens: 300_000, maxMicroUsd: 0 },
  owner: { maxTokens: 600_000, maxMicroUsd: 2_000_000 },
};

export const systemResolveDns: ResolveDns = async (host) => {
  const answers = await lookup(host, { all: true, order: "verbatim" });
  return answers.map((answer) => answer.address);
};

function readRepoFile(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

export function loadPrompt(fileName: string): PromptFile {
  return parsePromptFile(fileName, readRepoFile(`../prompts/${fileName}`));
}

export function loadModelsConfig(override?: unknown): ModelsConfig {
  return parseModelsConfig(
    override ?? (JSON.parse(readRepoFile("../../../config/models.json")) as unknown),
  );
}

export function loadCompanyXrayPrompts(): CompanyXrayPrompts {
  return {
    reader: loadPrompt("quarantine-reader.v1.md"),
    researcher: loadPrompt("company-xray.researcher.v1.md"),
    synthesis: loadPrompt("company-xray.synthesis.v1.md"),
  };
}

export function createServerProvider(
  entry: ChainEntry,
  env: Env,
  fetchImpl?: typeof fetch,
): ModelProvider {
  const provider = entry.provider;
  const apiKey = provider.apiKeyEnv === undefined ? undefined : env[provider.apiKeyEnv];
  switch (provider.kind) {
    case "openai-compatible":
    case "ollama": {
      const baseUrl = resolveBaseUrl(provider, env);
      if (baseUrl === undefined) throw new Error(`Provider ${provider.id} has no baseUrl`);
      return createOpenAICompatibleProvider({
        id: provider.id,
        baseUrl,
        ...(provider.chatPath === undefined ? {} : { chatPath: provider.chatPath }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      });
    }
    case "anthropic":
      return createAnthropicProvider({
        id: provider.id,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      });
    case "webllm":
      throw new Error("WebLLM runs only in the browser");
  }
}

function invalid(
  runId: string,
  emit: RunMissionOptions["emit"],
  code: string,
  message: string,
): Promise<RunMissionResult> {
  return emit({ runId, type: "run.failed", payload: { error: { code, message } } }).then(() => ({
    status: "failed" as const,
  }));
}

export async function runMission(options: RunMissionOptions): Promise<RunMissionResult> {
  const mission = (MISSIONS as Partial<Record<string, (typeof MISSIONS)[MissionId]>>)[
    options.missionId
  ];
  if (mission === undefined)
    return invalid(
      options.runId,
      options.emit,
      "unknown_mission",
      `Unknown mission ${options.missionId}`,
    );
  const parsed = mission.inputSchema.safeParse(options.input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return invalid(options.runId, options.emit, "invalid_input", message.slice(0, 500));
  }
  const audience = options.context.audience;
  const now = options.now ?? (() => new Date());
  const resolveDns = options.resolveDns ?? systemResolveDns;
  const ctx = createRunContext({
    runId: options.runId,
    workspaceId: options.workspaceId ?? "unscoped",
    audience,
    classification: options.context.classification,
    config: loadModelsConfig(options.modelsConfig),
    env: options.env,
    emitter: createRunEmitter(options.emit),
    budget: Budget.forPlan(RUN_BUDGETS[audience], XRAY_PLAN),
    policies: [audience === "public-demo" ? defaultPolicy : ownerDefaultPolicy],
    createProvider: (entry) => createServerProvider(entry, options.env, options.fetchImpl),
    environment: "server",
    ...(options.latency === undefined ? {} : { latency: options.latency }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const fetcher = createFetcher({
    fetchImpl: options.fetchImpl ?? createPinnedFetch(resolveDns),
    resolveDns,
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const status = await runCompanyXray({
    ctx,
    input: parsed.data,
    fetcher,
    prompts: options.prompts ?? loadCompanyXrayPrompts(),
  });
  return { status };
}
