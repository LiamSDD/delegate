import {
  type AutomationAudit,
  AutomationAuditSchema,
  estimateRoi,
  type Opportunity,
  ROI_INPUT_KEYS,
  type RoiEstimate,
  type RoiInputKey,
  type RoiInputs,
  type RoiOverrides,
} from "@/lib/m2-contract";

export type RoiTotals = Pick<RoiEstimate, "hoursPerMonth" | "eurPerMonth">;

export type AuditOverrides = Readonly<Record<string, RoiOverrides | undefined>>;

export type ParsedAudit = { ok: true; audit: AutomationAudit } | { ok: false; issues: string[] };

function isSafeHref(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function parseAudit(content: unknown): ParsedAudit {
  const result = AutomationAuditSchema.safeParse(content);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const unsafe = result.data.sources.filter((source) => !isSafeHref(source.url));
  if (unsafe.length > 0) {
    return {
      ok: false,
      issues: unsafe.slice(0, 5).map((source) => `sources.${source.sourceId}: URL must be http(s)`),
    };
  }
  return { ok: true, audit: result.data };
}

export function roiInputs(opportunity: Opportunity, overrides: RoiOverrides = {}): RoiInputs {
  const inputs = {} as RoiInputs;
  for (const key of ROI_INPUT_KEYS) inputs[key] = overrides[key] ?? opportunity[key];
  return inputs;
}

export interface RankedOpportunity {
  rank: number;
  opportunity: Opportunity;
  inputs: RoiInputs;
  estimate: RoiEstimate;
  modelEstimate: RoiEstimate;
  edited: boolean;
}

export function rankedOpportunities(
  audit: AutomationAudit,
  overrides: AuditOverrides,
): RankedOpportunity[] {
  return audit.opportunities
    .map((opportunity, index) => {
      const own = overrides[opportunity.id] ?? {};
      const inputs = roiInputs(opportunity, own);
      return {
        index,
        opportunity,
        inputs,
        estimate: estimateRoi(opportunity, own),
        modelEstimate: estimateRoi(opportunity),
        edited: ROI_INPUT_KEYS.some(
          (key) => own[key] !== undefined && own[key] !== opportunity[key],
        ),
      };
    })
    .sort((a, b) => b.estimate.eurPerMonth - a.estimate.eurPerMonth || a.index - b.index)
    .map(({ index: _index, ...entry }, position) => ({ rank: position + 1, ...entry }));
}

export function portfolioTotal(audit: AutomationAudit, overrides: AuditOverrides): RoiTotals {
  return audit.opportunities.reduce<RoiTotals>(
    (total, opportunity) => {
      const estimate = estimateRoi(opportunity, overrides[opportunity.id] ?? {});
      return {
        hoursPerMonth: total.hoursPerMonth + estimate.hoursPerMonth,
        eurPerMonth: total.eurPerMonth + estimate.eurPerMonth,
      };
    },
    { hoursPerMonth: 0, eurPerMonth: 0 },
  );
}

const oneDecimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const wholeEuro = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

export function formatHours(hours: number): string {
  return oneDecimal.format(hours);
}

export function formatEur(eur: number): string {
  return `€${wholeEuro.format(eur)}`;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formulaWithValues(opportunity: Opportunity, overrides: RoiOverrides = {}): string {
  const inputs = roiInputs(opportunity, overrides);
  const estimate = estimateRoi(opportunity, overrides);
  return [
    `${oneDecimal.format(inputs.frequencyPerMonth)}/mo`,
    `× ${oneDecimal.format(inputs.minutesPerTask)} min`,
    `× ${oneDecimal.format(inputs.peopleInvolved)} ${inputs.peopleInvolved === 1 ? "person" : "people"}`,
    `× ${formatPercent(inputs.adoptionRate)} ÷ 60`,
    `= ${formatHours(estimate.hoursPerMonth)} h/mo`,
    `× €${oneDecimal.format(inputs.hourlyCostEur)}/h`,
    `= ${formatEur(estimate.eurPerMonth)}/mo`,
  ].join(" ");
}

export interface SliderSpec {
  key: RoiInputKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}

export function sliderSpecs(opportunity: Opportunity): SliderSpec[] {
  const ceiling = (value: number, floor: number) => Math.max(floor, Math.ceil(value * 3));
  return [
    {
      key: "frequencyPerMonth",
      label: "Frequency per month",
      min: 0,
      max: ceiling(opportunity.frequencyPerMonth, 50),
      step: 1,
      format: (value) => `${oneDecimal.format(value)}/mo`,
    },
    {
      key: "minutesPerTask",
      label: "Minutes per task",
      min: 0,
      max: ceiling(opportunity.minutesPerTask, 30),
      step: 1,
      format: (value) => `${oneDecimal.format(value)} min`,
    },
    {
      key: "peopleInvolved",
      label: "People involved",
      min: 0,
      max: ceiling(opportunity.peopleInvolved, 10),
      step: 1,
      format: (value) => oneDecimal.format(value),
    },
    {
      key: "adoptionRate",
      label: "Adoption",
      min: 0,
      max: 1,
      step: 0.05,
      format: formatPercent,
    },
    {
      key: "hourlyCostEur",
      label: "Hourly cost",
      min: 0,
      max: ceiling(opportunity.hourlyCostEur, 150),
      step: 1,
      format: (value) => `€${oneDecimal.format(value)}`,
    },
  ];
}

function sourceNumbers(audit: AutomationAudit): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const opportunity of audit.opportunities) {
    for (const evidence of opportunity.evidence) {
      for (const id of evidence.citations) {
        if (!numbers.has(id) && audit.sources.some((source) => source.sourceId === id)) {
          numbers.set(id, numbers.size + 1);
        }
      }
    }
  }
  return numbers;
}

export function auditCitationNumbers(audit: AutomationAudit): Map<string, number> {
  return sourceNumbers(audit);
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

export function auditToMarkdown(
  audit: AutomationAudit,
  overrides: AuditOverrides,
  heading: string,
): string {
  const numbers = sourceNumbers(audit);
  const total = portfolioTotal(audit, overrides);
  const lines = [
    `# ${escapeMarkdown(heading)}`,
    "",
    escapeMarkdown(audit.summary),
    "",
    `**Portfolio estimate:** ${formatHours(total.hoursPerMonth)} hours and ${formatEur(total.eurPerMonth)} per month. These are estimates from the formula below, not measured savings.`,
    "",
    `Formula: ${escapeMarkdown(audit.formula)}`,
    "",
  ];
  for (const entry of rankedOpportunities(audit, overrides)) {
    const { opportunity } = entry;
    lines.push(
      `## ${entry.rank}. ${escapeMarkdown(opportunity.title)}`,
      "",
      `- **Department:** ${escapeMarkdown(opportunity.department)}`,
      `- **Difficulty:** ${opportunity.difficulty}`,
      `- **Estimate:** ${formatHours(entry.estimate.hoursPerMonth)} h/month, ${formatEur(entry.estimate.eurPerMonth)}/month (${formulaWithValues(opportunity, overrides[opportunity.id])})`,
      `- **Today:** ${escapeMarkdown(opportunity.workflow)}`,
      `- **With automation:** ${escapeMarkdown(opportunity.automation)}`,
      `- **First step:** ${escapeMarkdown(opportunity.firstStep)}`,
    );
    if (opportunity.integrations.length > 0) {
      lines.push(`- **Integrations:** ${opportunity.integrations.map(escapeMarkdown).join(", ")}`);
    }
    if (opportunity.evidence.length > 0) {
      lines.push("", "Evidence:", "");
      for (const evidence of opportunity.evidence) {
        const marks = evidence.citations
          .map((id) => numbers.get(id))
          .filter((number) => number !== undefined)
          .map((number) => `[${number}]`)
          .join("");
        lines.push(`- ${escapeMarkdown(evidence.text)}${marks === "" ? "" : ` ${marks}`}`);
      }
    }
    if (opportunity.risks.length > 0) {
      lines.push("", "Risks:", "", ...opportunity.risks.map((risk) => `- ${escapeMarkdown(risk)}`));
    }
    if (opportunity.assumptions.length > 0) {
      lines.push(
        "",
        "Assumptions:",
        "",
        ...opportunity.assumptions.map((item) => `- ${escapeMarkdown(item)}`),
      );
    }
    lines.push("");
  }
  if (numbers.size > 0) {
    lines.push("## Sources", "");
    for (const [id, number] of numbers) {
      const source = audit.sources.find((entry) => entry.sourceId === id);
      if (source === undefined) continue;
      lines.push(`${number}. [${escapeMarkdown(source.title || source.url)}](${source.url})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function csvCell(value: string | number): string {
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function auditToCsv(audit: AutomationAudit, overrides: AuditOverrides): string {
  const header = [
    "rank",
    "id",
    "title",
    "department",
    "difficulty",
    "frequency_per_month",
    "minutes_per_task",
    "people_involved",
    "adoption_rate",
    "hourly_cost_eur",
    "hours_per_month",
    "eur_per_month",
  ];
  const rows = rankedOpportunities(audit, overrides).map((entry) =>
    [
      entry.rank,
      entry.opportunity.id,
      entry.opportunity.title,
      entry.opportunity.department,
      entry.opportunity.difficulty,
      entry.inputs.frequencyPerMonth,
      entry.inputs.minutesPerTask,
      entry.inputs.peopleInvolved,
      entry.inputs.adoptionRate,
      entry.inputs.hourlyCostEur,
      entry.estimate.hoursPerMonth,
      entry.estimate.eurPerMonth,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export interface CitationCheck {
  total: number;
  resolved: number;
}

export function auditCitationCheck(audit: AutomationAudit): CitationCheck {
  const known = new Set(audit.sources.map((source) => source.sourceId));
  const citations = audit.opportunities.flatMap((opportunity) =>
    opportunity.evidence.flatMap((evidence) => evidence.citations),
  );
  return { total: citations.length, resolved: citations.filter((id) => known.has(id)).length };
}
