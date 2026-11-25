import { CAPABILITIES } from "@delegate/policy";

import { type PlanStep } from "../../events";

export const BUILD_AGENT_STEP_IDS = {
  crawl: "crawl",
  index: "index",
  design: "design",
  evalset: "evalset",
  evaluate: "evaluate",
  gaps: "gaps",
} as const;

export const BUILD_AGENT_PLANNING_HINTS =
  "Crawl the company's own site (same domain, sitemap first, robots.txt, page and byte caps), index it (chunks, full-text, embeddings when available, injection flags), design the assistant from the goal and the indexed evidence, generate a grounded eval set, run the assistant on it and grade it, then report gaps. The steps form a chain; keep the order.";

export function buildAgentPlan(): PlanStep[] {
  const ids = BUILD_AGENT_STEP_IDS;
  return [
    {
      id: ids.crawl,
      role: "researcher",
      objective:
        "Crawl the public site: same registrable domain, sitemap first then internal links, robots.txt, 1 request per second, at most 60 pages and 5 MB, no binaries.",
      inputs: [],
      capabilities: [CAPABILITIES.webFetch],
      acceptance: [
        "robots.txt, scope and caps respected",
        "Every page stored as a public document",
      ],
      budgetShare: 0.05,
    },
    {
      id: ids.index,
      role: "builder",
      objective:
        "Index the corpus: heading-aware chunks with full-text search, embeddings when a provider is available, and suspected prompt injection flagged and excluded.",
      inputs: [ids.crawl],
      capabilities: [CAPABILITIES.artifactWrite],
      acceptance: ["Every chunk is searchable", "Suspicious chunks are flagged"],
      budgetShare: 0.05,
    },
    {
      id: ids.design,
      role: "builder",
      objective:
        "Design the assistant from the goal and the site's evidence: persona, scope, refusal policy and starter questions.",
      inputs: [ids.index],
      capabilities: [CAPABILITIES.artifactWrite],
      acceptance: ["Scope matches the goal", "Starter questions are answerable from the site"],
      budgetShare: 0.15,
    },
    {
      id: ids.evalset,
      role: "analyst",
      objective:
        "Write 10–15 eval cases grounded in indexed chunks, each with an expected answer and citation, plus a few questions the site cannot answer.",
      inputs: [ids.design],
      capabilities: [CAPABILITIES.artifactWrite],
      acceptance: ["Every grounded case quotes its chunk verbatim"],
      budgetShare: 0.2,
    },
    {
      id: ids.evaluate,
      role: "critic",
      objective:
        "Run the assistant on its eval set and grade each answer's citations for entailment; report the pass rate.",
      inputs: [ids.evalset],
      capabilities: [CAPABILITIES.artifactWrite],
      acceptance: ["Every case graded", "Pass rate reported"],
      budgetShare: 0.35,
    },
    {
      id: ids.gaps,
      role: "editor",
      objective:
        "Report gaps: questions the site cannot answer, topics with thin coverage and contradictions between pages.",
      inputs: [ids.evaluate],
      capabilities: [CAPABILITIES.artifactWrite],
      acceptance: ["Every gap cites evidence or states that none exists"],
      budgetShare: 0.15,
    },
  ];
}
