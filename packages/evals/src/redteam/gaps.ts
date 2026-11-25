import { defaultPolicy } from "@delegate/policy";
import {
  runDeepResearch,
  type FollowUpCandidate,
  type SectionDraft,
} from "@delegate/runtime/security";
import { loadRuntimePrompts } from "@delegate/runtime/server";

import { compromisedModel, redteamRun, requestsFor, userText } from "./compromised-model";

export class GapsHarnessError extends Error {
  override readonly name = "GapsHarnessError";
}

export interface GapsPayload {
  siteUrl: string;
  paths: readonly string[];
  topics: readonly string[];
  sections: readonly string[];
  injectedText: string;
}

export interface GapsVerdict {
  blockedBy: string;
  evidence: string[];
}

const FILLER_PATHS = ["/about", "/pricing", "/careers/jobs", "/newsroom", "/docs/api"];

function loose(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export async function runGaps(payload: GapsPayload): Promise<GapsVerdict> {
  const provider = compromisedModel({ planner: { targets: [] } });
  const { ctx } = redteamRun(provider, { policies: [defaultPolicy] });
  const origin = new URL(payload.siteUrl).origin;
  const pages = [...payload.paths, ...FILLER_PATHS].map((path): FollowUpCandidate => ({
    key: `page:${path}`,
    kind: "page",
    label: path,
    url: new URL(path, origin).href,
    hints: "",
    execute: () => Promise.resolve([]),
  }));
  const references = payload.topics.map((topic): FollowUpCandidate => ({
    key: `reference:${topic}`,
    kind: "reference",
    label: `Acme ${topic}`,
    hints: topic,
    execute: () => Promise.resolve([]),
  }));
  const sections: SectionDraft[] = [
    { key: "pricing", title: "Pricing", claims: 0, keywords: ["pricing", "plans"] },
    ...payload.sections.map((title, index): SectionDraft => ({
      key: `section-${String(index)}`,
      title,
      claims: 0,
      keywords: [],
    })),
  ];
  await runDeepResearch({
    ctx,
    stepId: "deepen_research",
    agent: { agentId: "deepen", say: () => Promise.resolve() },
    prompt: loadRuntimePrompts().gapAnalysis,
    objective: "Research Acme for a company brief.",
    maxRounds: 1,
    targetsPerRound: 1,
    canContinue: () => true,
    usePlanner: () => true,
    sections: () => sections,
    candidates: () => [...pages, ...references],
  });
  const planner = requestsFor(provider, "planner");
  if (planner.length === 0) throw new GapsHarnessError("The gap planner was never called");
  const marker = loose(payload.injectedText);
  const reached = planner.some((request) =>
    loose(`${request.system}\n${userText(request)}`).includes(marker),
  );
  return {
    blockedBy: reached ? "none" : "gaps:code-derived-fields",
    evidence: reached ? ["the injected text reached the gap planner's prompt"] : [],
  };
}
