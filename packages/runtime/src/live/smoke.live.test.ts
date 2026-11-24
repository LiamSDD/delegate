import { it, expect } from "vitest";

import { loadModelsConfig } from "../server";
import { formatSmokeReport, runSmoke } from "../smoke";
import { loadRepoEnv } from "./env";

it("every configured provider and model answers a tiny tool-calling request", async () => {
  const results = await runSmoke({ config: loadModelsConfig(), env: loadRepoEnv() });
  process.stdout.write(`\n${formatSmokeReport(results)}\n`);
  expect(results.filter((result) => result.status === "fail")).toEqual([]);
});
