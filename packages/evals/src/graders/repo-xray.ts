import {
  RepoImprovementSchema,
  RepoSnapshotArtifactSchema,
  RepoXraySchema,
  citationResolves,
  deliverableCitations,
  formatCitation,
  mermaidNodeModules,
  type RepoSnapshotArtifact,
  type RepoXray,
  type RunEvent,
} from "@delegate/runtime";

import { type RepoExpectedFact, type RepoXrayCase } from "../datasets/repo-xray";
import { type GradedCheck } from "./xray";

export const REPO_HARD_CHECKS = [
  "schema_valid",
  "citations_resolve",
  "mermaid_nodes_real",
  "improvements_valid",
] as const;

export interface RepoXrayGrade {
  caseId: string;
  checks: GradedCheck[];
  facts: { id: string; kind: string; found: boolean }[];
  passed: boolean;
}

function lastContent(events: readonly RunEvent[], kind: string): unknown {
  let artifactId: string | undefined;
  let content: unknown;
  for (const event of events) {
    if (event.type === "artifact.created" && event.payload.kind === kind) {
      artifactId = event.payload.artifactId;
      content = event.payload.content;
    }
    if (
      event.type === "artifact.updated" &&
      event.payload.artifactId === artifactId &&
      event.payload.content !== undefined
    )
      content = event.payload.content;
  }
  return content;
}

export function repoArtifacts(events: readonly RunEvent[]): {
  xray: unknown;
  snapshot: unknown;
} {
  return { xray: lastContent(events, "repo-xray"), snapshot: lastContent(events, "repo-snapshot") };
}

function knownPath(snapshot: RepoSnapshotArtifact, path: string): boolean {
  if (snapshot.manifest.kept.some((file) => file.path === path)) return true;
  if (snapshot.manifest.listTruncated) return snapshot.files.some((file) => file.path === path);
  return false;
}

function knownModule(snapshot: RepoSnapshotArtifact, module: string): boolean {
  if (module === ".") return true;
  return snapshot.manifest.kept.some(
    (file) => file.path === module || file.path.startsWith(`${module}/`),
  );
}

export function citationsCheck(xray: RepoXray, snapshot: RepoSnapshotArtifact): GradedCheck {
  const citations = deliverableCitations(xray);
  const broken = citations.filter((citation) => !citationResolves(snapshot, citation));
  return {
    kind: "citations_resolve",
    severity: "hard",
    passed: citations.length > 0 && broken.length === 0,
    detail:
      broken.length === 0
        ? `${citations.length} citations resolve to stored lines`
        : `unresolved: ${broken.slice(0, 5).map(formatCitation).join(", ")}${broken.length > 5 ? ` and ${broken.length - 5} more` : ""}`,
  };
}

export function mermaidCheck(xray: RepoXray, snapshot: RepoSnapshotArtifact): GradedCheck {
  const diagram = xray.architecture.diagram;
  if (diagram === null)
    return { kind: "mermaid_nodes_real", severity: "hard", passed: false, detail: "no diagram" };
  const modules = new Set(xray.modules.map((module) => module.path));
  const fromText = mermaidNodeModules(diagram.mermaid);
  const declared = diagram.nodes.map((node) => node.module);
  const fake = [...new Set([...fromText, ...declared])].filter(
    (module) => !modules.has(module) || !knownModule(snapshot, module),
  );
  const ids = new Set(diagram.nodes.map((node) => node.id));
  const danglingEdges = diagram.edges.filter((edge) => !ids.has(edge.from) || !ids.has(edge.to));
  return {
    kind: "mermaid_nodes_real",
    severity: "hard",
    passed: fake.length === 0 && danglingEdges.length === 0 && fromText.length === declared.length,
    detail:
      fake.length === 0 && danglingEdges.length === 0
        ? `${declared.length} nodes, ${diagram.edges.length} edges, all real modules`
        : `not modules: ${fake.join(", ") || "none"}; dangling edges: ${danglingEdges.length}`,
  };
}

export function improvementsCheck(xray: RepoXray, snapshot: RepoSnapshotArtifact): GradedCheck {
  const problems: string[] = [];
  if (xray.improvements.length < 5 || xray.improvements.length > 8)
    problems.push(`${xray.improvements.length} improvements, expected 5 to 8`);
  for (const improvement of xray.improvements) {
    if (!RepoImprovementSchema.safeParse(improvement).success)
      problems.push(`${improvement.id} does not match RepoImprovementSchema`);
    const existing = improvement.files.filter((file) => knownPath(snapshot, file));
    if (existing.length === 0 && improvement.kind !== "test")
      problems.push(`${improvement.id} names no file from the snapshot`);
  }
  const ranks = xray.improvements.map((improvement) => improvement.rank);
  if (ranks.some((rank, index) => rank !== index + 1)) problems.push("ranks are not 1..n");
  return {
    kind: "improvements_valid",
    severity: "hard",
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${xray.improvements.length} valid improvements`
        : problems.join("; "),
  };
}

export function factFound(xray: RepoXray, fact: RepoExpectedFact): boolean {
  const value = fact.value.toLowerCase();
  const eq = (candidate: string) => candidate.toLowerCase() === value;
  switch (fact.kind) {
    case "language":
      return eq(xray.languages[0]?.language ?? "");
    case "test-framework":
      return xray.tests.frameworks.some((framework) => eq(framework.name));
    case "manifest":
      return xray.dependencies.manifests.some((manifest) => eq(manifest.path));
    case "ci":
      return xray.tests.ci.some((ci) => eq(ci.provider));
    case "entry-point":
      return xray.onboarding.entryPoints.some((entry) => eq(entry.path));
    case "dependency":
      return xray.dependencies.items.some((item) => eq(item.name));
    case "module":
      return xray.modules.some((module) => eq(module.path));
  }
}

export function gradeRepoXray(
  testCase: RepoXrayCase,
  artifacts: { xray: unknown; snapshot: unknown },
): RepoXrayGrade {
  const xray = RepoXraySchema.safeParse(artifacts.xray);
  const snapshot = RepoSnapshotArtifactSchema.safeParse(artifacts.snapshot);
  const schema: GradedCheck = {
    kind: "schema_valid",
    severity: "hard",
    passed: xray.success && snapshot.success && xray.data.status === "complete",
    ...(xray.success && snapshot.success
      ? {}
      : { detail: xray.success ? "snapshot artifact invalid" : "deliverable invalid" }),
  };
  if (!xray.success || !snapshot.success)
    return {
      caseId: testCase.id,
      checks: [schema],
      facts: testCase.expectedFacts.map((fact) => ({ id: fact.id, kind: fact.kind, found: false })),
      passed: false,
    };
  const facts = testCase.expectedFacts.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    found: factFound(xray.data, fact),
  }));
  const found = facts.filter((fact) => fact.found).length;
  const checks: GradedCheck[] = [
    schema,
    citationsCheck(xray.data, snapshot.data),
    mermaidCheck(xray.data, snapshot.data),
    improvementsCheck(xray.data, snapshot.data),
    {
      kind: "expected_facts",
      severity: "soft",
      passed: found === facts.length,
      detail: `${found}/${facts.length} expected facts found`,
    },
  ];
  return {
    caseId: testCase.id,
    checks,
    facts,
    passed: checks.every((check) => check.severity === "soft" || check.passed),
  };
}
