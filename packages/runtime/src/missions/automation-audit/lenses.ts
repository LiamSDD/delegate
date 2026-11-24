export interface AuditLens {
  id: "ops" | "sales" | "finance" | "engineering";
  stepId: string;
  department: string;
  focus: string;
  topics: readonly string[];
  defaultHourlyCostEur: number;
  keywords: RegExp;
}

export const AUDIT_LENSES: readonly AuditLens[] = [
  {
    id: "ops",
    stepId: "analyse_ops",
    department: "Operations",
    focus:
      "operations, fulfilment, logistics, scheduling, partner and supplier coordination, onboarding, compliance and quality processes",
    topics: ["operations", "offering", "scale", "team"],
    defaultHourlyCostEur: 40,
    keywords: /\b(ops|operations?|logistics|fulfil+ment|supply|support ops|compliance)\b/i,
  },
  {
    id: "sales",
    stepId: "analyse_sales",
    department: "Sales & Customer Success",
    focus:
      "lead qualification, demos and trials, RFPs and security questionnaires, onboarding, renewals, support tickets and customer communities",
    topics: ["sales", "customers", "support", "pricing"],
    defaultHourlyCostEur: 45,
    keywords: /\b(sales|customer|success|support|cs|account|marketing|growth)\b/i,
  },
  {
    id: "finance",
    stepId: "analyse_finance",
    department: "Finance & Back-office",
    focus:
      "billing and invoicing, quotes and pricing approvals, procurement, recruiting and HR (careers pages), legal and reporting",
    topics: ["finance", "pricing", "hiring", "team"],
    defaultHourlyCostEur: 45,
    keywords:
      /\b(finance|accounting|billing|back[- ]?office|hr|people|recruit\w*|legal|procurement)\b/i,
  },
  {
    id: "engineering",
    stepId: "analyse_engineering",
    department: "Engineering & Product",
    focus:
      "documentation, changelogs and release notes, developer support, integrations, QA and triage of issues, product feedback",
    topics: ["engineering", "integrations", "offering", "hiring"],
    defaultHourlyCostEur: 65,
    keywords: /\b(engineering|product|dev\w*|platform|data|qa|r&d)\b/i,
  },
];

export function lensesFor(department: string | undefined): AuditLens[] {
  if (department === undefined) return [...AUDIT_LENSES];
  const matched = AUDIT_LENSES.filter((lens) => lens.keywords.test(department));
  return matched.length === 0 ? [...AUDIT_LENSES] : matched;
}
