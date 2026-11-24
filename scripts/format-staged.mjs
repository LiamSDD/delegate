#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

if (staged.length === 0) process.exit(0);

const prettierBin = createRequire(import.meta.url).resolve("prettier/bin/prettier.cjs");

const result = spawnSync(
  process.execPath,
  [prettierBin, "--check", "--ignore-unknown", "--log-level=warn", ...staged],
  {
    stdio: "inherit",
    shell: false,
  },
);

if (result.error) {
  console.error(
    `format-check: could not run prettier (${result.error.message}). Run pnpm install.`,
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error(
    "format-check: run `pnpm format` (or prettier --write on the files above) and re-stage.",
  );
}
process.exit(result.status ?? 1);
