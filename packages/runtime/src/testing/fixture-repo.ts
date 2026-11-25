import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";

const GIT_IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

export async function createFixtureRepo(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(posix.join(tmpdir(), "delegate-fixture-repo-")));
  for (const [path, content] of Object.entries(files)) {
    const target = posix.join(dir, path);
    await mkdir(posix.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const git = (args: string[]) =>
    execFileSync("git", [...GIT_IDENTITY, ...args], { cwd: dir, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

export const SUM_FIXTURE: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "sum-fixture",
      version: "1.0.0",
      private: true,
      scripts: { test: "node --test test/" },
    },
    null,
    2,
  )}\n`,
  "package-lock.json": `${JSON.stringify(
    {
      name: "sum-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "sum-fixture", version: "1.0.0" } },
    },
    null,
    2,
  )}\n`,
  ".gitignore": "node_modules/\n",
  "src/sum.js":
    "function sum(values) {\n  return values.reduce((total, value) => total + value);\n}\n\nmodule.exports = { sum };\n",
  "test/sum.test.js":
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sum } = require("../src/sum");\n\ntest("adds numbers", () => {\n  assert.strictEqual(sum([1, 2, 3]), 6);\n});\n\ntest("returns 0 for an empty list", () => {\n  assert.strictEqual(sum([]), 0);\n});\n',
};

export const FIXED_SUM =
  "function sum(values) {\n  return values.reduce((total, value) => total + value, 0);\n}\n\nmodule.exports = { sum };\n";
