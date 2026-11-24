import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ENV_FILES = ["../../../../.env.local", "../../../../.env"];

export function loadRepoEnv(): Record<string, string | undefined> {
  for (const relative of REPO_ENV_FILES) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) process.loadEnvFile(path);
  }
  return { ...process.env };
}
