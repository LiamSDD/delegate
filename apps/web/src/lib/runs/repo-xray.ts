import {
  type Citation,
  formatCitation,
  REPO_XRAY_KIND,
  type RepoXray,
  RepoXraySchema,
  type RunEvent,
} from "@delegate/runtime";

export const REPO_XRAY_MISSION_ID = "repo-xray";

export type RepoXrayDiagram = NonNullable<RepoXray["architecture"]["diagram"]>;

export interface RepoXrayView {
  xray: RepoXray | null;
  version: number;
  invalid: boolean;
}

export function repoXrayOf(events: readonly RunEvent[]): RepoXrayView {
  let artifactId: string | undefined;
  let content: unknown;
  let version = 0;
  for (const event of events) {
    if (event.type === "artifact.created" && event.payload.kind === REPO_XRAY_KIND) {
      artifactId = event.payload.artifactId;
      content = event.payload.content;
      version = event.payload.version;
    } else if (
      event.type === "artifact.updated" &&
      event.payload.artifactId === artifactId &&
      event.payload.content !== undefined
    ) {
      content = event.payload.content;
      version = event.payload.version;
    }
  }
  if (artifactId === undefined) return { xray: null, version: 0, invalid: false };
  const parsed = RepoXraySchema.safeParse(content);
  return parsed.success
    ? { xray: parsed.data, version, invalid: false }
    : { xray: null, version, invalid: true };
}

export function citationLabel(citation: Citation): string {
  return formatCitation(citation);
}

export function citationHref(xray: RepoXray, citation: Citation): string {
  const ref = xray.repo.commit ?? xray.repo.ref;
  const path = citation.path.split("/").map(encodeURIComponent).join("/");
  const lines =
    citation.startLine === citation.endLine
      ? `#L${citation.startLine}`
      : `#L${citation.startLine}-L${citation.endLine}`;
  return `https://github.com/${encodeURIComponent(xray.repo.owner)}/${encodeURIComponent(xray.repo.name)}/blob/${encodeURIComponent(ref)}/${path}${lines}`;
}

export interface DiagramNodeView {
  id: string;
  module: string;
  role: string | null;
  targets: { module: string; imports: number }[];
}

export function diagramLayers(diagram: RepoXrayDiagram): DiagramNodeView[][] {
  const moduleOf = new Map(diagram.nodes.map((node) => [node.id, node.module]));
  const outgoing = new Map<string, string[]>();
  for (const edge of diagram.edges)
    if (edge.from !== edge.to)
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const measure = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const below = (outgoing.get(id) ?? []).map((target) => measure(target) + 1);
    visiting.delete(id);
    const value = below.length === 0 ? 0 : Math.max(...below);
    depth.set(id, value);
    return value;
  };
  for (const node of diagram.nodes) measure(node.id);
  const maxDepth = Math.max(0, ...depth.values());
  const layers: DiagramNodeView[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const node of diagram.nodes) {
    const layer = maxDepth - (depth.get(node.id) ?? 0);
    layers[layer]?.push({
      id: node.id,
      module: node.module,
      role: node.role ?? null,
      targets: diagram.edges
        .filter((edge) => edge.from === node.id)
        .flatMap((edge) => {
          const target = moduleOf.get(edge.to);
          return target === undefined ? [] : [{ module: target, imports: edge.imports }];
        }),
    });
  }
  return layers.filter((layer) => layer.length > 0);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export const SKIP_REASON_LABELS: Record<string, string> = {
  vendored: "vendored",
  build_output: "build output",
  lockfile: "lockfile bodies",
  binary: "binary",
  generated: "generated",
  too_large: "over 256 KB",
  not_regular_file: "links and special files",
  unsafe_path: "unsafe paths",
  snapshot_cap: "over the snapshot cap",
};
