import { CAPABILITIES } from "@delegate/policy";

import { type PlanStep } from "../../events";

export const REPO_STEP_IDS = {
  fetch: "fetch_repo",
  analyse: "analyse",
  read: "read_docs",
  architect: "architect",
  improve: "improve",
  critic: "critic",
} as const;

export const REPO_PLANNING_HINTS =
  "Download the repository archive first. Deterministic analysis and reading the documentation through the quarantined reader can then run in parallel. The architect (architecture, modules, onboarding) and the improver (ranked improvements) both need the analysis and the documentation facts and can run in parallel. The critic verifies every citation against the snapshot and every claim against its evidence, and runs last.";

export const REPO_PLAN: readonly PlanStep[] = [
  {
    id: REPO_STEP_IDS.fetch,
    role: "researcher",
    objective:
      "Download the repository as one tar.gz archive from codeload.github.com and read it into a capped, text-only snapshot.",
    inputs: [],
    capabilities: [CAPABILITIES.webFetch],
    acceptance: [
      "Exactly one archive request to codeload.github.com",
      "Binaries, vendored and build directories, lockfile bodies and oversize files are skipped and listed with a reason",
    ],
    budgetShare: 0.05,
  },
  {
    id: REPO_STEP_IDS.analyse,
    role: "analyst",
    objective:
      "Extract the file tree, languages, manifests and dependencies, entry points, tests, CI, the import graph, hotspots and test gaps in code, with no model calls.",
    inputs: [REPO_STEP_IDS.fetch],
    capabilities: [CAPABILITIES.artifactWrite],
    acceptance: ["Every finding cites path:line ranges that exist in the snapshot"],
    budgetShare: 0.05,
  },
  {
    id: REPO_STEP_IDS.read,
    role: "analyst",
    objective:
      "Read the README and documentation through the quarantined reader and keep only facts with verbatim quotes located to line ranges.",
    inputs: [REPO_STEP_IDS.fetch],
    capabilities: [],
    acceptance: [
      "Every fact carries a verbatim quote from its file",
      "Documents with suspected prompt injection contribute no facts",
    ],
    budgetShare: 0.15,
  },
  {
    id: REPO_STEP_IDS.architect,
    role: "editor",
    objective:
      "Write the architecture summary, choose the modules for the map, describe module responsibilities and the onboarding path, citing evidence ids only.",
    inputs: [REPO_STEP_IDS.analyse, REPO_STEP_IDS.read],
    capabilities: [CAPABILITIES.artifactWrite],
    acceptance: [
      "Every claim cites evidence ids from the analysis or the documentation facts",
      "Diagram nodes are real modules",
    ],
    budgetShare: 0.25,
  },
  {
    id: REPO_STEP_IDS.improve,
    role: "analyst",
    objective:
      "Rank 5 to 8 small, testable improvements from the hotspots, test gaps and documentation facts.",
    inputs: [REPO_STEP_IDS.analyse, REPO_STEP_IDS.read],
    capabilities: [CAPABILITIES.artifactWrite],
    acceptance: [
      "Each improvement names real files, a kind, an effort and acceptance checks",
      "Each rationale cites evidence ids",
    ],
    budgetShare: 0.25,
  },
  {
    id: REPO_STEP_IDS.critic,
    role: "critic",
    objective:
      "Verify every citation against the stored snapshot, check every claim against its evidence, remove what stays unsupported and store the cited files.",
    inputs: [REPO_STEP_IDS.architect, REPO_STEP_IDS.improve],
    capabilities: [CAPABILITIES.artifactWrite],
    acceptance: [
      "Every remaining citation resolves to existing lines",
      "Citation accuracy is reported",
    ],
    budgetShare: 0.25,
  },
];
