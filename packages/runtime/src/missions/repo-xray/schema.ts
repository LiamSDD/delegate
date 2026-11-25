import { z } from "zod";

export const REPO_XRAY_KIND = "repo-xray";
export const REPO_SNAPSHOT_KIND = "repo-snapshot";
export const MAX_CITATION_LINES = 80;

export const CitationSchema = z
  .object({
    path: z.string().min(1).max(300),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  })
  .refine((citation) => citation.endLine >= citation.startLine, "endLine before startLine")
  .refine(
    (citation) => citation.endLine - citation.startLine < MAX_CITATION_LINES,
    `A citation spans at most ${MAX_CITATION_LINES} lines`,
  );
export type Citation = z.infer<typeof CitationSchema>;

export function formatCitation(citation: Citation): string {
  return citation.startLine === citation.endLine
    ? `${citation.path}:${citation.startLine}`
    : `${citation.path}:${citation.startLine}-${citation.endLine}`;
}

export function parseCitationRef(ref: string): Citation | null {
  const match = /^(.+?):L?(\d+)(?:-L?(\d+))?$/.exec(ref.trim());
  if (match === null) return null;
  const parsed = CitationSchema.safeParse({
    path: match[1],
    startLine: Number(match[2]),
    endLine: Number(match[3] ?? match[2]),
  });
  return parsed.success ? parsed.data : null;
}

export const RepoClaimSupportSchema = z.enum(["weak", "unverified"]);

export const CitedClaimSchema = z.object({
  text: z.string().trim().min(1).max(600),
  citations: z.array(CitationSchema).min(1).max(6),
  support: RepoClaimSupportSchema.optional(),
});
export type CitedClaim = z.infer<typeof CitedClaimSchema>;

export const IMPROVEMENT_KINDS = [
  "test",
  "bugfix",
  "refactor",
  "docs",
  "deps",
  "security",
] as const;
export const IMPROVEMENT_EFFORTS = ["S", "M"] as const;

export const RepoImprovementSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(600),
  files: z.array(z.string().min(1).max(300)).min(1).max(10),
  kind: z.enum(IMPROVEMENT_KINDS),
  effort: z.enum(IMPROVEMENT_EFFORTS),
  acceptance: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
});
export type RepoImprovement = z.infer<typeof RepoImprovementSchema>;

export const RankedImprovementSchema = RepoImprovementSchema.extend({
  rank: z.int().min(1),
  citations: z.array(CitationSchema).min(1).max(6),
  support: RepoClaimSupportSchema.optional(),
});
export type RankedImprovement = z.infer<typeof RankedImprovementSchema>;

export const HOTSPOT_KINDS = [
  "deprecated-dependency",
  "unpinned-dependency",
  "risky-pattern",
  "secret-like",
  "large-module",
  "todo-cluster",
] as const;
export const SEVERITIES = ["low", "medium", "high"] as const;

export const HotspotSchema = z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(HOTSPOT_KINDS),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(500),
  citations: z.array(CitationSchema).min(1).max(6),
});
export type Hotspot = z.infer<typeof HotspotSchema>;

export const DiagramSchema = z.object({
  mermaid: z.string().min(1).max(8_000),
  nodes: z
    .array(
      z.object({
        id: z.string().regex(/^m\d{1,3}$/),
        module: z.string().min(1).max(300),
        role: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(16),
  edges: z
    .array(
      z.object({
        from: z.string().regex(/^m\d{1,3}$/),
        to: z.string().regex(/^m\d{1,3}$/),
        imports: z.int().min(1),
      }),
    )
    .max(60),
  source: z.enum(["model", "import-graph"]),
});
export type Diagram = z.infer<typeof DiagramSchema>;

export const RepoModuleSchema = z.object({
  path: z.string().min(1).max(300),
  files: z.int().nonnegative(),
  lines: z.int().nonnegative(),
  imports: z.array(z.string()).max(40),
  importedBy: z.int().nonnegative(),
  tests: z.int().nonnegative(),
  responsibility: CitedClaimSchema.nullable(),
});

export const TestGapSchema = z.object({
  module: z.string().min(1).max(300),
  file: z.string().min(1).max(300),
  lines: z.int().nonnegative(),
  importedBy: z.int().nonnegative(),
  citation: CitationSchema,
});

export const RepoXraySchema = z.object({
  missionId: z.literal("repo-xray"),
  status: z.enum(["draft", "complete"]),
  repo: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    url: z.url(),
    ref: z.string().min(1),
    commit: z.string().nullable(),
  }),
  snapshot: z.object({
    keptFiles: z.int().nonnegative(),
    skippedFiles: z.int().nonnegative(),
    skippedByReason: z.record(z.string(), z.int().nonnegative()),
    compressedBytes: z.int().nonnegative(),
    uncompressedBytes: z.int().nonnegative(),
    truncated: z.enum(["uncompressed_cap", "entry_cap"]).nullable(),
    lockfiles: z.array(z.string()).max(50),
    secretsRedacted: z.int().nonnegative(),
  }),
  languages: z
    .array(
      z.object({
        language: z.string(),
        bytes: z.int().nonnegative(),
        files: z.int().nonnegative(),
        share: z.number().min(0).max(1),
      }),
    )
    .max(30),
  architecture: z.object({
    summary: z.array(CitedClaimSchema).max(6),
    diagram: DiagramSchema.nullable(),
  }),
  modules: z.array(RepoModuleSchema).max(40),
  onboarding: z.object({
    steps: z.array(z.object({ title: z.string().min(1).max(120), claim: CitedClaimSchema })).max(8),
    entryPoints: z
      .array(z.object({ path: z.string(), kind: z.string(), citation: CitationSchema }))
      .max(12),
  }),
  dependencies: z.object({
    total: z.int().nonnegative(),
    manifests: z
      .array(
        z.object({
          path: z.string(),
          ecosystem: z.string(),
          name: z.string().nullable(),
          dependencies: z.int().nonnegative(),
        }),
      )
      .max(40),
    items: z
      .array(
        z.object({
          name: z.string(),
          version: z.string(),
          ecosystem: z.string(),
          scope: z.string(),
          citation: CitationSchema,
        }),
      )
      .max(200),
  }),
  hotspots: z.array(HotspotSchema).max(40),
  tests: z.object({
    files: z.int().nonnegative(),
    frameworks: z.array(z.object({ name: z.string(), citation: CitationSchema })).max(12),
    ci: z
      .array(z.object({ provider: z.string(), path: z.string(), citation: CitationSchema }))
      .max(12),
    gaps: z.array(TestGapSchema).max(20),
  }),
  todos: z.object({ total: z.int().nonnegative(), byMarker: z.record(z.string(), z.int()) }),
  improvements: z.array(RankedImprovementSchema).max(8),
  verification: z.object({
    citationsChecked: z.int().nonnegative(),
    citationsValid: z.int().nonnegative(),
    claimsDropped: z.int().nonnegative(),
    citationAccuracy: z.number().min(0).max(1).nullable(),
  }),
  generatedAt: z.iso.datetime({ offset: true }),
  promptVersions: z.array(z.string()),
});
export type RepoXray = z.infer<typeof RepoXraySchema>;

export const SnapshotFileSchema = z.object({
  path: z.string().min(1).max(300),
  bytes: z.int().nonnegative(),
  lineCount: z.int().nonnegative(),
  text: z.string().optional(),
  excerpts: z.array(z.object({ startLine: z.int().min(1), lines: z.array(z.string()) })),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const RepoSnapshotArtifactSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  commit: z.string().nullable(),
  files: z.array(SnapshotFileSchema).max(200),
  manifest: z.object({
    keptTotal: z.int().nonnegative(),
    skippedTotal: z.int().nonnegative(),
    kept: z.array(z.object({ path: z.string(), bytes: z.int(), lines: z.int() })),
    skipped: z.array(z.object({ path: z.string(), reason: z.string(), bytes: z.int() })),
    listTruncated: z.boolean(),
  }),
});
export type RepoSnapshotArtifact = z.infer<typeof RepoSnapshotArtifactSchema>;

export function citationResolves(snapshot: RepoSnapshotArtifact, citation: Citation): boolean {
  const file = snapshot.files.find((candidate) => candidate.path === citation.path);
  if (file === undefined) return false;
  if (citation.startLine < 1 || citation.endLine > file.lineCount) return false;
  if (file.text !== undefined) return true;
  return file.excerpts.some(
    (excerpt) =>
      excerpt.startLine <= citation.startLine &&
      excerpt.startLine + excerpt.lines.length - 1 >= citation.endLine,
  );
}

export function deliverableCitations(xray: RepoXray): Citation[] {
  const claims = (claim: CitedClaim | null) => claim?.citations ?? [];
  return [
    ...xray.architecture.summary.flatMap(claims),
    ...xray.modules.flatMap((module) => claims(module.responsibility)),
    ...xray.onboarding.steps.flatMap((step) => step.claim.citations),
    ...xray.onboarding.entryPoints.map((entry) => entry.citation),
    ...xray.dependencies.items.map((item) => item.citation),
    ...xray.hotspots.flatMap((hotspot) => hotspot.citations),
    ...xray.tests.frameworks.map((framework) => framework.citation),
    ...xray.tests.ci.map((ci) => ci.citation),
    ...xray.tests.gaps.map((gap) => gap.citation),
    ...xray.improvements.flatMap((improvement) => improvement.citations),
  ];
}
