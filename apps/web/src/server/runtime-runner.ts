import { readFileSync } from "node:fs";
import path from "node:path";

import modelsConfig from "@config/models.json";
import {
  parsePromptFile,
  type PromptFile,
  resumeMission as runtimeResumeMission,
  type ResumeMissionOptions,
  type ResumeMissionResult,
  runMission as runtimeRunMission,
  type RunMissionOptions,
  type RunMissionResult,
  RUNTIME_PROMPT_FILES,
  type RuntimePrompts,
} from "@delegate/runtime/server";

import { isOwnerModeEnabled } from "@/flags";

import { assistantStores } from "./assistants";
import { resolveRepoRoot } from "./db";
import type { MissionRunner } from "./mission-runner";
import { adaptRuntimeEmit } from "./runtime-emit";

function readPrompt(root: string, fileName: string): PromptFile {
  return parsePromptFile(
    fileName,
    readFileSync(path.join(root, "packages", "runtime", "prompts", fileName), "utf8"),
  );
}

export function loadRepoPrompts(): RuntimePrompts {
  const root = resolveRepoRoot();
  const entries = Object.entries(RUNTIME_PROMPT_FILES) as [keyof RuntimePrompts, string][];
  return Object.fromEntries(
    entries.map(([key, file]) => [key, readPrompt(root, file)]),
  ) as RuntimePrompts;
}

export interface RuntimeRunnerOptions {
  env: Record<string, string | undefined>;
  runMission?: (options: RunMissionOptions) => Promise<RunMissionResult>;
  resumeMission?: (options: ResumeMissionOptions) => Promise<ResumeMissionResult>;
  loadPrompts?: () => RuntimePrompts;
}

export function createRuntimeRunner(options: RuntimeRunnerOptions): MissionRunner {
  const runMission = options.runMission ?? runtimeRunMission;
  const resumeMission = options.resumeMission ?? runtimeResumeMission;
  const loadPrompts = options.loadPrompts ?? loadRepoPrompts;
  const audience: "owner" | "public-demo" = isOwnerModeEnabled(options.env)
    ? "owner"
    : "public-demo";
  let prompts: RuntimePrompts | undefined;
  return async ({
    runId,
    missionId,
    input,
    emit,
    signal,
    awaitPlanApproval,
    planApprover,
    resumeFrom,
    connections,
  }) => {
    prompts ??= loadPrompts();
    const shared = {
      runId,
      context: { audience, classification: "public" as const },
      env: options.env,
      emit: adaptRuntimeEmit(runId, emit),
      signal,
      modelsConfig,
      latency: "interactive" as const,
      prompts,
      awaitPlanApproval,
      planApprover,
      ...assistantStores(),
      ...(connections === undefined ? {} : { connections }),
    };
    if (resumeFrom !== undefined) {
      const result = await resumeMission({ ...shared, events: resumeFrom });
      return { status: result.status === "completed" ? "completed" : "failed" };
    }
    return runMission({ ...shared, missionId, input });
  };
}
