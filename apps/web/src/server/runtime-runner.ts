import { readFileSync } from "node:fs";
import path from "node:path";

import modelsConfig from "@config/models.json";
import {
  parsePromptFile,
  type PromptFile,
  runMission as runtimeRunMission,
  type RunMissionOptions,
  type RunMissionResult,
  RUNTIME_PROMPT_FILES,
  type RuntimePrompts,
} from "@delegate/runtime/server";

import { isOwnerModeEnabled } from "@/flags";

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
  loadPrompts?: () => RuntimePrompts;
}

export function createRuntimeRunner(options: RuntimeRunnerOptions): MissionRunner {
  const runMission = options.runMission ?? runtimeRunMission;
  const loadPrompts = options.loadPrompts ?? loadRepoPrompts;
  const audience = isOwnerModeEnabled(options.env) ? "owner" : "public-demo";
  let prompts: RuntimePrompts | undefined;
  return ({ runId, missionId, input, emit, signal, awaitPlanApproval, planApprover }) => {
    prompts ??= loadPrompts();
    return runMission({
      runId,
      missionId,
      input,
      context: { audience, classification: "public" },
      env: options.env,
      emit: adaptRuntimeEmit(runId, emit),
      signal,
      modelsConfig,
      latency: "interactive",
      prompts,
      awaitPlanApproval,
      planApprover,
    });
  };
}
