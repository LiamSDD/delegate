import { type GoalBriefDraft, GoalBriefDraftSchema } from "@/lib/m2-contract";

import { type CitationTarget } from "./brief";

export type ParsedGoalBrief = { ok: true; brief: GoalBriefDraft } | { ok: false; issues: string[] };

function isSafeHref(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function parseGoalBrief(content: unknown): ParsedGoalBrief {
  const result = GoalBriefDraftSchema.safeParse(content);
  if (!result.success)
    return {
      ok: false,
      issues: result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  const unsafe = result.data.sources.filter((source) => !isSafeHref(source.url));
  if (unsafe.length > 0)
    return {
      ok: false,
      issues: unsafe.slice(0, 5).map((source) => `sources.${source.sourceId}: URL must be http(s)`),
    };
  return { ok: true, brief: result.data };
}

export function goalCitationIndex(brief: GoalBriefDraft): Map<string, CitationTarget> {
  const byId = new Map(brief.sources.map((source) => [source.sourceId, source]));
  const index = new Map<string, CitationTarget>();
  const claims = [
    ...brief.workstreams.flatMap((stream) => stream.findings),
    ...brief.actions.map((action) => action.basis),
    ...brief.risks,
  ];
  for (const claim of claims)
    for (const sourceId of claim.citations) {
      if (index.has(sourceId)) continue;
      const source = byId.get(sourceId) ?? null;
      let host: string | null = null;
      if (source !== null)
        try {
          host = new URL(source.url).hostname.replace(/^www\./, "");
        } catch {
          host = null;
        }
      index.set(sourceId, { number: index.size + 1, source, sourceId, host });
    }
  return index;
}

const LEVEL_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;

export function levelLabel(level: keyof typeof LEVEL_LABEL): string {
  return LEVEL_LABEL[level];
}

export function goalBriefToMarkdown(brief: GoalBriefDraft): string {
  const numbers = goalCitationIndex(brief);
  const marks = (citations: readonly string[]) =>
    citations
      .map((id) => numbers.get(id)?.number)
      .filter((n): n is number => n !== undefined)
      .map((n) => `[${n}]`)
      .join("");
  const lines = [`# Goal brief`, "", `**Objective:** ${brief.objective}`, ""];
  if (brief.company !== null)
    lines.push(`**Company:** ${brief.company.name} (${brief.company.url})`, "");
  for (const stream of brief.workstreams) {
    lines.push(`## ${stream.name}`, "");
    for (const finding of stream.findings)
      lines.push(`- ${finding.text} ${marks(finding.citations)}`);
    lines.push("");
  }
  if (brief.actions.length > 0) {
    lines.push("## Action plan", "", `_${brief.rankFormula}_`, "");
    for (const action of brief.actions)
      lines.push(
        `${action.rank}. **${action.title}** (owner: ${action.owner}; effort ${action.effort}; impact ${action.impact}${action.mission === null ? "" : `; mission ${action.mission}`}): ${action.basis.text} ${marks(action.basis.citations)}`,
      );
    lines.push("");
  }
  if (brief.risks.length > 0) {
    lines.push("## Risks", "");
    for (const risk of brief.risks) lines.push(`- ${risk.text} ${marks(risk.citations)}`);
    lines.push("");
  }
  if (brief.openQuestions.length > 0) {
    lines.push("## Open questions", "");
    for (const question of brief.openQuestions) lines.push(`- ${question}`);
    lines.push("");
  }
  lines.push("## Sources", "");
  for (const source of brief.sources)
    lines.push(`${numbers.get(source.sourceId)?.number ?? "-"}. ${source.title} — ${source.url}`);
  return `${lines.join("\n").trim()}\n`;
}
