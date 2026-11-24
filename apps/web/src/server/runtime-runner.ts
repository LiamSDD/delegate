import { readFileSync } from "node:fs";
import path from "node:path";

import modelsConfig from "@config/models.json";
import {
  type CompanyXrayPrompts,
  parsePromptFile,
  type PromptFile,
  runMission as runtimeRunMission,
  type RunMissionOptions,
  type RunMissionResult,
} from "@delegate/runtime/server";

import { isOwnerModeEnabled } from "@/flags";

import { resolveRepoRoot } from "./db";
import type { MissionRunner } from "./mission-runner";
import { adaptRuntimeEmit } from "./runtime-emit";

const PROMPT_FILES = {
  reader: "quarantine-reader.v1.md",
  researcher: "company-xray.researcher.v1.md",
  synthesis: "company-xray.synthesis.v1.md",
} as const;

function readPrompt(root: string, fileName: string): PromptFile {
  return parsePromptFile(
    fileName,
    readFileSync(path.join(root, "packages", "runtime", "prompts", fileName), "utf8"),
  );
}

export function loadRepoPrompts(): CompanyXrayPrompts {
  const root = resolveRepoRoot();
  return {
    reader: readPrompt(root, PROMPT_FILES.reader),
    researcher: readPrompt(root, PROMPT_FILES.researcher),
    synthesis: readPrompt(root, PROMPT_FILES.synthesis),
  };
}

export interface RuntimeRunnerOptions {
  env: Record<string, string | undefined>;
  runMission?: (options: RunMissionOptions) => Promise<RunMissionResult>;
  loadPrompts?: () => CompanyXrayPrompts;
}

export function createRuntimeRunner(options: RuntimeRunnerOptions): MissionRunner {
  const runMission = options.runMission ?? runtimeRunMission;
  const loadPrompts = options.loadPrompts ?? loadRepoPrompts;
  const audience = isOwnerModeEnabled(options.env) ? "owner" : "public-demo";
  let prompts: CompanyXrayPrompts | undefined;
  return ({ runId, missionId, input, emit, signal }) => {
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
    });
  };
}
