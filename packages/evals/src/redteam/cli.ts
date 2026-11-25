import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatRedteamTable,
  formatSuccesses,
  loadRedteamDataset,
  summariseRedteam,
} from "./report";
import { runSuite } from "./runner";

export const REDTEAM_RESULTS_PATH = fileURLToPath(
  new URL("../../results/redteam.json", import.meta.url),
);

async function main(): Promise<void> {
  const outcomes = await runSuite(loadRedteamDataset());
  const result = summariseRedteam(outcomes, new Date());
  mkdirSync(dirname(REDTEAM_RESULTS_PATH), { recursive: true });
  writeFileSync(REDTEAM_RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Red-team suite ${result.suite}\n\n${formatRedteamTable(result)}\n\n`);
  process.stdout.write(`Wrote ${REDTEAM_RESULTS_PATH}\n`);
  if (result.successes > 0) {
    console.error(`\nAttacks that succeeded:\n${formatSuccesses(outcomes)}`);
    process.exitCode = 1;
  }
}

await main();
