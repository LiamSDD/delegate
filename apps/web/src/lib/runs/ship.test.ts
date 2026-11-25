import { parseRunEvent, type RunEvent, shipPlan } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { buildShipView, parsePatch, shipStatusLabel } from "./ship";

const PATCH = [
  "diff --git a/src/sum.js b/src/sum.js",
  "index 1111111..2222222 100644",
  "--- a/src/sum.js",
  "+++ b/src/sum.js",
  "@@ -1,3 +1,3 @@",
  " function sum(values) {",
  "-  return values.reduce((total, value) => total + value);",
  "+  return values.reduce((total, value) => total + value, 0);",
  " }",
  "diff --git a/test/new.test.js b/test/new.test.js",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/test/new.test.js",
  "@@ -0,0 +1,2 @@",
  "+const test = require('node:test');",
  "+test('x', () => {});",
  "",
].join("\n");

describe("parsePatch", () => {
  it("splits files and hunks with line numbers and counts", () => {
    const files = parsePatch(PATCH);
    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["src/sum.js", "modified", 1, 1],
      ["test/new.test.js", "added", 2, 0],
    ]);
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["ctx", 3, 3],
    ]);
  });

  it("marks binary files without hunks", () => {
    const files = parsePatch(
      "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nGIT binary patch\nliteral 10\nzcmV\n",
    );
    expect(files[0]).toMatchObject({ path: "logo.png", binary: true, hunks: [] });
  });
});

const at = "2026-11-25T10:00:00.000Z";
const summary = (passed: boolean) => ({
  command: "npm run test",
  exitCode: passed ? 0 : 1,
  passed,
  durationMs: 900,
});

function events(): RunEvent[] {
  const bodies: unknown[] = [
    {
      type: "run.created",
      payload: {
        workspaceId: "ws",
        missionId: "ship-a-pr",
        input: {
          repoUrl: "https://github.com/acme/widgets",
          improvement: { title: "Fix sum", acceptance: ["sum([]) is 0"] },
        },
        actor: { type: "guest", id: "g" },
        budget: { maxTokens: 1, maxMicroUsd: 0 },
      },
    },
    { type: "plan.proposed", payload: { version: 1, steps: shipPlan() } },
    { type: "plan.approved", payload: { version: 1, approvedBy: { type: "system", id: "a" } } },
    { type: "step.started", stepId: "baseline", payload: {} },
    {
      type: "sandbox.command",
      stepId: "baseline",
      payload: {
        commandId: "cmd_1",
        purpose: "baseline",
        command: "npm run test",
        exitCode: 1,
        durationMs: 900,
        timedOut: false,
        output: "not ok 2",
        truncated: false,
      },
    },
    {
      type: "artifact.created",
      stepId: "baseline",
      payload: {
        artifactId: "a1",
        kind: "ship-test-report",
        title: "Baseline tests",
        version: 1,
        content: {
          phase: "baseline",
          test: summary(false),
          lint: null,
          typecheck: null,
          testOutput: "",
        },
      },
    },
    {
      type: "artifact.created",
      stepId: "verify",
      payload: {
        artifactId: "a2",
        kind: "ship-test-report",
        title: "After",
        version: 1,
        content: {
          phase: "after",
          test: summary(true),
          lint: null,
          typecheck: null,
          testOutput: "",
        },
      },
    },
    {
      type: "ship.approval.requested",
      stepId: "ship",
      payload: {
        approvalId: "ship_1",
        mode: "patch",
        repo: "acme/widgets",
        base: "default branch",
        branch: "delegate/x-1234567",
        title: "Fix sum",
        diffStat: { files: 1, additions: 1, deletions: 1 },
        patchArtifactId: "a3",
        baseline: summary(false),
        after: summary(true),
        reason: "Public demo runs never push to GitHub.",
      },
    },
  ];
  return bodies.map((body, index) =>
    parseRunEvent({ runId: "r", seq: index + 1, at, ...(body as Record<string, unknown>) }),
  );
}

describe("buildShipView", () => {
  it("derives commands, before/after tests and the pending approval from the log", () => {
    const view = buildShipView(events());
    expect(view.repo).toBe("acme/widgets");
    expect(view.title).toBe("Fix sum");
    expect(view.commands.map((command) => [command.purpose, command.exitCode])).toEqual([
      ["baseline", 1],
    ]);
    expect(view.baseline?.test.passed).toBe(false);
    expect(view.after?.test.passed).toBe(true);
    expect(view.approval?.status).toBe("pending");
    expect(shipStatusLabel(view, true)).toBe("Waiting for your approval");
  });
});
