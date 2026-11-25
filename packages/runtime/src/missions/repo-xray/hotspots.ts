import { type RepoAnalysis } from "./analysis";
import { headCitation, lineCitation } from "./evidence";
import { type RiskyKind } from "./scan";
import { type Hotspot } from "./schema";
import { type RepoSnapshot } from "./snapshot";

export const HOTSPOT_LIMITS = {
  risky: 10,
  secrets: 8,
  dependencies: 10,
  largeModuleLines: 800,
  largeModules: 3,
  todoCluster: 5,
  todoClusters: 3,
  total: 30,
} as const;

const RISKY_TEXT: Record<
  RiskyKind,
  { title: string; detail: string; severity: Hotspot["severity"] }
> = {
  eval: {
    title: "Dynamic code evaluation",
    detail:
      "eval() runs a string as code; if any part of it comes from input, it is code injection.",
    severity: "high",
  },
  "dynamic-function": {
    title: "Function constructor",
    detail: "new Function() compiles a string at runtime, with the same risks as eval().",
    severity: "medium",
  },
  "shell-exec": {
    title: "Shell command built at runtime",
    detail:
      "A shell command is assembled from variables or run with a shell; unescaped input becomes command injection.",
    severity: "high",
  },
  "sql-string-building": {
    title: "SQL built by string concatenation",
    detail:
      "A query string is concatenated or interpolated instead of using bound parameters, a classic SQL injection pattern.",
    severity: "high",
  },
  "unsafe-deserialisation": {
    title: "Unsafe deserialisation",
    detail:
      "pickle.load(s) or yaml.load without a safe loader can execute code from untrusted data.",
    severity: "high",
  },
  "html-injection": {
    title: "Raw HTML injection",
    detail:
      "innerHTML or dangerouslySetInnerHTML renders markup directly; unsanitised input becomes XSS.",
    severity: "medium",
  },
};

export function buildHotspots(snapshot: RepoSnapshot, analysis: RepoAnalysis): Hotspot[] {
  const hotspots: Hotspot[] = [];
  const risky = new Map<string, typeof analysis.risky>();
  for (const hit of analysis.risky) {
    const key = `${hit.kind}:${hit.path}`;
    risky.set(key, [...(risky.get(key) ?? []), hit]);
  }
  for (const [key, hits] of [...risky.entries()].slice(0, HOTSPOT_LIMITS.risky)) {
    const first = hits[0];
    if (first === undefined) continue;
    const text = RISKY_TEXT[first.kind];
    hotspots.push({
      id: `risky:${key}`.slice(0, 60),
      kind: "risky-pattern",
      severity: text.severity,
      title: `${text.title} in ${first.path}`,
      detail: `${text.detail} Found on ${hits.length === 1 ? "line" : "lines"} ${hits
        .map((hit) => hit.line)
        .slice(0, 5)
        .join(", ")}; review whether the input can be attacker-controlled.`,
      citations: hits.slice(0, 3).map((hit) => lineCitation(hit.path, hit.line)),
    });
  }
  const secretsByFile = new Map<string, typeof snapshot.secrets>();
  for (const secret of snapshot.secrets)
    secretsByFile.set(secret.path, [...(secretsByFile.get(secret.path) ?? []), secret]);
  for (const [path, secrets] of [...secretsByFile.entries()].slice(0, HOTSPOT_LIMITS.secrets)) {
    hotspots.push({
      id: `secret:${path}`.slice(0, 60),
      kind: "secret-like",
      severity: secrets.some((secret) => secret.kind !== "generic-assignment") ? "high" : "medium",
      title: `Secret-like value committed in ${path}`,
      detail: `${secrets.length} value${secrets.length === 1 ? "" : "s"} matching ${[...new Set(secrets.map((secret) => secret.kind))].join(", ")} patterns. Values are redacted here; if real, rotate them and move them to environment configuration.`,
      citations: secrets.slice(0, 3).map((secret) => lineCitation(path, secret.line)),
    });
  }
  for (const risk of analysis.dependencyRisks.slice(0, HOTSPOT_LIMITS.dependencies))
    hotspots.push({
      id: `dep:${risk.dependency.ecosystem}:${risk.dependency.name}`.slice(0, 60),
      kind: risk.kind,
      severity: risk.severity,
      title:
        risk.kind === "deprecated-dependency"
          ? `Deprecated dependency ${risk.dependency.name}`
          : `Unpinned dependency ${risk.dependency.name}`,
      detail: risk.reason,
      citations: [lineCitation(risk.dependency.manifest, risk.dependency.line)],
    });
  for (const file of analysis.largestFiles
    .filter((entry) => entry.lines >= HOTSPOT_LIMITS.largeModuleLines)
    .slice(0, HOTSPOT_LIMITS.largeModules)) {
    const importedBy =
      analysis.mostImported.find((entry) => entry.path === file.path)?.importedBy ?? 0;
    hotspots.push({
      id: `large:${file.path}`.slice(0, 60),
      kind: "large-module",
      severity: importedBy >= 5 ? "medium" : "low",
      title: `Large file ${file.path}`,
      detail: `${file.lines} lines${importedBy === 0 ? "" : `, imported by ${importedBy} files`}; large, widely used files concentrate change risk.`,
      citations: [headCitation(snapshot, file.path, 10)],
    });
  }
  const todosByFile = new Map<string, typeof analysis.todos.hits>();
  for (const hit of analysis.todos.hits)
    todosByFile.set(hit.path, [...(todosByFile.get(hit.path) ?? []), hit]);
  for (const [path, hits] of [...todosByFile.entries()]
    .filter(([, hits]) => hits.length >= HOTSPOT_LIMITS.todoCluster)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, HOTSPOT_LIMITS.todoClusters))
    hotspots.push({
      id: `todo:${path}`.slice(0, 60),
      kind: "todo-cluster",
      severity: hits.some((hit) => hit.marker === "FIXME" || hit.marker === "HACK")
        ? "medium"
        : "low",
      title: `${hits.length} TODO/FIXME markers in ${path}`,
      detail:
        "A cluster of open markers often points to known shortcuts or unfinished error handling.",
      citations: hits.slice(0, 3).map((hit) => lineCitation(hit.path, hit.line)),
    });
  const order = { high: 0, medium: 1, low: 2 };
  return hotspots
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, HOTSPOT_LIMITS.total);
}
