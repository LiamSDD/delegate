import { detectInjection, quoteAppearsIn } from "../../quarantine/reader";
import { isSafePath, isSafeScript, type RepoAnalysis, type RepoModule } from "./analysis";
import { type RepoTopic } from "./docs";
import { type Citation, MAX_CITATION_LINES } from "./schema";
import { fileLines, type RepoSnapshot } from "./snapshot";

export const EVIDENCE_LIMITS = {
  maxItems: 160,
  dependencies: 25,
  modules: 24,
  symbolFiles: 30,
  importEdges: 30,
} as const;

export type EvidenceKind =
  | "manifest"
  | "script"
  | "dependency"
  | "entry"
  | "module"
  | "symbols"
  | "import"
  | "test"
  | "ci"
  | "hotspot"
  | "gap"
  | "doc";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  citation: Citation;
  text: string;
  trust: "derived" | "untrusted";
  module?: string;
  quote?: string;
  topic?: RepoTopic;
}

export interface DocFact {
  path: string;
  claim: string;
  quote: string;
  topic: RepoTopic;
  startLine: number;
  endLine: number;
}

export interface EvidenceHotspot {
  title: string;
  detail: string;
  citation: Citation;
}

export function lineCitation(path: string, startLine: number, endLine = startLine): Citation {
  const start = Math.max(1, startLine);
  return {
    path,
    startLine: start,
    endLine: Math.min(Math.max(start, endLine), start + MAX_CITATION_LINES - 1),
  };
}

export function headCitation(snapshot: RepoSnapshot, path: string, lines = 20): Citation {
  const count = snapshot.files.get(path)?.lineCount ?? 1;
  return lineCitation(path, 1, Math.max(1, Math.min(count, lines)));
}

function safe(text: string): boolean {
  return detectInjection(text) === undefined;
}

function moduleText(module: RepoModule): string {
  const symbols = module.symbols
    .flatMap((entry) => entry.symbols.map((symbol) => symbol.name))
    .slice(0, 10);
  return [
    `Module ${module.id}: ${module.codeFiles} code file${module.codeFiles === 1 ? "" : "s"}, ${module.lines} lines`,
    module.imports.length === 0
      ? "imports no other module"
      : `imports ${module.imports.slice(0, 6).join(", ")}`,
    module.importedBy.length === 0
      ? "imported by no other module"
      : `imported by ${module.importedBy.slice(0, 6).join(", ")}`,
    `${module.testFiles.length} test file${module.testFiles.length === 1 ? "" : "s"} exercise it`,
    ...(symbols.length === 0 ? [] : [`defines ${symbols.join(", ")}`]),
  ].join("; ");
}

export function buildEvidence(
  snapshot: RepoSnapshot,
  analysis: RepoAnalysis,
  hotspots: readonly EvidenceHotspot[],
  docFacts: readonly DocFact[],
): Evidence[] {
  const items: Omit<Evidence, "id">[] = [];
  const add = (item: Omit<Evidence, "id">) => {
    if (!isSafePath(item.citation.path) || !snapshot.files.has(item.citation.path)) return;
    if (item.trust === "derived" && !safe(item.text)) return;
    items.push(item);
  };

  for (const manifest of analysis.manifests) {
    add({
      kind: "manifest",
      citation: lineCitation(manifest.path, manifest.nameLine || 1),
      text: `${manifest.path} is a ${manifest.ecosystem} manifest${manifest.name === null ? "" : ` for package ${manifest.name}`} declaring ${manifest.dependencies.length} dependencies`,
      trust: "derived",
    });
    for (const script of manifest.scripts
      .filter((entry) => isSafeScript(entry.command))
      .slice(0, 8))
      add({
        kind: "script",
        citation: lineCitation(manifest.path, script.line),
        text: `${manifest.path} defines script "${script.name}" which runs: ${script.command}`,
        trust: "derived",
      });
  }
  for (const dependency of analysis.dependencies
    .filter((entry) => entry.scope === "runtime")
    .slice(0, EVIDENCE_LIMITS.dependencies))
    add({
      kind: "dependency",
      citation: lineCitation(dependency.manifest, dependency.line),
      text: `Runtime dependency ${dependency.name} ${dependency.version} (${dependency.ecosystem}) declared in ${dependency.manifest}`,
      trust: "derived",
    });
  for (const entry of analysis.entryPoints)
    add({
      kind: "entry",
      citation:
        entry.declaredIn === null
          ? headCitation(snapshot, entry.path, 10)
          : lineCitation(entry.declaredIn.path, entry.declaredIn.line),
      text:
        entry.declaredIn === null
          ? `${entry.path} is a conventional entry point by its name and location`
          : `${entry.path} is the ${entry.kind} entry point declared in ${entry.declaredIn.path}`,
      trust: "derived",
      module: analysis.moduleOf.get(entry.path) ?? entry.path,
    });
  for (const module of analysis.modules.slice(0, EVIDENCE_LIMITS.modules)) {
    const anchor = module.symbols[0];
    const first = anchor?.symbols[0]?.line ?? 1;
    const last = anchor?.symbols.at(-1)?.line ?? 1;
    add({
      kind: "module",
      citation:
        anchor === undefined
          ? headCitation(snapshot, module.files[0] ?? module.id)
          : lineCitation(anchor.path, first, last),
      text: moduleText(module),
      trust: "derived",
      module: module.id,
    });
  }
  const symbolFiles = analysis.modules
    .flatMap((module) => module.symbols.map((entry) => ({ module: module.id, entry })))
    .filter(({ entry }) => entry.symbols.length > 0)
    .slice(0, EVIDENCE_LIMITS.symbolFiles);
  for (const { module, entry } of symbolFiles) {
    const first = entry.symbols[0]?.line ?? 1;
    const last = entry.symbols.at(-1)?.line ?? first;
    add({
      kind: "symbols",
      citation: lineCitation(entry.path, first, last),
      text: `${entry.path} defines ${entry.symbols.map((symbol) => `${symbol.name} (line ${symbol.line})`).join(", ")}`,
      trust: "derived",
      module,
    });
  }
  const moduleEdges = new Map<string, { from: string; to: string; line: number; count: number }>();
  for (const edge of analysis.graph.edges) {
    const from = analysis.moduleOf.get(edge.from);
    const to = analysis.moduleOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    const existing = moduleEdges.get(key);
    if (existing === undefined)
      moduleEdges.set(key, { from: edge.from, to: edge.to, line: edge.line, count: 1 });
    else existing.count += 1;
  }
  for (const edge of [...moduleEdges.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, EVIDENCE_LIMITS.importEdges))
    add({
      kind: "import",
      citation: lineCitation(edge.from, edge.line),
      text: `${edge.from} imports ${edge.to}`,
      trust: "derived",
      module: analysis.moduleOf.get(edge.from) ?? edge.from,
    });
  for (const framework of analysis.tests.frameworks)
    add({
      kind: "test",
      citation: lineCitation(framework.path, framework.line),
      text: `Test framework ${framework.name} (evidence in ${framework.path}); the repository has ${analysis.tests.files.length} test files`,
      trust: "derived",
    });
  for (const ci of analysis.ci)
    add({
      kind: "ci",
      citation:
        ci.testLine === null
          ? headCitation(snapshot, ci.path, 10)
          : lineCitation(ci.path, ci.testLine),
      text: `${ci.provider} configuration in ${ci.path}${ci.testLine === null ? " (no test command found)" : " runs the tests"}`,
      trust: "derived",
    });
  for (const hotspot of hotspots)
    add({
      kind: "hotspot",
      citation: hotspot.citation,
      text: `${hotspot.title}: ${hotspot.detail}`,
      trust: "derived",
    });
  for (const gap of analysis.gaps.slice(0, 12))
    add({
      kind: "gap",
      citation: headCitation(snapshot, gap.file),
      text: `No test file imports module ${gap.module} or shares a file name with it (${gap.lines} lines, imported by ${gap.importedBy} modules)`,
      trust: "derived",
      module: gap.module,
    });
  for (const fact of docFacts)
    add({
      kind: "doc",
      citation: lineCitation(fact.path, fact.startLine, fact.endLine),
      text: fact.claim,
      quote: fact.quote,
      topic: fact.topic,
      trust: "untrusted",
    });
  return items
    .slice(0, EVIDENCE_LIMITS.maxItems)
    .map((item, index) => ({ ...item, id: `E${index + 1}` }));
}

export function evidenceLine(item: Evidence): string {
  return JSON.stringify({
    id: item.id,
    kind: item.kind,
    ...(item.module === undefined ? {} : { module: item.module }),
    text: item.text,
    ...(item.quote === undefined ? {} : { quote: item.quote.slice(0, 240) }),
    trust: item.trust,
  });
}

export type CitationCheck =
  { ok: true } | { ok: false; reason: "unknown_path" | "out_of_range" | "quote_not_in_lines" };

export function checkCitation(
  snapshot: RepoSnapshot,
  citation: Citation,
  quote?: string,
): CitationCheck {
  const file = snapshot.files.get(citation.path);
  if (file === undefined) return { ok: false, reason: "unknown_path" };
  if (
    citation.startLine < 1 ||
    citation.endLine > file.lineCount ||
    citation.endLine < citation.startLine
  )
    return { ok: false, reason: "out_of_range" };
  if (
    quote !== undefined &&
    !quoteAppearsIn(
      quote,
      fileLines(file)
        .slice(citation.startLine - 1, citation.endLine)
        .join("\n"),
    )
  )
    return { ok: false, reason: "quote_not_in_lines" };
  return { ok: true };
}

export function resolveCitations(
  refs: readonly string[],
  evidence: ReadonlyMap<string, Evidence>,
): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const id = ref.trim().toUpperCase();
    if (evidence.has(id)) {
      if (!ids.includes(id)) ids.push(id);
    } else unknown.push(ref);
  }
  return { ids, unknown };
}
