export const DOC_SECTIONS = [
  { id: "start", title: "Start here" },
  { id: "guides", title: "Guides" },
  { id: "trust", title: "Trust" },
  { id: "evals", title: "Evals" },
  { id: "architecture", title: "Architecture" },
  { id: "api", title: "API" },
  { id: "case-study", title: "Case study" },
] as const;

export type DocSectionId = (typeof DOC_SECTIONS)[number]["id"];

export interface ManifestEntry {
  source: string;
  slug: readonly string[];
  section: DocSectionId;
  label: string;
  summary: string;
}

export const ADR_DIRECTORY = "docs/adr";
export const ADR_INDEX_SLUG = ["architecture", "adr"] as const;
export const GUIDES_DIRECTORY = "docs/guides";

export const DOC_MANIFEST: readonly ManifestEntry[] = [
  {
    source: "docs/guides/what-is-delegate.md",
    slug: [],
    section: "start",
    label: "What Delegate is",
    summary: "What the platform does, how a run works and where to go next.",
  },
  {
    source: "docs/guides/quickstart.md",
    slug: ["quickstart"],
    section: "start",
    label: "Try it in two minutes",
    summary: "Run a first mission on the live site, with no account and no key.",
  },
  {
    source: "docs/guides/missions.md",
    slug: ["missions"],
    section: "start",
    label: "Missions",
    summary: "Each mission's inputs, deliverable and limits, taken from the code.",
  },
  {
    source: "docs/guides/connect-mcp-clients.md",
    slug: ["guides", "mcp-clients"],
    section: "guides",
    label: "Connect Claude Code, Codex, Cursor and VS Code",
    summary: "Call Delegate from your coding agent over MCP with a workspace token.",
  },
  {
    source: "docs/guides/connect-mcp-servers.md",
    slug: ["guides", "mcp-servers"],
    section: "guides",
    label: "Connect your own MCP servers",
    summary: "Give runs access to your tools, with approvals for anything that writes.",
  },
  {
    source: "docs/guides/github-and-ship-a-pr.md",
    slug: ["guides", "ship-a-pr"],
    section: "guides",
    label: "Connect GitHub and Ship-a-PR",
    summary: "From a Repo X-ray improvement to an approved pull request or a patch.",
  },
  {
    source: "docs/guides/reading-a-run.md",
    slug: ["guides", "run-page"],
    section: "guides",
    label: "Reading a run page",
    summary: "Plan, agents, citations, replay, fork and compare, and where each comes from.",
  },
  {
    source: "docs/guides/run-locally.md",
    slug: ["guides", "run-locally"],
    section: "guides",
    label: "Run locally",
    summary: "pnpm dev with the built-in PGlite database; no accounts and no Docker.",
  },
  {
    source: "docs/guides/self-hosting.md",
    slug: ["guides", "self-hosting"],
    section: "guides",
    label: "Self-hosting",
    summary: "Your own Postgres with pgvector, migrations, roles and environment.",
  },
  {
    source: "docs/DEPLOY.md",
    slug: ["guides", "deploy"],
    section: "guides",
    label: "Deploy on Vercel and Neon",
    summary: "The production setup on two free tiers, including Ship-a-PR and connections.",
  },
  {
    source: "docs/SECURITY.md",
    slug: ["trust", "security"],
    section: "trust",
    label: "Security model",
    summary: "Assets, trust boundaries, controls with their tests, and the threat list.",
  },
  {
    source: "docs/guides/quarantined-reader.md",
    slug: ["trust", "quarantined-reader"],
    section: "trust",
    label: "Quarantined reader",
    summary: "How untrusted content is read without ever reaching an agent that has tools.",
  },
  {
    source: "docs/guides/policy-and-approvals.md",
    slug: ["trust", "policy-and-approvals"],
    section: "trust",
    label: "Policy and approvals",
    summary: "What is checked before every tool call, and what always waits for a person.",
  },
  {
    source: "docs/guides/red-team.md",
    slug: ["trust", "red-team"],
    section: "trust",
    label: "Red-team suite",
    summary: "The attack cases, how they run and the current result.",
  },
  {
    source: "docs/guides/privacy-and-retention.md",
    slug: ["trust", "privacy-and-retention"],
    section: "trust",
    label: "Privacy and retention",
    summary: "What is stored, what is redacted, who can read it and when it is deleted.",
  },
  {
    source: "docs/guides/evals.md",
    slug: ["evals"],
    section: "evals",
    label: "How evals work",
    summary: "How results are produced and how to read the scoreboard.",
  },
  {
    source: "packages/evals/datasets/README.md",
    slug: ["evals", "datasets"],
    section: "evals",
    label: "Datasets and statistics",
    summary: "Dataset format, checks, judges, calibration and the regression test.",
  },
  {
    source: "docs/ARCHITECTURE.md",
    slug: ["architecture"],
    section: "architecture",
    label: "Overview",
    summary: "System overview, runtime pipeline, security model, event stream and data model.",
  },
  {
    source: "packages/db/README.md",
    slug: ["architecture", "database"],
    section: "architecture",
    label: "Database and row-level security",
    summary: "Roles, locked-down write paths, retention and what the tests cover.",
  },
  {
    source: "docs/guides/decision-records.md",
    slug: [...ADR_INDEX_SLUG],
    section: "architecture",
    label: "Decision records",
    summary: "Every architecture decision record, with its status and date.",
  },
  {
    source: "docs/guides/rest-api.md",
    slug: ["api"],
    section: "api",
    label: "REST reference",
    summary: "The OpenAPI reference served by this deployment.",
  },
  {
    source: "docs/guides/api.md",
    slug: ["api", "guide"],
    section: "api",
    label: "REST API v1 and SDK",
    summary:
      "Bearer tokens, every operation, idempotency, pagination, events and the TypeScript SDK.",
  },
  {
    source: "docs/guides/cli.md",
    slug: ["api", "cli"],
    section: "api",
    label: "The delegate CLI",
    summary: "Start a mission from a terminal, watch it, decide its plan and fetch the result.",
  },
  {
    source: "docs/guides/webhooks.md",
    slug: ["api", "webhooks"],
    section: "api",
    label: "Webhooks",
    summary:
      "Signed notifications when a run finishes or needs a decision, and how to verify them.",
  },
  {
    source: "docs/CASE_STUDY.md",
    slug: ["case-study"],
    section: "case-study",
    label: "Built with Claude Code",
    summary: "How one engineer built Delegate with coding agents inside a harness.",
  },
];

export const SECTION_REDIRECTS: Readonly<Record<string, readonly string[]>> = {
  guides: ["guides", "mcp-clients"],
  trust: ["trust", "security"],
  start: [],
};
