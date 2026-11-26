import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  housePlaybookFileName,
  parseHousePlaybook,
  parsePromptFile,
  type Playbook,
  type PromptFile,
} from "@delegate/runtime";

export const PROMPTS_DIR = fileURLToPath(new URL("../../../runtime/prompts", import.meta.url));
export const PLAYBOOKS_DIR = fileURLToPath(new URL("../../../runtime/playbooks", import.meta.url));

export function promptVersionsOnDisk(dir: string, name: string): number[] {
  if (!existsSync(dir)) return [];
  const pattern = new RegExp(`^${name.replace(/\./g, "\\.")}\\.v(\\d+)\\.md$`);
  return readdirSync(dir)
    .flatMap((file) => {
      const match = pattern.exec(file);
      return match?.[1] === undefined ? [] : [Number(match[1])];
    })
    .sort((a, b) => a - b);
}

export function nextPromptVersion(dirs: readonly string[], name: string): number {
  return Math.max(0, ...dirs.flatMap((dir) => promptVersionsOnDisk(dir, name))) + 1;
}

export function readPromptVersion(dir: string, name: string, version: number): PromptFile | null {
  const fileName = `${name}.v${version}.md`;
  const path = join(dir, fileName);
  if (!existsSync(path)) return null;
  try {
    return parsePromptFile(fileName, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readHousePlaybook(dir: string, key: string): Playbook | null {
  const path = join(dir, housePlaybookFileName(key));
  if (!existsSync(path)) return null;
  return parseHousePlaybook(key, readFileSync(path, "utf8"));
}
