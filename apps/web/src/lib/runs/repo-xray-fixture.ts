import type { RepoXray } from "@delegate/runtime";

export const XRAY: RepoXray = {
  missionId: "repo-xray",
  status: "complete",
  repo: {
    owner: "acme",
    name: "widget",
    url: "https://github.com/acme/widget",
    ref: "HEAD",
    commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  },
  snapshot: {
    keptFiles: 4,
    skippedFiles: 1,
    skippedByReason: { lockfile: 1 },
    compressedBytes: 2048,
    uncompressedBytes: 8192,
    truncated: null,
    lockfiles: ["package-lock.json"],
    secretsRedacted: 0,
  },
  languages: [{ language: "TypeScript", bytes: 900, files: 3, share: 1 }],
  architecture: {
    summary: [
      {
        text: "src/cli.ts calls load in src/index.ts.",
        citations: [{ path: "src/cli.ts", startLine: 1, endLine: 1 }],
      },
    ],
    diagram: {
      mermaid: 'flowchart LR\n  m1["src/cli.ts"]\n  m2["src/index.ts"]\n  m3["src/parser.ts"]',
      nodes: [
        { id: "m1", module: "src/cli.ts", role: "CLI entry" },
        { id: "m2", module: "src/index.ts" },
        { id: "m3", module: "src/parser.ts" },
      ],
      edges: [
        { from: "m1", to: "m2", imports: 1 },
        { from: "m2", to: "m3", imports: 2 },
      ],
      source: "model",
    },
  },
  modules: [],
  onboarding: { steps: [], entryPoints: [] },
  dependencies: { total: 0, manifests: [], items: [] },
  hotspots: [
    {
      id: "risky:eval:src/io.ts",
      kind: "risky-pattern",
      severity: "high",
      title: "Dynamic code evaluation in src/io.ts",
      detail: "eval() runs a string as code.",
      citations: [{ path: "src/io.ts", startLine: 5, endLine: 5 }],
    },
  ],
  tests: { files: 0, frameworks: [], ci: [], gaps: [] },
  todos: { total: 0, byMarker: {} },
  improvements: [
    {
      id: "imp-1-remove-eval",
      rank: 1,
      title: "Remove eval from loadFile",
      rationale: "loadFile passes file contents to eval.",
      files: ["src/io.ts"],
      kind: "security",
      effort: "S",
      acceptance: ["src/io.ts no longer calls eval"],
      citations: [{ path: "src/io.ts", startLine: 5, endLine: 5 }],
    },
  ],
  verification: { citationsChecked: 1, citationsValid: 1, claimsDropped: 0, citationAccuracy: 1 },
  generatedAt: "2026-11-25T10:00:00.000Z",
  promptVersions: [],
};
