import { CAPABILITIES } from "@delegate/policy";

import { type PlanStep } from "../../events";

export const SHIP_STEP_IDS = {
  prepare: "prepare",
  baseline: "baseline",
  implement: "implement",
  verify: "verify",
  ship: "ship",
} as const;

export const SHIP_CAPABILITIES = [
  CAPABILITIES.sandboxRead,
  CAPABILITIES.sandboxWrite,
  CAPABILITIES.sandboxExec,
  CAPABILITIES.artifactWrite,
  CAPABILITIES.repoWrite,
] as const;

export const SHIP_PLANNING_HINTS =
  "A fixed chain: prepare the sandbox (clone at the ref, detect commands, install), record baseline tests, let the Engineer implement the improvement, verify with the repository's own commands, then ask a human to approve shipping the diff as a pull request or a patch.";

export function shipPlan(): PlanStep[] {
  const ids = SHIP_STEP_IDS;
  return [
    {
      id: ids.prepare,
      role: "builder",
      objective:
        "Create an isolated sandbox, clone the repository at the requested ref over HTTPS, detect its package manager and test, lint and typecheck commands, and install dependencies.",
      inputs: [],
      capabilities: [CAPABILITIES.sandboxExec],
      acceptance: ["The repository is checked out at a recorded commit", "Commands are detected"],
      budgetShare: 0.02,
    },
    {
      id: ids.baseline,
      role: "analyst",
      objective: "Run the repository's own test, lint and typecheck commands before any change.",
      inputs: [ids.prepare],
      capabilities: [CAPABILITIES.sandboxExec],
      acceptance: ["Baseline results are recorded"],
      budgetShare: 0.02,
    },
    {
      id: ids.implement,
      role: "engineer",
      objective:
        "Implement the improvement with sandbox-only tools and iterate until its acceptance criteria are met and the tests pass, within the iteration, token and time caps.",
      inputs: [ids.baseline],
      capabilities: [CAPABILITIES.sandboxRead, CAPABILITIES.sandboxWrite, CAPABILITIES.sandboxExec],
      acceptance: ["A non-empty diff with no protected files", "Tests pass"],
      budgetShare: 0.9,
    },
    {
      id: ids.verify,
      role: "critic",
      objective:
        "Re-run the test, lint and typecheck commands on the change and compare with the baseline.",
      inputs: [ids.implement],
      capabilities: [CAPABILITIES.sandboxExec],
      acceptance: ["After results are recorded next to the baseline"],
      budgetShare: 0.02,
    },
    {
      id: ids.ship,
      role: "editor",
      objective:
        "Show the diff and before/after test results for approval; on approval open a pull request through the GitHub App on an authorised repository, otherwise produce a downloadable patch and test report.",
      inputs: [ids.verify],
      capabilities: [CAPABILITIES.artifactWrite, CAPABILITIES.repoWrite],
      acceptance: ["Nothing leaves the sandbox without human approval"],
      budgetShare: 0.02,
    },
  ];
}
