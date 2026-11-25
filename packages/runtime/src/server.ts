import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";

import {
  defaultPolicy,
  ownerDefaultPolicy,
  shipConnectedPolicy,
  shipDemoPolicy,
  shipOwnerPolicy,
  type Policy,
} from "@delegate/policy";

import {
  createRunContext,
  resolveQuality,
  type Audience,
  type QualityMode,
  type QualityTimeouts,
} from "./agent/context";
import { createRunEmitter } from "./agent/emitter";
import { type ResumePoint } from "./agent/mission-runner";
import { analyseForResume, type ExistingArtifact } from "./durable/checkpoints";
import { LeaseLostError, holdLease, type RunLease } from "./durable/lease";
import { type EmbeddingProvider, resolveEmbeddings } from "./knowledge/embeddings";
import { createMemoryKnowledgeStore } from "./knowledge/memory-store";
import { type KnowledgeStore, type MemoryStore } from "./knowledge/types";
import { memoryNotes, recordRunMemory } from "./knowledge/workspace-memory";
import { Budget, type RunBudgetLimits } from "./budget";
import { type Actor, type PlaybookApplied, type RunEvent, type RunEventDraft } from "./events";
import { playbookKey, type LoggedEvent } from "./learning/lessons";
import { PlaybookSchema, selectGuidance, type Playbook } from "./learning/playbook";
import { reflectRun } from "./learning/reflect";
import { recordRunLessons, type PlaybookStore } from "./learning/store";
import {
  parseModelsConfig,
  resolveBaseUrl,
  type ChainEntry,
  type Env,
  type LatencyMode,
  type ModelsConfig,
} from "./models";
import { MISSIONS, type MissionId } from "./missions";
import { runAutomationAudit } from "./missions/automation-audit/run";
import { type AnswerEvent } from "./missions/build-agent/answer";
import {
  answerWithAssistant,
  type AnswerQuestionInput,
  type RateLimitHook,
} from "./missions/build-agent/chat";
import { runBuildAgent } from "./missions/build-agent/run";
import { createMemoryAssistantStore, type AssistantStore } from "./missions/build-agent/schema";
import { runCompanyXray } from "./missions/company-xray/run";
import { runShipAPr, type FindInstallation, type ShipLimits } from "./missions/ship-a-pr/run";
import { type AwaitShipApproval } from "./missions/ship-a-pr/schema";
import {
  createGitHubAppClient,
  readGitHubAppConfig,
  type GitHubAppClient,
  type RepoRef,
} from "./github/app";
import { createSandboxProvider } from "./sandbox";
import { SandboxUnavailableError, type SandboxProvider } from "./sandbox/types";
import { runCustomGoal } from "./missions/custom-goal/run";
import { runRepoXray } from "./missions/repo-xray/run";
import { type AwaitPlanApproval } from "./plan-approval";
import { parsePromptFile, type PromptFile } from "./prompts";
import { createAnthropicProvider } from "./providers/anthropic";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible";
import { type ModelProvider } from "./providers/types";
import { HostPoliteness } from "./crawl/politeness";
import { createFetcher, type ResolveDns } from "./tools/fetch";
import { createPinnedFetch } from "./tools/node-fetch";

export * from "./index";
export {
  createRepoXrayMission,
  runRepoXray,
  snapshotArtifact,
  REPO_XRAY_LIMITS,
  type RepoXrayDependencies,
  type RepoXrayPrompts,
} from "./missions/repo-xray/run";
export { REPO_ARCHIVE_HOST, archiveUrl } from "./missions/repo-xray/archive";

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
  prompts?: Partial<RuntimePrompts>;
  latency?: LatencyMode;
  quality?: QualityMode;
  qualityTimeouts?: Partial<QualityTimeouts>;
  awaitPlanApproval?: AwaitPlanApproval;
  planApprover?: Actor;
  concurrency?: number;
  knowledge?: KnowledgeStore;
  assistants?: AssistantStore;
  memory?: MemoryStore;
  embeddings?: EmbeddingProvider | null;
  playbooks?: PlaybookStore;
  houseLearning?: boolean;
  shippedHouse?: (key: string) => Playbook | null;
  graderScore?: (events: readonly LoggedEvent[]) => number | undefined;
  awaitShipApproval?: AwaitShipApproval;
  sandboxes?: SandboxProvider;
  github?: GitHubAppClient | null;
  findInstallation?: FindInstallation;
  cloneUrl?: (repo: RepoRef) => string;
  shipLimits?: Partial<ShipLimits>;
}

export function githubAppFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): GitHubAppClient | null {
  const config = readGitHubAppConfig(env);
  return config === null
    ? null
    : createGitHubAppClient({ config, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
}

export const RUNTIME_PROMPT_FILES = {
  reader: "quarantine-reader.v1.md",
  researcher: "company-xray.researcher.v1.md",
  synthesis: "company-xray.synthesis.v1.md",
  planner: "planner.v2.md",
  critic: "critic.v1.md",
  editor: "editor.v1.md",
  analyst: "automation-audit.analyst.v1.md",
  auditEditor: "automation-audit.editor.v1.md",
  designer: "build-agent.designer.v1.md",
  evalgen: "build-agent.evalgen.v1.md",
  grader: "build-agent.grader.v1.md",
  gaps: "build-agent.gaps.v1.md",
  answer: "assistant.answer.v1.md",
  rerank: "retrieval.rerank.v1.md",
  reflect: "reflect.v1.md",
  engineer: "ship-a-pr.engineer.v1.md",
  goalSynthesis: "custom-goal.synthesis.v1.md",
  repoArchitect: "repo-xray.architect.v1.md",
  repoImprover: "repo-xray.improver.v1.md",
} as const;

export const REFLECT_BUDGET: RunBudgetLimits = { maxTokens: 20_000, maxMicroUsd: 0 };

export const BUILD_AGENT_FETCH_PAGES = 340;
export const RESEARCH_FETCH_PAGES = 100;

function fetchPagesFor(missionId: string): number {
  return missionId === "build-agent" ? BUILD_AGENT_FETCH_PAGES : RESEARCH_FETCH_PAGES;
}

const inProcess = {
  knowledge: createMemoryKnowledgeStore(),
  assistants: createMemoryAssistantStore(),
};

export function inProcessStores(): { knowledge: KnowledgeStore; assistants: AssistantStore } {
  return inProcess;
}

const RESTORABLE_MISSIONS: ReadonlySet<string> = new Set(["build-agent", "ship-a-pr"]);

function policiesFor(missionId: MissionId, audience: Audience, connected: boolean): Policy[] {
  if (missionId === "ship-a-pr")
    return [
      audience === "owner" ? shipOwnerPolicy : connected ? shipConnectedPolicy : shipDemoPolicy,
    ];
  return [audience === "public-demo" ? defaultPolicy : ownerDefaultPolicy];
}

export type RuntimePrompts = Record<keyof typeof RUNTIME_PROMPT_FILES, PromptFile>;

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

export function loadShippedPlaybook(key: string): Playbook | null {
  try {
    const raw = readRepoFile(`../playbooks/${key.replace(":", ".")}.house.json`);
    const parsed = PlaybookSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success && parsed.data.key === key && parsed.data.scope === "house"
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

async function retrievePlaybook(
  options: RunMissionOptions,
  key: string,
): Promise<PlaybookApplied | undefined> {
  if (options.playbooks === undefined) return undefined;
  const pair = await options.playbooks.read(key).catch(() => ({ workspace: null, house: null }));
  const house = pair.house ?? (options.shippedHouse ?? loadShippedPlaybook)(key);
  return (
    selectGuidance([
      { scope: "workspace", playbook: pair.workspace },
      { scope: "house", playbook: house },
    ]) ?? undefined
  );
}

export function loadModelsConfig(override?: unknown): ModelsConfig {
  return parseModelsConfig(
    override ?? (JSON.parse(readRepoFile("../../../config/models.json")) as unknown),
  );
}

export function loadRuntimePrompts(provided: Partial<RuntimePrompts> = {}): RuntimePrompts {
  const entries = Object.entries(RUNTIME_PROMPT_FILES) as [keyof RuntimePrompts, string][];
  return Object.fromEntries(
    entries.map(([key, file]) => [key, provided[key] ?? loadPrompt(file)]),
  ) as RuntimePrompts;
}

export function loadCompanyXrayPrompts(): Pick<
  RuntimePrompts,
  "reader" | "researcher" | "synthesis"
> {
  const prompts = loadRuntimePrompts();
  return { reader: prompts.reader, researcher: prompts.researcher, synthesis: prompts.synthesis };
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

interface MissionResume {
  point?: ResumePoint;
  artifacts: readonly ExistingArtifact[];
  events?: readonly RunEvent[];
  playbook?: PlaybookApplied;
}

export function runMission(options: RunMissionOptions): Promise<RunMissionResult> {
  return executeMission(options);
}

async function executeMission(
  options: RunMissionOptions,
  resume?: MissionResume,
): Promise<RunMissionResult> {
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
  const produced: { kind: string; content: unknown; artifactId: string }[] = [];
  const logged: LoggedEvent[] = [...(resume?.events ?? [])];
  const emit = async (event: RunEventDraft) => {
    logged.push({ ...event, at: now().toISOString() });
    if (event.type === "artifact.created")
      produced.push({
        artifactId: event.payload.artifactId,
        kind: event.payload.kind,
        content: event.payload.content,
      });
    if (event.type === "artifact.updated") {
      const known = produced.find((entry) => entry.artifactId === event.payload.artifactId);
      if (known !== undefined && event.payload.content !== undefined)
        known.content = event.payload.content;
    }
    await options.emit(event);
  };
  for (const artifact of resume?.artifacts ?? [])
    produced.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      content: artifact.content,
    });
  const config = loadModelsConfig(options.modelsConfig);
  const ctx = createRunContext({
    runId: options.runId,
    workspaceId: options.workspaceId ?? "unscoped",
    audience,
    classification: options.context.classification,
    config,
    env: options.env,
    emitter: createRunEmitter(emit),
    budget: new Budget({ run: RUN_BUDGETS[audience] }),
    policies: policiesFor(mission.id, audience, options.findInstallation !== undefined),
    createProvider: (entry) => createServerProvider(entry, options.env, options.fetchImpl),
    environment: "server",
    ...(options.latency === undefined ? {} : { latency: options.latency }),
    quality: resolveQuality(audience, options.quality, options.qualityTimeouts),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const fetcher = createFetcher({
    fetchImpl: options.fetchImpl ?? createPinnedFetch(resolveDns),
    resolveDns,
    now,
    maxPages: fetchPagesFor(mission.id),
    hostGate: new HostPoliteness({
      now: () => now().getTime(),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const prompts = loadRuntimePrompts(options.prompts);
  const restorable = RESTORABLE_MISSIONS.has(mission.id);
  const point =
    resume?.point === undefined
      ? undefined
      : restorable
        ? resume.point
        : { ...resume.point, completed: new Map(), failed: new Set<string>() };
  const key = playbookKey(mission.id, parsed.data);
  const playbook = resume === undefined ? await retrievePlaybook(options, key) : resume.playbook;
  const run = {
    ...(options.awaitPlanApproval === undefined
      ? {}
      : { awaitPlanApproval: options.awaitPlanApproval }),
    ...(options.planApprover === undefined ? {} : { approver: options.planApprover }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(point === undefined ? {} : { resume: point }),
    ...(playbook === undefined ? {} : { playbook }),
  };
  const notes =
    options.memory === undefined ? [] : memoryNotes(await options.memory.read().catch(() => []));
  let status: "completed" | "failed";
  if (mission.id === "ship-a-pr") {
    const input = MISSIONS["ship-a-pr"].inputSchema.parse(parsed.data);
    let sandboxes: SandboxProvider;
    let github: GitHubAppClient | null;
    try {
      sandboxes = options.sandboxes ?? createSandboxProvider(options.env);
      github =
        options.github === undefined
          ? audience === "owner" || options.findInstallation !== undefined
            ? githubAppFromEnv(options.env, options.fetchImpl)
            : null
          : options.github;
    } catch (error) {
      return invalid(
        options.runId,
        options.emit,
        error instanceof SandboxUnavailableError ? "sandbox_unavailable" : "misconfigured",
        error instanceof Error ? error.message.slice(0, 300) : "Ship-a-PR is misconfigured",
      );
    }
    status = await runShipAPr({
      ctx,
      input,
      prompts: { planner: prompts.planner, engineer: prompts.engineer },
      sandboxes,
      github,
      ...(options.findInstallation === undefined
        ? {}
        : { findInstallation: options.findInstallation }),
      ...(options.cloneUrl === undefined ? {} : { cloneUrl: options.cloneUrl }),
      ...(options.awaitShipApproval === undefined
        ? {}
        : { awaitShipApproval: options.awaitShipApproval }),
      ...(options.shipLimits === undefined ? {} : { limits: options.shipLimits }),
      ...(restorable && resume !== undefined ? { existingArtifacts: resume.artifacts } : {}),
      run,
    });
  } else if (mission.id === "automation-audit") {
    const input = MISSIONS["automation-audit"].inputSchema.parse(parsed.data);
    status = await runAutomationAudit({ ctx, input, fetcher, prompts, run });
  } else if (mission.id === "build-agent") {
    const input = MISSIONS["build-agent"].inputSchema.parse(parsed.data);
    const embeddings =
      options.embeddings === null
        ? undefined
        : (options.embeddings ??
          resolveEmbeddings({
            config,
            env: options.env,
            audience,
            classification: options.context.classification,
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          }));
    status = await runBuildAgent({
      ctx,
      input,
      fetcher,
      prompts,
      knowledge: options.knowledge ?? inProcess.knowledge,
      assistants: options.assistants ?? inProcess.assistants,
      embeddings,
      memoryNotes: notes,
      ...(restorable && resume !== undefined ? { existingArtifacts: resume.artifacts } : {}),
      run,
    });
  } else if (mission.id === "custom-goal") {
    const input = MISSIONS["custom-goal"].inputSchema.parse(parsed.data);
    status = await runCustomGoal({ ctx, input, fetcher, prompts, run });
  } else if (mission.id === "repo-xray") {
    const input = MISSIONS["repo-xray"].inputSchema.parse(options.input);
    status = await runRepoXray({ ctx, input, fetcher, prompts, run });
  } else {
    const input = MISSIONS["company-xray"].inputSchema.parse(parsed.data);
    status = await runCompanyXray({ ctx, input, fetcher, prompts, run });
  }
  if (status === "completed" && options.memory !== undefined)
    await recordRunMemory(options.memory, {
      runId: options.runId,
      missionId: mission.id,
      input: parsed.data,
      at: now().toISOString(),
      artifacts: produced,
    }).catch(() => undefined);
  if (options.playbooks !== undefined && options.signal?.aborted !== true)
    await learnFromRun(options, {
      key,
      missionId: mission.id,
      input: parsed.data,
      events: logged,
      config,
      prompt: prompts.reflect,
      now,
    }).catch(() => undefined);
  return { status };
}

async function learnFromRun(
  options: RunMissionOptions,
  run: {
    key: string;
    missionId: string;
    input: unknown;
    events: readonly LoggedEvent[];
    config: ModelsConfig;
    prompt: PromptFile;
    now: () => Date;
  },
): Promise<void> {
  const store = options.playbooks;
  if (store === undefined) return;
  const audience = options.context.audience;
  const ctx = createRunContext({
    runId: `${options.runId}-reflect`,
    workspaceId: options.workspaceId ?? "unscoped",
    audience,
    classification: options.context.classification,
    config: run.config,
    env: options.env,
    emitter: createRunEmitter(() => Promise.resolve()),
    budget: new Budget({ run: REFLECT_BUDGET }),
    policies: [audience === "public-demo" ? defaultPolicy : ownerDefaultPolicy],
    createProvider: (entry) => createServerProvider(entry, options.env, options.fetchImpl),
    environment: "server",
    ...(options.latency === undefined ? {} : { latency: options.latency }),
    now: run.now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const graderScore = options.graderScore?.(run.events);
  const lessons = await reflectRun(
    {
      runId: options.runId,
      frame: { missionId: run.missionId, input: run.input },
      events: run.events,
      ...(graderScore === undefined ? {} : { graderScore }),
    },
    run.key,
    { ctx, prompt: run.prompt },
  );
  await recordRunLessons(store, lessons, {
    audience,
    ...(options.houseLearning === undefined ? {} : { houseLearning: options.houseLearning }),
  });
}

export interface ResumeMissionOptions extends Omit<RunMissionOptions, "missionId" | "input"> {
  events: readonly RunEvent[];
  lease?: RunLease;
}

export interface ResumeMissionResult {
  status: "completed" | "failed" | "busy";
  resumed: boolean;
  skippedSteps: string[];
  rerunSteps: string[];
}

function appliedPlaybook(events: readonly RunEvent[]): { playbook?: PlaybookApplied } {
  const applied = events.find((event) => event.type === "playbook.applied");
  return applied?.type === "playbook.applied" ? { playbook: applied.payload } : {};
}

export async function resumeMission(options: ResumeMissionOptions): Promise<ResumeMissionResult> {
  const analysis = analyseForResume(options.events);
  if (analysis.kind === "finished")
    return { status: analysis.status, resumed: false, skippedSteps: [], rerunSteps: [] };
  const restorable = RESTORABLE_MISSIONS.has(analysis.missionId);
  const skippedSteps = restorable ? analysis.completedSteps : [];
  const rerunSteps = restorable
    ? analysis.rerunSteps
    : (analysis.point?.steps.map((step) => step.id) ?? []);
  const execute = (signal: AbortSignal | undefined, held: () => boolean = () => true) =>
    executeMission(
      {
        ...options,
        emit: (event) => (held() ? options.emit(event) : Promise.reject(new LeaseLostError())),
        missionId: analysis.missionId as MissionId,
        input: analysis.input,
        workspaceId: options.workspaceId ?? analysis.workspaceId,
        ...(signal === undefined ? {} : { signal }),
      },
      {
        ...(analysis.point === undefined ? {} : { point: analysis.point }),
        artifacts: analysis.artifacts,
        events: options.events,
        ...appliedPlaybook(options.events),
      },
    );
  if (options.lease === undefined) {
    const result = await execute(options.signal);
    return { status: result.status, resumed: true, skippedSteps, rerunSteps };
  }
  const held = await holdLease(options.lease, options.signal, execute);
  if (!held.acquired) return { status: "busy", resumed: false, skippedSteps: [], rerunSteps: [] };
  return { status: held.value.status, resumed: true, skippedSteps, rerunSteps };
}

export const CHAT_BUDGETS: Record<Audience, RunBudgetLimits> = {
  "public-demo": { maxTokens: 40_000, maxMicroUsd: 0 },
  owner: { maxTokens: 60_000, maxMicroUsd: 200_000 },
};

export interface AnswerQuestionOptions extends AnswerQuestionInput {
  env: Record<string, string | undefined>;
  audience: Audience;
  assistants?: AssistantStore;
  knowledge?: KnowledgeStore;
  embeddings?: EmbeddingProvider | null;
  modelsConfig?: unknown;
  prompts?: Partial<RuntimePrompts>;
  rateLimit?: RateLimitHook;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  latency?: LatencyMode;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export function answerQuestion(options: AnswerQuestionOptions): AsyncGenerator<AnswerEvent> {
  const config = loadModelsConfig(options.modelsConfig);
  const prompts = loadRuntimePrompts(options.prompts);
  const embeddings =
    options.embeddings === null
      ? undefined
      : (options.embeddings ??
        resolveEmbeddings({
          config,
          env: options.env,
          audience: options.audience,
          classification: "public",
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        }));
  return answerWithAssistant(
    {
      assistants: options.assistants ?? inProcess.assistants,
      knowledge: options.knowledge ?? inProcess.knowledge,
      embeddings,
      prompts: { answer: prompts.answer, rerank: prompts.rerank },
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
      context: (assistantId) =>
        createRunContext({
          runId: `chat-${assistantId}`,
          workspaceId: "assistant",
          audience: options.audience,
          classification: "public",
          config,
          env: options.env,
          emitter: createRunEmitter(() => Promise.resolve()),
          budget: new Budget({ run: CHAT_BUDGETS[options.audience] }),
          policies: [options.audience === "public-demo" ? defaultPolicy : ownerDefaultPolicy],
          createProvider: (entry) => createServerProvider(entry, options.env, options.fetchImpl),
          environment: "server",
          ...(options.latency === undefined ? {} : { latency: options.latency }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
    },
    {
      assistantId: options.assistantId,
      question: options.question,
      ...(options.history === undefined ? {} : { history: options.history }),
    },
  );
}

export { AnswerQuestionInputSchema, type RateLimitHook } from "./missions/build-agent/chat";
export {
  MAX_QUALITY_TIMEOUTS,
  QUALITY_MODES,
  resolveQuality,
  type QualityMode,
  type QualitySettings,
  type QualityTimeouts,
} from "./agent/context";
export {
  analyseForResume,
  type ExistingArtifact,
  type ResumeAnalysis,
} from "./durable/checkpoints";
export { LeaseLostError, createMemoryLeases, holdLease } from "./durable/lease";
export {
  createOpenAICompatibleEmbeddings,
  embedAll,
  EmbeddingError,
  resolveEmbeddings,
  type EmbeddingProvider,
} from "./knowledge/embeddings";
export { chunkPage, CHUNK_DEFAULTS } from "./knowledge/chunker";
export {
  createMemoryKnowledgeStore,
  createMemoryMemoryStore,
  lexicalTerms,
} from "./knowledge/memory-store";
export { reciprocalRankFusion, retrieve, RETRIEVAL_DEFAULTS } from "./knowledge/retrieve";
export { memoryNotes, recordRunMemory, MEMORY_KEYS } from "./knowledge/workspace-memory";
export { assistantIdForRun } from "./missions/build-agent/run";
export { type FindInstallation } from "./missions/ship-a-pr/run";
export { readGitHubAppConfig, type GitHubAppClient } from "./github/app";
export { createSandboxProvider, sandboxKindFor } from "./sandbox";
