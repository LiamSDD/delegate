import { EGRESS_CAPABILITIES, SIDE_EFFECT_CAPABILITIES } from "./defaults";
import {
  PolicyContextSchema,
  PolicySchema,
  type DataClassification,
  type Decision,
  type DecisionKind,
  type Policy,
  type PolicyContext,
  type Rule,
} from "./types";

export const BUILTIN_POLICY_ID = "builtin";
export const UNCLASSIFIED_TREATED_AS: DataClassification = "restricted";

const BLOCKED_HOSTNAMES = new Set(["localhost"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];
const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/i;

const SEVERITY: Record<DecisionKind, number> = { allow: 0, require_approval: 1, deny: 2 };

function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "");
}

export function matchesDomain(domain: string, pattern: string): boolean {
  const host = normaliseDomain(domain);
  const rule = normaliseDomain(pattern);
  if (host === "" || rule === "") return false;
  if (rule === "*") return true;
  if (rule.startsWith("*.")) return host.endsWith(rule.slice(1));
  return host === rule;
}

export function isBlockedEgressHost(domain: string): boolean {
  const host = normaliseDomain(domain).replace(/^\[|\]$/g, "");
  if (host === "" || host.includes(":")) return true;
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)))
    return true;
  const labels = host.split(".");
  if (labels.length < 2) return true;
  return NUMERIC_LABEL.test(labels.at(-1) ?? "");
}

export function loadPolicies(input: unknown): Policy[] {
  return PolicySchema.array().parse(input);
}

function matchesTool(tool: string, tools: readonly string[]): boolean {
  return tools.includes("*") || tools.includes(tool);
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(6)}`;
}

function checkRule(
  rule: Rule,
  ctx: PolicyContext,
): { decision: DecisionKind; reason: string } | undefined {
  switch (rule.kind) {
    case "require_approval":
      return matchesTool(ctx.tool, rule.tools)
        ? { decision: "require_approval", reason: `Tool ${ctx.tool} requires human approval` }
        : undefined;
    case "deny_tools":
      return matchesTool(ctx.tool, rule.tools)
        ? { decision: "deny", reason: `Tool ${ctx.tool} is not allowed` }
        : undefined;
    case "capability_allowlist":
      return rule.capabilities.includes(ctx.capability)
        ? undefined
        : {
            decision: "deny",
            reason: `Capability ${ctx.capability} is not allowed in this workspace`,
          };
    case "egress_allowlist": {
      const egressCapability = rule.capabilities.includes(ctx.capability);
      if (ctx.targetDomain === undefined) {
        return egressCapability
          ? {
              decision: "deny",
              reason: `Capability ${ctx.capability} must declare its target domain`,
            }
          : undefined;
      }
      if (!egressCapability) {
        return {
          decision: "deny",
          reason: `Capability ${ctx.capability} may not make outbound requests`,
        };
      }
      const target = ctx.targetDomain;
      return rule.domains.some((pattern) => matchesDomain(target, pattern))
        ? undefined
        : {
            decision: "deny",
            reason: `Domain ${normaliseDomain(target)} is not on the egress allowlist`,
          };
    }
    case "spend_cap": {
      const run = ctx.spentRunMicroUsd + ctx.estimatedCostMicroUsd;
      const day = ctx.spentDayMicroUsd + ctx.estimatedCostMicroUsd;
      if (rule.perRunMicroUsd !== undefined && run > rule.perRunMicroUsd) {
        return {
          decision: rule.onExceed,
          reason: `Run spend ${formatUsd(run)} would exceed cap ${formatUsd(rule.perRunMicroUsd)}`,
        };
      }
      if (rule.perDayMicroUsd !== undefined && day > rule.perDayMicroUsd) {
        return {
          decision: rule.onExceed,
          reason: `Daily spend ${formatUsd(day)} would exceed cap ${formatUsd(rule.perDayMicroUsd)}`,
        };
      }
      return undefined;
    }
    case "classification": {
      const classification = ctx.dataClassification ?? UNCLASSIFIED_TREATED_AS;
      if (!rule.classifications.includes(classification)) return undefined;
      const label =
        ctx.dataClassification === undefined
          ? `Unclassified data (treated as ${UNCLASSIFIED_TREATED_AS})`
          : `${classification} data`;
      if (matchesTool(ctx.tool, rule.forbiddenTools)) {
        return { decision: "deny", reason: `${label} may not be sent to tool ${ctx.tool}` };
      }
      const restrictsProviders =
        rule.forbiddenProviders.length > 0 || rule.forbiddenProviderTerms.length > 0;
      if (ctx.provider === undefined && restrictsProviders) {
        return {
          decision: "deny",
          reason: `${label} needs a declared model provider to check provider restrictions`,
        };
      }
      if (ctx.provider !== undefined) {
        if (rule.forbiddenProviders.includes(ctx.provider.id)) {
          return {
            decision: "deny",
            reason: `${label} may not be sent to provider ${ctx.provider.id}`,
          };
        }
        if (rule.forbiddenProviderTerms.includes(ctx.provider.terms)) {
          return {
            decision: "deny",
            reason: `${label} may not be sent to ${ctx.provider.terms} provider ${ctx.provider.id}`,
          };
        }
      }
      return undefined;
    }
    case "provider_terms":
      if (ctx.provider === undefined) {
        return {
          decision: "deny",
          reason: "No model provider declared; provider terms cannot be checked",
        };
      }
      if (rule.allowed.includes(ctx.provider.terms)) return undefined;
      return {
        decision: "deny",
        reason: `Provider ${ctx.provider.id} has ${ctx.provider.terms} terms, not allowed here`,
      };
    default:
      return { decision: "deny", reason: "Unknown rule kind" };
  }
}

function builtin(decision: DecisionKind, ruleId: string, reason: string): Decision {
  return { decision, policyId: BUILTIN_POLICY_ID, ruleId, reason };
}

function baselineDecisions(policies: readonly Policy[], ctx: PolicyContext): Decision[] {
  const decisions: Decision[] = [];
  if ((SIDE_EFFECT_CAPABILITIES as readonly string[]).includes(ctx.capability)) {
    decisions.push(
      builtin(
        "require_approval",
        "side-effect-approval",
        `Capability ${ctx.capability} has side effects and always requires human approval`,
      ),
    );
  }
  const egressCapable = (EGRESS_CAPABILITIES as readonly string[]).includes(ctx.capability);
  if (!egressCapable && ctx.targetDomain === undefined) return decisions;
  const target = ctx.targetDomain;
  if (target === undefined) {
    decisions.push(
      builtin(
        "deny",
        "egress-target-required",
        `Capability ${ctx.capability} can make outbound requests and must declare its target domain`,
      ),
    );
    return decisions;
  }
  if (isBlockedEgressHost(target)) {
    decisions.push(
      builtin(
        "deny",
        "blocked-host",
        `Host ${normaliseDomain(target)} is an IP literal, local, link-local, metadata or private name and is never an allowed egress target`,
      ),
    );
    return decisions;
  }
  const allowlisted = policies.some((policy) =>
    policy.rules.some(
      (rule) =>
        rule.kind === "egress_allowlist" &&
        rule.capabilities.includes(ctx.capability) &&
        rule.domains.some((pattern) => matchesDomain(target, pattern)),
    ),
  );
  if (!allowlisted) {
    decisions.push(
      builtin(
        "deny",
        "egress-not-allowlisted",
        `No egress allowlist permits ${ctx.capability} to reach ${normaliseDomain(target)}`,
      ),
    );
  }
  return decisions;
}

function invalidPolicyId(input: unknown): string {
  if (typeof input === "object" && input !== null && "id" in input) {
    const { id } = input;
    if (typeof id === "string" && id !== "") return id;
  }
  return "invalid";
}

export function evaluateAll(policies: readonly Policy[], context: PolicyContext): Decision[] {
  const ctx = PolicyContextSchema.parse(context);
  const decisions: Decision[] = [];
  if (!ctx.grantedCapabilities.includes(ctx.capability)) {
    decisions.push(
      builtin(
        "deny",
        "capability-not-granted",
        `Step was not granted capability ${ctx.capability}`,
      ),
    );
  }
  const parsed: Policy[] = [];
  for (const input of policies as readonly unknown[]) {
    const result = PolicySchema.safeParse(input);
    if (result.success) {
      parsed.push(result.data);
      continue;
    }
    decisions.push({
      decision: "deny",
      policyId: invalidPolicyId(input),
      ruleId: "invalid-policy",
      reason: "Policy failed validation and was treated as deny",
    });
  }
  for (const policy of parsed) {
    policy.rules.forEach((rule, index) => {
      const outcome = checkRule(rule, ctx);
      if (outcome !== undefined) {
        decisions.push({
          ...outcome,
          policyId: policy.id,
          ruleId: rule.id ?? `${rule.kind}#${index}`,
        });
      }
    });
  }
  decisions.push(...baselineDecisions(parsed, ctx));
  return decisions;
}

export function evaluate(policies: readonly Policy[], context: PolicyContext): Decision {
  let strongest: Decision | undefined;
  for (const decision of evaluateAll(policies, context)) {
    if (strongest === undefined || SEVERITY[decision.decision] > SEVERITY[strongest.decision])
      strongest = decision;
  }
  return (
    strongest ?? {
      decision: "allow",
      policyId: BUILTIN_POLICY_ID,
      ruleId: "default-allow",
      reason: "Capability granted and no rule denied or required approval",
    }
  );
}
