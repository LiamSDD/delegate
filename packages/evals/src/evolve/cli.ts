import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createMemoryPlaybookStore } from "@delegate/runtime";
import {
  RUNTIME_PROMPT_FILES,
  loadPrompt,
  loadShippedPlaybook,
  runMission,
} from "@delegate/runtime/server";
import { z } from "zod";

import { RESULTS_DIR, liveDeps } from "../cli";
import { createRouterCompleter } from "../judge/router-completer";
import { loadRedteamDataset, summariseRedteam } from "../redteam/report";
import { runSuite } from "../redteam/runner";
import { runEval, type RunEvalOptions, type TrialRecord } from "../runner";
import { EvolutionKindSchema } from "./log";
import { loadProposerPrompt, proposeRevision } from "./propose";
import { PLAYBOOK_KEY, runEvolution } from "./run";

const PROMPTS_DIR = fileURLToPath(new URL("../../../runtime/prompts", import.meta.url));
const PLAYBOOKS_DIR = fileURLToPath(new URL("../../../runtime/playbooks", import.meta.url));

const ArgsSchema = z.object({
  mission: z.literal("xray", { error: "Only --mission xray is available" }),
  kind: EvolutionKindSchema,
  trials: z.coerce.number().int().min(2).max(20),
  cases: z.string().optional(),
  audience: z.enum(["public-demo", "owner"]),
  concurrency: z.coerce.number().int().min(1).max(4),
  threshold: z.coerce.number().min(0).max(1),
  judge: z.boolean(),
});

function nextVersion(name: string): number {
  const pattern = new RegExp(`^${name.replace(/\./g, "\\.")}\\.v(\\d+)\\.md$`);
  const versions = readdirSync(PROMPTS_DIR).flatMap((file) => {
    const match = pattern.exec(file);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
  return Math.max(0, ...versions) + 1;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      mission: { type: "string", default: "xray" },
      kind: { type: "string", default: "prompt" },
      trials: { type: "string", default: "3" },
      cases: { type: "string" },
      audience: { type: "string", default: "public-demo" },
      concurrency: { type: "string", default: "1" },
      threshold: { type: "string", default: "0.05" },
      judge: { type: "boolean", default: false },
    },
    strict: true,
  });
  const args = ArgsSchema.parse(values);
  const caseIds = args.cases
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const planner = loadPrompt(RUNTIME_PROMPT_FILES.planner);
  const evalOptions = (resultsDir: string): RunEvalOptions => ({
    trials: args.trials,
    ...(caseIds === undefined ? {} : { caseIds }),
    audience: args.audience,
    offline: false,
    concurrency: args.concurrency,
    baseline: false,
    judge: args.judge,
    resultsDir,
    threshold: args.threshold,
  });
  const deps = liveDeps(evalOptions(RESULTS_DIR));
  const evolutionDir = `${RESULTS_DIR}/evolution`;
  const proposerPrompt = loadProposerPrompt();
  const completer = createRouterCompleter({ env: deps.env, audience: args.audience });

  const { log, logPath } = await runEvolution(
    {
      kind: args.kind,
      trials: args.trials,
      threshold: args.threshold,
      planner,
      nextPromptVersion: nextVersion(planner.name),
      house: loadShippedPlaybook(PLAYBOOK_KEY),
      evolutionDir,
      promptsDir: PROMPTS_DIR,
      playbooksDir: PLAYBOOKS_DIR,
    },
    {
      now: () => new Date(),
      log: deps.log,
      createStore: (seed) => createMemoryPlaybookStore(seed),
      runArm: async (arm) => {
        const trials: TrialRecord[] = [];
        const summary = await runEval(evalOptions(`${evolutionDir}/runs/${arm.label}`), {
          ...deps,
          runMission: (options) =>
            runMission({
              ...options,
              prompts: { ...options.prompts, planner: arm.planner },
              playbooks: arm.store,
              houseLearning: true,
              shippedHouse: () => arm.house,
            }),
          onTrial: (record) => trials.push(record),
        });
        return { summary, trials };
      },
      propose: (input) => proposeRevision(completer, { ...input, prompt: proposerPrompt }),
      redteam: async () => {
        const result = summariseRedteam(await runSuite(loadRedteamDataset()), new Date());
        return {
          suite: result.suite,
          attacks: result.attacks,
          successes: result.successes,
          asr: result.asr,
        };
      },
    },
  );
  process.stdout.write(
    `Evolution ${log.id}: ${log.decision.status}\n${log.decision.reasons.join("\n")}\n${logPath}\n`,
  );
}

await main();
