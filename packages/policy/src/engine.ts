import {
  PolicyContextSchema,
  type Decision,
  type DecisionKind,
  type Policy,
  type PolicyContext,
  type Rule,
} from "./types";

export const BUILTIN_POLICY_ID = "builtin";

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
      const classification = ctx.dataClassification;
      if (classification === undefined || !rule.classifications.includes(classification))
        return undefined;
      if (matchesTool(ctx.tool, rule.forbiddenTools)) {
        return {
          decision: "deny",
          reason: `${classification} data may not be sent to tool ${ctx.tool}`,
        };
      }
      if (ctx.provider !== undefined) {
        if (rule.forbiddenProviders.includes(ctx.provider.id)) {
          return {
            decision: "deny",
            reason: `${classification} data may not be sent to provider ${ctx.provider.id}`,
          };
        }
        if (rule.forbiddenProviderTerms.includes(ctx.provider.terms)) {
          return {
            decision: "deny",
            reason: `${classification} data may not be sent to ${ctx.provider.terms} provider ${ctx.provider.id}`,
          };
        }
      }
      return undefined;
    }
    case "provider_terms":
      if (ctx.provider === undefined || rule.allowed.includes(ctx.provider.terms)) return undefined;
      return {
        decision: "deny",
        reason: `Provider ${ctx.provider.id} has ${ctx.provider.terms} terms, not allowed here`,
      };
  }
}

export function evaluateAll(policies: readonly Policy[], context: PolicyContext): Decision[] {
  const ctx = PolicyContextSchema.parse(context);
  const decisions: Decision[] = [];
  if (!ctx.grantedCapabilities.includes(ctx.capability)) {
    decisions.push({
      decision: "deny",
      policyId: BUILTIN_POLICY_ID,
      ruleId: "capability-not-granted",
      reason: `Step was not granted capability ${ctx.capability}`,
    });
  }
  for (const policy of policies) {
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
