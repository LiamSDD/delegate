import { detectInjection } from "../../quarantine/reader";
import { type RepoAnalysis } from "./analysis";
import { type Diagram } from "./schema";

export const DIAGRAM_LIMITS = { maxNodes: 14, defaultNodes: 12, maxEdges: 40 } as const;

const ROLE = /^[\w ./()&,+-]{1,40}$/;

export interface NodePick {
  module: string;
  role?: string | undefined;
}

function cleanRole(role: string | undefined): string | undefined {
  const text = role?.trim().replace(/\s+/g, " ");
  if (text === undefined || text === "" || !ROLE.test(text)) return undefined;
  return detectInjection(text) === undefined ? text : undefined;
}

function label(module: string, role: string | undefined): string {
  const name = module === "." ? "(repository root)" : module;
  return (role === undefined ? name : `${name}<br/>${role}`).replace(/"/g, "'");
}

function moduleEdges(analysis: RepoAnalysis): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of analysis.graph.edges) {
    const from = analysis.moduleOf.get(edge.from);
    const to = analysis.moduleOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function defaultPicks(analysis: RepoAnalysis): NodePick[] {
  return [...analysis.modules]
    .sort(
      (a, b) =>
        b.importedBy.length + b.imports.length - (a.importedBy.length + a.imports.length) ||
        b.lines - a.lines,
    )
    .slice(0, DIAGRAM_LIMITS.defaultNodes)
    .map((module) => ({ module: module.id }));
}

export function buildDiagram(
  analysis: RepoAnalysis,
  picks: readonly NodePick[],
  source: Diagram["source"],
): { diagram: Diagram | null; rejected: string[] } {
  const known = new Set(analysis.modules.map((module) => module.id));
  const rejected: string[] = [];
  const nodes: Diagram["nodes"] = [];
  for (const pick of picks) {
    if (!known.has(pick.module)) {
      rejected.push(pick.module);
      continue;
    }
    if (nodes.some((node) => node.module === pick.module)) continue;
    if (nodes.length >= DIAGRAM_LIMITS.maxNodes) break;
    const role = cleanRole(pick.role);
    nodes.push({
      id: `m${nodes.length + 1}`,
      module: pick.module,
      ...(role === undefined ? {} : { role }),
    });
  }
  if (nodes.length === 0) return { diagram: null, rejected };
  const idOf = new Map(nodes.map((node) => [node.module, node.id]));
  const edges: Diagram["edges"] = [];
  for (const [key, imports] of [...moduleEdges(analysis).entries()].sort((a, b) => b[1] - a[1])) {
    const [from = "", to = ""] = key.split("\u0000");
    const fromId = idOf.get(from);
    const toId = idOf.get(to);
    if (fromId === undefined || toId === undefined) continue;
    if (edges.length >= DIAGRAM_LIMITS.maxEdges) break;
    edges.push({ from: fromId, to: toId, imports });
  }
  const mermaid = [
    "flowchart LR",
    ...nodes.map((node) => `  ${node.id}["${label(node.module, node.role)}"]`),
    ...edges.map((edge) => `  ${edge.from} -->|${edge.imports}| ${edge.to}`),
  ].join("\n");
  return { diagram: { mermaid, nodes, edges, source }, rejected };
}

export function mermaidNodeModules(mermaid: string): string[] {
  return [...mermaid.matchAll(/^\s*m\d+\["([^"<]+)/gm)].map((match) =>
    (match[1] ?? "") === "(repository root)" ? "." : (match[1] ?? ""),
  );
}
