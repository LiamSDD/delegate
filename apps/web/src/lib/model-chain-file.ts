import { readFile } from "node:fs/promises";
import path from "node:path";

import { type ChainSummary, summariseKeylessChain } from "./model-chain";

export type ConfigReader = () => Promise<string>;

function readMonorepoModelsConfig(): Promise<string> {
  return readFile(path.join(process.cwd(), "../../config/models.json"), "utf8");
}

export async function loadKeylessChain(
  read: ConfigReader = readMonorepoModelsConfig,
): Promise<ChainSummary> {
  let raw: string;
  try {
    raw = await read();
  } catch {
    return { status: "unavailable", reason: "config/models.json was not found" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "unavailable", reason: "config/models.json is not valid JSON" };
  }
  return summariseKeylessChain(json);
}
