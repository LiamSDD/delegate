import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import { RESULTS_DIR } from "../cli";
import { ROUTE_LEARN_DEFAULTS, isRoutingEvidence, learnRouting, renderRouting } from "./learn";
import { LEARNED_ROUTING_FILE } from "./schema";
import { configuredChains, loadRoutingSources, runtimeMissionIds } from "./sources";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const ArgsSchema = z.object({
  "min-trials": z.coerce.number().int().min(2).max(10_000),
  "dry-run": z.boolean(),
});

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      "min-trials": { type: "string", default: String(ROUTE_LEARN_DEFAULTS.minTrials) },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  const args = ArgsSchema.parse(values);
  const sources = loadRoutingSources(RESULTS_DIR);
  if (!sources.some((source) => isRoutingEvidence(source.file))) {
    process.stdout.write(
      `No live result file under ${RESULTS_DIR}, so there is nothing to learn from. Run "pnpm eval --mission all --trials 3" first. ${LEARNED_ROUTING_FILE} was not written.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const routing = learnRouting({
    sources,
    chains: configuredChains(),
    missionIds: runtimeMissionIds(),
    minTrials: args["min-trials"],
    now: new Date(),
  });
  process.stdout.write(`${renderRouting(routing)}\n`);
  if (args["dry-run"]) {
    process.stdout.write(`Dry run: ${LEARNED_ROUTING_FILE} was not written.\n`);
    return;
  }
  const path = join(REPO_ROOT, LEARNED_ROUTING_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(routing, null, 2)}\n`);
  process.stdout.write(`Wrote ${LEARNED_ROUTING_FILE}\n`);
}

main();
