import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runMission } from "@delegate/runtime/server";
import { z } from "zod";

import { checkLinks } from "./graders/links";
import { createRouterCompleter } from "./judge/router-completer";
import { type RunEvalDeps, type RunEvalOptions } from "./runner";

export const RESULTS_DIR = fileURLToPath(new URL("../results", import.meta.url));
const REPO_ENV_FILE = fileURLToPath(new URL("../../../.env.local", import.meta.url));

const ArgsSchema = z.object({
  mission: z.literal("xray", { error: "Only --mission xray is available" }),
  trials: z.coerce.number().int().min(1).max(20),
  cases: z.string().optional(),
  audience: z.enum(["public-demo", "owner"]),
  offline: z.boolean(),
  replay: z.string().optional(),
  concurrency: z.coerce.number().int().min(1).max(4),
  baseline: z.boolean(),
  "no-judge": z.boolean(),
  threshold: z.coerce.number().min(0).max(1),
  tag: z.string().optional(),
});

export function parseEvalArgs(
  argv: readonly string[],
  defaults: { trials: number },
): RunEvalOptions {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      mission: { type: "string", default: "xray" },
      trials: { type: "string", default: String(defaults.trials) },
      cases: { type: "string" },
      audience: { type: "string", default: "public-demo" },
      offline: { type: "boolean", default: false },
      replay: { type: "string" },
      concurrency: { type: "string", default: "1" },
      baseline: { type: "boolean", default: false },
      "no-judge": { type: "boolean", default: false },
      threshold: { type: "string", default: "0.05" },
      tag: { type: "string" },
    },
    strict: true,
  });
  const args = ArgsSchema.parse(values);
  const caseIds = args.cases
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return {
    trials: args.trials,
    ...(caseIds === undefined ? {} : { caseIds }),
    ...(args.tag === undefined ? {} : { tag: args.tag }),
    audience: args.audience,
    offline: args.offline || args.replay !== undefined,
    ...(args.replay === undefined ? {} : { replayDir: args.replay }),
    concurrency: args.concurrency,
    baseline: args.baseline,
    judge: !args["no-judge"],
    resultsDir: RESULTS_DIR,
    threshold: args.threshold,
  };
}

export function liveDeps(options: RunEvalOptions): RunEvalDeps {
  if (!options.offline && existsSync(REPO_ENV_FILE)) process.loadEnvFile(REPO_ENV_FILE);
  const env = { ...process.env };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const linkCache = new Map<string, { ok: boolean; status?: number; error?: string }>();
  return {
    runMission,
    env,
    now: () => new Date(),
    sleep,
    judgeCompleter: createRouterCompleter({ env, audience: options.audience, sleep }),
    checkLinks: (urls) => checkLinks(urls, { cache: linkCache, sleep }),
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}
