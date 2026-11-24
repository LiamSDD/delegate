import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const filePath = input?.tool_input?.file_path ?? "";
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (!/\.(ts|tsx|mts|cts)$/.test(filePath) || !path.resolve(filePath).startsWith(root))
  process.exit(0);

try {
  execFileSync("pnpm", ["exec", "eslint", "--max-warnings", "0", path.relative(root, filePath)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
} catch (error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  process.stderr.write(`eslint found problems in ${filePath}:\n${output.slice(0, 4000)}\n`);
  process.exit(2);
}
