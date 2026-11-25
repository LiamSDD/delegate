import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import { RESULTS_DIR, liveDeps } from "../cli";
import { createLiveArmRunner, rowFromTrial } from "../evolve/arm";
import { PLAYBOOKS_DIR, PROMPTS_DIR } from "../evolve/files";
import { loadProposerPrompt, proposeRevision } from "../evolve/propose";
import { runDir } from "../judge/agreement-store";
import { createRouterCompleter } from "../judge/router-completer";
import { EVAL_MISSIONS, missionAdapter, type EvalMission } from "../missions";
import { loadRedteamDataset, summariseRedteam } from "../redteam/report";
import { runSuite } from "../redteam/runner";
import { createSharedCooldown, type RunEvalOptions } from "../runner";
import { poolFromRunDir } from "./arm-store";
import {
  TRAIN_DEFAULTS,
  planTraining,
  renderPlan,
  renderReport,
  runTraining,
  type TrainOptions,
} from "./run";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const ArgsSchema = z.object({
  mission: z.enum([...EVAL_MISSIONS, "all"], {
    error: `--mission must be one of ${EVAL_MISSIONS.join(", ")} or all`,
  }),
  rounds: z.coerce.number().int().min(1).max(20),
  "budget-minutes": z.coerce
    .number()
    .positive()
    .max(24 * 60),
  trials: z.coerce.number().int().min(2).max(20),
  "dry-run": z.boolean(),
  cases: z.string().optional(),
  audience: z.enum(["public-demo", "owner"]),
  concurrency: z.coerce.number().int().min(1).max(4),
  threshold: z.coerce.number().min(0).max(1).optional(),
  judge: z.boolean(),
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      mission: { type: "string", default: "all" },
      rounds: { type: "string", default: String(TRAIN_DEFAULTS.rounds) },
      "budget-minutes": { type: "string", default: String(TRAIN_DEFAULTS.budgetMinutes) },
      trials: { type: "string", default: String(TRAIN_DEFAULTS.trials) },
      "dry-run": { type: "boolean", default: false },
      cases: { type: "string" },
      audience: { type: "string", default: "public-demo" },
      concurrency: { type: "string", default: "1" },
      threshold: { type: "string" },
      judge: { type: "boolean", default: false },
    },
    strict: true,
  });
  const args = ArgsSchema.parse(values);
  const missions: EvalMission[] = args.mission === "all" ? [...EVAL_MISSIONS] : [args.mission];
  const caseIds = args.cases
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (caseIds !== undefined && missions.length > 1)
    throw new Error("--cases names one mission's cases; pick one --mission");
  const trainingDir = `${RESULTS_DIR}/training`;
  const options: TrainOptions = {
    missions,
    rounds: args.rounds,
    budgetMs: Math.round(args["budget-minutes"] * 60_000),
    trials: args.trials,
    dryRun: args["dry-run"],
    ...(caseIds === undefined ? {} : { caseIds }),
    audience: args.audience,
    ...(args.threshold === undefined ? {} : { threshold: args.threshold }),
    concurrency: args.concurrency,
    resultsDir: RESULTS_DIR,
    trainingDir,
    promptsDir: PROMPTS_DIR,
    playbooksDir: PLAYBOOKS_DIR,
    repoRoot: REPO_ROOT,
  };
  if (options.dryRun) {
    process.stdout.write(`${renderPlan(planTraining(options, { now: () => new Date() }))}\n`);
    return;
  }

  const evalOptions = (mission: EvalMission, resultsDir: string): RunEvalOptions => ({
    mission,
    trials: args.trials,
    ...(caseIds === undefined ? {} : { caseIds }),
    audience: args.audience,
    offline: false,
    concurrency: args.concurrency,
    baseline: false,
    judge: args.judge,
    resultsDir,
    threshold: args.threshold ?? 0.05,
  });
  const base = liveDeps(evalOptions(missions[0] ?? "xray", RESULTS_DIR));
  const cooldown = createSharedCooldown(base.sleep, base.now);
  const deps = { ...base, cooldown };
  const runLiveArm = createLiveArmRunner(deps, evalOptions);
  const proposerPrompt = loadProposerPrompt();
  const completer = createRouterCompleter({
    env: deps.env,
    audience: args.audience,
    sleep: deps.sleep,
  });

  const report = await runTraining(options, {
    now: deps.now,
    log: deps.log,
    cooldown,
    runArm: async (plan) => {
      const { summary, trials } = await runLiveArm({
        mission: plan.mission,
        prompts: plan.prompts,
        houses: plan.houses,
        resultsDir: plan.runsDir,
      });
      const rows = trials
        .map(rowFromTrial)
        .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.trial - b.trial);
      return {
        evalRun: summary.id,
        rows,
        pool: poolFromRunDir(
          missionAdapter(plan.mission),
          runDir(plan.runsDir, plan.mission, summary.id),
          rows,
        ),
      };
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
  });
  process.stdout.write(`${renderReport(report, `pnpm train ${argv.join(" ")}`.trim())}\n`);
}

await main();
