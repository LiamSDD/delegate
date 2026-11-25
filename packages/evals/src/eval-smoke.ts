import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSmoke } from "./smoke";

const dir = mkdtempSync(join(tmpdir(), "delegate-eval-smoke-"));
const started = Date.now();
try {
  const lines = await runSmoke(dir);
  for (const line of lines)
    process.stdout.write(
      `${line.ok ? "ok  " : "FAIL"} ${line.mission} ${line.caseId}: ${line.detail}\n`,
    );
  process.stdout.write(
    `eval:smoke (scripted fixtures recorded then replayed; checks the harness, not mission quality): ${lines.filter((l) => l.ok).length}/${lines.length} missions in ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
  );
  process.exitCode = lines.every((line) => line.ok) ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
