import { type RunEvent } from "../events";
import { AUDIT_FORMULA } from "../missions/automation-audit/roi";
import { type AutomationAudit } from "../missions/automation-audit/schema";
import { type AssistantArtifact } from "../missions/build-agent/schema";
import { SourceMixSchema } from "../missions/company-xray/brief";
import { type GoalBrief } from "../missions/custom-goal/schema";
import { type NextActions } from "../missions/next-actions";
import { type RepoXray } from "../missions/repo-xray/schema";
import { type ShipResult } from "../missions/ship-a-pr/schema";

const AT = "2026-11-25T10:00:00.000Z";
const source: AutomationAudit["sources"][number] = {
  sourceId: "S1",
  url: "https://acme.example/",
  title: "Acme",
  fetchedAt: AT,
  kind: "company_site",
};

export function goalBriefFixture(company: { name: string; url: string } | null): GoalBrief {
  return {
    missionId: "custom-goal",
    status: "complete",
    goal: "Cut support load at Acme",
    objective: "Reduce repetitive support tickets at Acme",
    company: company === null ? null : { ...company, resolvedBy: "input" },
    sources: [{ ...source, quotes: ["Acme answers support questions by email."] }],
    sourceMix: SourceMixSchema.parse({ company_site: 1 }),
    rankFormula: "impact ÷ effort",
    generatedAt: AT,
    promptVersions: [],
    workstreams: [],
    actions: [
      {
        rank: 1,
        score: 3,
        title: "Automate first-line support answers",
        owner: "Support lead",
        effort: "low",
        impact: "high",
        mission: "automation-audit",
        basis: { text: "Acme answers support questions by email.", citations: ["S1"] },
      },
    ],
    risks: [],
    openQuestions: [],
  };
}

export function nextActionsFixture(actions: NextActions["actions"]): NextActions {
  return { missionId: "custom-goal", actions };
}

export function auditFixture(): AutomationAudit {
  const opportunity = (
    id: string,
    title: string,
    frequency: number,
    verification?: "unverified",
  ): AutomationAudit["opportunities"][number] => ({
    id,
    title,
    department: "Support",
    workflow: `${title} workflow`,
    automation: `An assistant that handles ${title.toLowerCase()} from the help centre`,
    frequencyPerMonth: frequency,
    minutesPerTask: 10,
    peopleInvolved: 2,
    adoptionRate: 0.5,
    hourlyCostEur: 40,
    difficulty: "low",
    risks: [],
    integrations: [],
    firstStep: "Export the help centre",
    evidence: [{ text: "Acme answers support questions by email.", citations: ["S1"] }],
    assumptions: [],
    ...(verification === undefined ? {} : { verification }),
  });
  return {
    company: "Acme",
    summary: "Two support workflows are worth automating.",
    opportunities: [
      opportunity("opp-1", "Order status questions", 900, "unverified"),
      opportunity("opp-2", "Return requests", 400),
    ],
    sources: [source],
    formula: AUDIT_FORMULA,
  };
}

export function repoXrayFixture(): RepoXray {
  const citation = { path: "src/io.ts", startLine: 5, endLine: 5 };
  const improvement = (
    rank: number,
    id: string,
    effort: "S" | "M",
    support?: "unverified",
  ): RepoXray["improvements"][number] => ({
    id,
    rank,
    title: `Improvement ${id}`,
    rationale: "Because the code says so.",
    files: ["src/io.ts"],
    kind: "test",
    effort,
    acceptance: ["A test covers it"],
    citations: [citation],
    ...(support === undefined ? {} : { support }),
  });
  return {
    missionId: "repo-xray",
    status: "complete",
    repo: {
      owner: "acme",
      name: "widget",
      url: "https://github.com/acme/widget",
      ref: "main",
      commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    },
    snapshot: {
      keptFiles: 1,
      skippedFiles: 0,
      skippedByReason: {},
      compressedBytes: 1,
      uncompressedBytes: 1,
      truncated: null,
      lockfiles: [],
      secretsRedacted: 0,
    },
    languages: [],
    architecture: { summary: [], diagram: null },
    modules: [],
    onboarding: { steps: [], entryPoints: [] },
    dependencies: { total: 0, manifests: [], items: [] },
    hotspots: [],
    tests: { files: 0, frameworks: [], ci: [], gaps: [] },
    todos: { total: 0, byMarker: {} },
    improvements: [
      improvement(1, "imp-unverified", "S", "unverified"),
      improvement(2, "imp-medium", "M"),
      improvement(3, "imp-small", "S"),
    ],
    verification: { citationsChecked: 1, citationsValid: 1, claimsDropped: 0, citationAccuracy: 1 },
    generatedAt: AT,
    promptVersions: [],
  };
}

export function assistantFixture(): AssistantArtifact {
  return {
    id: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b",
    name: "Return requests",
    url: "https://acme.example/",
    collection: "acme",
    goal: "Handle return requests",
    systemPrompt: "You answer from the help centre.",
    persona: "Helpful",
    scope: { covers: ["Returns"], excludes: [] },
    refusalPolicy: "Refuse when the site is silent.",
    starterQuestions: ["How do I return an item?"],
    corpusStats: {
      pages: 3,
      chunks: 9,
      flaggedChunks: 0,
      embeddedChunks: 0,
      tokens: 1200,
      bytes: 4000,
      skippedPages: 0,
    },
    retrieval: { mode: "full-text", rerank: false },
    modelChain: { answer: [], rerank: [] },
    prompts: {},
    passRate: 0.8,
    gapsCount: 2,
    status: "ready",
  };
}

export function shipResultFixture(status: ShipResult["status"]): ShipResult {
  return {
    status,
    mode: status === "opened" ? "pull_request" : "patch",
    repo: "acme/widget",
    base: "main",
    branch: "delegate/imp-small",
    title: "Improvement imp-small",
    reason: "Tests pass",
    diffStat: { files: 1, additions: 12, deletions: 2 },
    baseline: { command: "npm test", exitCode: 0, passed: true, durationMs: 1000 },
    after: { command: "npm test", exitCode: 0, passed: true, durationMs: 1000 },
    ...(status === "opened"
      ? {
          pullRequest: {
            url: "https://github.com/acme/widget/pull/7",
            number: 7,
            repo: "acme/widget",
            branch: "delegate/imp-small",
            base: "main",
            commitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
          },
        }
      : {}),
  };
}

export function childLog(
  runId: string,
  missionId: string,
  artifacts: readonly { kind: string; title: string; content: unknown }[],
  terminal: { status: "completed"; summary: string } | { status: "failed"; message: string },
): RunEvent[] {
  let seq = 0;
  const next = () => {
    seq += 1;
    return { runId, seq, at: AT };
  };
  return [
    {
      ...next(),
      type: "run.created",
      payload: {
        workspaceId: "ws",
        missionId,
        input: {},
        actor: { type: "guest", id: "u" },
        budget: { maxTokens: 1, maxMicroUsd: 0 },
      },
    },
    ...artifacts.map((artifact, index): RunEvent => ({
      ...next(),
      type: "artifact.created",
      payload: {
        artifactId: `${runId}-a${String(index)}`,
        kind: artifact.kind,
        title: artifact.title,
        version: 1,
        content: artifact.content,
      },
    })),
    terminal.status === "completed"
      ? { ...next(), type: "run.completed", payload: { summary: terminal.summary } }
      : {
          ...next(),
          type: "run.failed",
          payload: { error: { code: "mission_failed", message: terminal.message } },
        },
  ];
}
