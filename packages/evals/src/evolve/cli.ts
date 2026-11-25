import { parseArgs } from "node:util";

import { createMemoryPlaybookStore, housePlaybookKeys } from "@delegate/runtime";
import { loadRuntimePrompts } from "@delegate/runtime/server";
import { z } from "zod";

import { RESULTS_DIR, liveDeps } from "../cli";
import { createRouterCompleter } from "../judge/router-completer";
import { EVAL_MISSIONS, missionAdapter } from "../missions";
import { loadRedteamDataset, summariseRedteam } from "../redteam/report";
import { runSuite } from "../redteam/runner";
import { type RunEvalOptions } from "../runner";
import { createLiveArmRunner } from "./arm";
import { PLAYBOOKS_DIR, PROMPTS_DIR, nextPromptVersion, readHousePlaybook } from "./files";
import { EvolutionKindSchema } from "./log";
import { loadProposerPrompt, proposeRevision } from "./propose";
import { runEvolution } from "./run";
import { missionTargets } from "./targets";

const ArgsSchema = z.object({
  mission: z.enum(EVAL_MISSIONS, {
    error: `--mission must be one of ${EVAL_MISSIONS.join(", ")}`,
  }),
  kind: EvolutionKindSchema,
  target: z.string().optional(),
  key: z.string().optional(),
  trials: z.coerce.number().int().min(2).max(20),
  cases: z.string().optional(),
  audience: z.enum(["public-demo", "owner"]),
  concurrency: z.coerce.number().int().min(1).max(4),
  threshold: z.coerce.number().min(0).max(1).optional(),
  judge: z.boolean(),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      mission: { type: "string", default: "xray" },
      kind: { type: "string", default: "prompt" },
      target: { type: "string" },
      key: { type: "string" },
      trials: { type: "string", default: "3" },
      cases: { type: "string" },
      audience: { type: "string", default: "public-demo" },
      concurrency: { type: "string", default: "1" },
      threshold: { type: "string" },
      judge: { type: "boolean", default: false },
    },
    strict: true,
  });
  const args = ArgsSchema.parse(values);
  const adapter = missionAdapter(args.mission);
  const targets = missionTargets(args.mission);
  const caseIds = args.cases
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const targetKey = targets.prompts.find((key) => key === (args.target ?? targets.prompts[0]));
  if (targetKey === undefined)
    throw new Error(
      `--target must be one of ${targets.prompts.join(", ")} for --mission ${args.mission}`,
    );
  const selected = adapter.loadCases().filter((c) => caseIds?.includes(c.id) ?? true);
  const keys = housePlaybookKeys(
    targets.runtimeMissionId,
    selected.map((c) => adapter.input(c)),
  );
  const playbookKey = args.key ?? keys[0];
  if (playbookKey === undefined || !keys.includes(playbookKey))
    throw new Error(`--key must be one of ${keys.join(", ")} for the selected cases`);
  const threshold = args.threshold ?? targets.regression.threshold;
  const target = loadRuntimePrompts()[targetKey];
  const evalOptions = (resultsDir: string): RunEvalOptions => ({
    mission: args.mission,
    trials: args.trials,
    ...(caseIds === undefined ? {} : { caseIds }),
    audience: args.audience,
    offline: false,
    concurrency: args.concurrency,
    baseline: false,
    judge: args.judge,
    resultsDir,
    threshold,
  });
  const deps = liveDeps(evalOptions(RESULTS_DIR));
  const evolutionDir = `${RESULTS_DIR}/evolution`;
  const proposerPrompt = loadProposerPrompt();
  const completer = createRouterCompleter({ env: deps.env, audience: args.audience });
  const runArm = createLiveArmRunner(deps, (_mission, resultsDir) => evalOptions(resultsDir));

  const { log, logPath } = await runEvolution(
    {
      mission: args.mission,
      title: adapter.title,
      kind: args.kind,
      trials: args.trials,
      threshold,
      targetKey,
      target,
      nextPromptVersion: nextPromptVersion([PROMPTS_DIR], target.name),
      playbookKey,
      house: readHousePlaybook(PLAYBOOKS_DIR, playbookKey),
      evolutionDir,
      promptsDir: PROMPTS_DIR,
      playbooksDir: PLAYBOOKS_DIR,
    },
    {
      now: () => new Date(),
      log: deps.log,
      createStore: (seed) => createMemoryPlaybookStore(seed),
      runArm: (arm) =>
        runArm({
          mission: arm.mission,
          prompts: arm.prompts,
          houses: arm.houses,
          store: arm.store,
          resultsDir: `${evolutionDir}/runs/${arm.label}`,
        }),
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
