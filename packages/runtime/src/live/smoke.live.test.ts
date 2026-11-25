import { it, expect } from "vitest";

import { loadModelsConfig } from "../server";
import { formatSmokeReport, runEmbeddingSmoke, runSmoke } from "../smoke";
import { loadRepoEnv } from "./env";

it("every configured provider and model answers a tiny tool-calling request", async () => {
  const options = { config: loadModelsConfig(), env: loadRepoEnv() };
  const results = [...(await runSmoke(options)), ...(await runEmbeddingSmoke(options))];
  process.stdout.write(`\n${formatSmokeReport(results)}\n`);
  expect(results.filter((result) => result.status === "fail")).toEqual([]);
});
