import { describe, expect, it } from "vitest";

import { CAPABILITIES, defaultPolicy } from "./defaults";
import { evaluate, evaluateAll, isBlockedEgressHost, loadPolicies, matchesDomain } from "./engine";
import { PolicySchema, type Decision, type Policy, type PolicyContext } from "./types";

const base: PolicyContext = {
  workspaceId: "ws_1",
  runId: "run_1",
  stepId: "s1",
  actor: { type: "agent", id: "a_1" },
  tool: "web_fetch",
  capability: CAPABILITIES.webFetch,
  grantedCapabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
  argsSummary: "GET https://example.com/",
  targetDomain: "example.com",
  dataClassification: "public",
  provider: { id: "pollinations", terms: "public-demo-ok" },
  estimatedCostMicroUsd: 0,
  spentRunMicroUsd: 0,
  spentDayMicroUsd: 0,
};

const workspace: Policy = PolicySchema.parse({
  id: "acme",
  name: "Acme workspace",
  rules: [
    { id: "pr-approval", kind: "require_approval", tools: ["github_create_pr", "slack_post"] },
    { id: "no-email", kind: "deny_tools", tools: ["send_email"] },
    {
      id: "egress",
      kind: "egress_allowlist",
      capabilities: ["web.fetch", "repo.write"],
      domains: ["example.com", "*.github.com", "api.github.com"],
    },
    { id: "spend", kind: "spend_cap", perRunMicroUsd: 500_000, perDayMicroUsd: 2_000_000 },
    {
      id: "confidential",
      kind: "classification",
      classifications: ["confidential", "restricted"],
      forbiddenTools: ["web_fetch", "slack_post"],
      forbiddenProviders: ["llm7"],
      forbiddenProviderTerms: ["public-demo-ok", "evaluation-only"],
    },
  ],
});

const approvalOverBudget: Policy = PolicySchema.parse({
  id: "soft-cap",
  name: "Soft cap",
  rules: [{ id: "soft", kind: "spend_cap", perRunMicroUsd: 100, onExceed: "require_approval" }],
});

type Case = [
  name: string,
  policies: Policy[],
  context: Partial<PolicyContext>,
  expected: Pick<Decision, "decision" | "policyId" | "ruleId">,
];

const cases: Case[] = [
  [
    "allows a granted fetch to an allowlisted domain",
    [workspace],
    {},
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "denies a capability that the step was not granted, even with no policies",
    [],
    { tool: "github_create_pr", capability: "repo.write", targetDomain: "api.github.com" },
    { decision: "deny", policyId: "builtin", ruleId: "capability-not-granted" },
  ],
  [
    "requires approval for listed side-effect tools",
    [workspace],
    {
      tool: "github_create_pr",
      capability: "repo.write",
      grantedCapabilities: ["repo.write"],
      targetDomain: "api.github.com",
    },
    { decision: "require_approval", policyId: "acme", ruleId: "pr-approval" },
  ],
  [
    "denies explicitly forbidden tools",
    [workspace],
    {
      tool: "send_email",
      capability: "message.send",
      grantedCapabilities: ["message.send"],
      targetDomain: undefined,
    },
    { decision: "deny", policyId: "acme", ruleId: "no-email" },
  ],
  [
    "deny wins over require_approval",
    [workspace],
    {
      tool: "slack_post",
      capability: "message.send",
      grantedCapabilities: ["message.send"],
      targetDomain: undefined,
      dataClassification: "confidential",
    },
    { decision: "deny", policyId: "acme", ruleId: "confidential" },
  ],
  [
    "require_approval wins over allow across policies",
    [workspace, approvalOverBudget],
    { estimatedCostMicroUsd: 101 },
    { decision: "require_approval", policyId: "soft-cap", ruleId: "soft" },
  ],
  [
    "denies egress to a domain off the allowlist",
    [workspace],
    { targetDomain: "evil.test" },
    { decision: "deny", policyId: "acme", ruleId: "egress" },
  ],
  [
    "allows wildcard subdomains",
    [workspace],
    { targetDomain: "raw.github.com" },
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "does not let a wildcard match the bare parent domain",
    [workspace],
    { targetDomain: "github.com" },
    { decision: "deny", policyId: "acme", ruleId: "egress" },
  ],
  [
    "does not match look-alike suffixes",
    [workspace],
    { targetDomain: "example.com.evil.test" },
    { decision: "deny", policyId: "acme", ruleId: "egress" },
  ],
  [
    "normalises case and trailing dots",
    [workspace],
    { targetDomain: "EXAMPLE.com." },
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "fails closed when an egress capability has no target domain",
    [workspace],
    { targetDomain: undefined },
    { decision: "deny", policyId: "acme", ruleId: "egress" },
  ],
  [
    "denies network egress from capabilities not allowed to egress",
    [workspace],
    { tool: "write_note", capability: "artifact.write", targetDomain: "example.com" },
    { decision: "deny", policyId: "acme", ruleId: "egress" },
  ],
  [
    "denies when the run spend cap would be exceeded",
    [workspace],
    { spentRunMicroUsd: 499_000, estimatedCostMicroUsd: 2000 },
    { decision: "deny", policyId: "acme", ruleId: "spend" },
  ],
  [
    "allows spend exactly at the cap",
    [workspace],
    { spentRunMicroUsd: 499_000, estimatedCostMicroUsd: 1000 },
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "denies when the daily spend cap would be exceeded",
    [workspace],
    { spentDayMicroUsd: 1_999_999, estimatedCostMicroUsd: 2 },
    { decision: "deny", policyId: "acme", ruleId: "spend" },
  ],
  [
    "denies forbidden tools for confidential data",
    [workspace],
    { dataClassification: "confidential" },
    { decision: "deny", policyId: "acme", ruleId: "confidential" },
  ],
  [
    "denies forbidden providers for restricted data",
    [workspace],
    {
      tool: "summarise",
      capability: "artifact.write",
      targetDomain: undefined,
      dataClassification: "restricted",
      provider: { id: "llm7", terms: "public-demo-ok" },
    },
    { decision: "deny", policyId: "acme", ruleId: "confidential" },
  ],
  [
    "denies provider terms forbidden for confidential data",
    [workspace],
    {
      tool: "summarise",
      capability: "artifact.write",
      targetDomain: undefined,
      dataClassification: "confidential",
      provider: { id: "groq", terms: "public-demo-ok" },
    },
    { decision: "deny", policyId: "acme", ruleId: "confidential" },
  ],
  [
    "allows confidential data on a local provider",
    [workspace],
    {
      tool: "summarise",
      capability: "artifact.write",
      targetDomain: undefined,
      dataClassification: "confidential",
      provider: { id: "ollama", terms: "local-only" },
    },
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "ignores classification rules for public data",
    [workspace],
    { dataClassification: "public", provider: { id: "llm7", terms: "public-demo-ok" } },
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "guest: allows keyless research fetches",
    [defaultPolicy],
    {},
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "guest: denies side-effect capabilities even when a plan grants them",
    [defaultPolicy],
    {
      tool: "github_create_pr",
      capability: "repo.write",
      grantedCapabilities: ["repo.write"],
      targetDomain: "api.github.com",
    },
    { decision: "deny", policyId: "guest-demo", ruleId: "read-only-capabilities" },
  ],
  [
    "guest: denies any spend above $0",
    [defaultPolicy],
    { estimatedCostMicroUsd: 1 },
    { decision: "deny", policyId: "guest-demo", ruleId: "zero-spend" },
  ],
  [
    "guest: denies evaluation-only providers",
    [defaultPolicy],
    { provider: { id: "nvidia", terms: "evaluation-only" } },
    { decision: "deny", policyId: "guest-demo", ruleId: "public-demo-providers" },
  ],
  [
    "guest: allows public-demo providers",
    [defaultPolicy],
    { provider: { id: "pollinations", terms: "public-demo-ok" } },
    { decision: "allow", policyId: "builtin", ruleId: "default-allow" },
  ],
  [
    "guest: denies egress from non-fetch capabilities",
    [defaultPolicy],
    { tool: "write_note", capability: "artifact.write", targetDomain: "example.com" },
    { decision: "deny", policyId: "guest-demo", ruleId: "fetch-only-egress" },
  ],
  [
    "guest: refuses confidential data",
    [defaultPolicy],
    { dataClassification: "confidential" },
    { decision: "deny", policyId: "guest-demo", ruleId: "no-confidential-data" },
  ],
];

describe("evaluate", () => {
  it("has at least 20 table cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases)("%s", (_name, policies, overrides, expected) => {
    const context = Object.fromEntries(
      Object.entries({ ...base, ...overrides }).filter(([, value]) => value !== undefined),
    ) as PolicyContext;
    const decision = evaluate(policies, context);
    expect(decision).toMatchObject(expected);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("rejects a malformed context instead of guessing", () => {
    expect(() => evaluate([workspace], { ...base, estimatedCostMicroUsd: -1 })).toThrow();
    expect(() => evaluate([workspace], { ...base, estimatedCostMicroUsd: 0.5 })).toThrow();
  });

  it("lists every matching decision for the audit log", () => {
    const all = evaluateAll([workspace], {
      ...base,
      tool: "slack_post",
      capability: "message.send",
      grantedCapabilities: ["message.send"],
      dataClassification: "confidential",
    });
    expect(all.map((decision) => [decision.decision, decision.ruleId])).toEqual([
      ["require_approval", "pr-approval"],
      ["deny", "egress"],
      ["deny", "confidential"],
      ["require_approval", "side-effect-approval"],
      ["deny", "egress-not-allowlisted"],
    ]);
  });

  it("denies a policy that does not parse instead of skipping it", () => {
    const vibes = { id: "p", name: "P", rules: [{ kind: "vibes" }] } as unknown as Policy;
    expect(evaluate([vibes], base)).toMatchObject({
      decision: "deny",
      policyId: "p",
      ruleId: "invalid-policy",
    });
    const nameless = { rules: [] } as unknown as Policy;
    expect(evaluate([workspace, nameless], base)).toMatchObject({
      decision: "deny",
      ruleId: "invalid-policy",
    });
  });

  it("applies schema defaults when evaluating unparsed policy input", () => {
    const raw = {
      id: "raw",
      name: "Raw",
      rules: [{ id: "cap", kind: "spend_cap", perRunMicroUsd: 10 }],
    } as unknown as Policy;
    expect(evaluate([workspace, raw], { ...base, estimatedCostMicroUsd: 11 })).toMatchObject({
      decision: "deny",
      policyId: "raw",
    });
  });
});

describe("loadPolicies", () => {
  it("parses a list of policies and rejects unknown rule kinds", () => {
    expect(loadPolicies([defaultPolicy])).toEqual([defaultPolicy]);
    expect(() => loadPolicies([{ id: "p", name: "P", rules: [{ kind: "vibes" }] }])).toThrow();
  });
});

describe("built-in baseline", () => {
  it("denies egress when no allowlist covers the capability", () => {
    expect(evaluate([], base)).toMatchObject({
      decision: "deny",
      policyId: "builtin",
      ruleId: "egress-not-allowlisted",
    });
  });

  it("requires egress-capable capabilities to declare a target domain", () => {
    const { targetDomain: _omitted, ...withoutTarget } = base;
    expect(evaluate([defaultPolicy], withoutTarget)).toMatchObject({ decision: "deny" });
    expect(evaluateAll([], withoutTarget).map((decision) => decision.ruleId)).toContain(
      "egress-target-required",
    );
  });

  it.each(["repo.write", "message.send", "webhook.send", "code.execute"])(
    "requires approval for side-effect capability %s even when no policy says so",
    (capability) => {
      const open: Policy = PolicySchema.parse({
        id: "open",
        name: "Open",
        rules: [
          {
            kind: "egress_allowlist",
            capabilities: ["repo.write", "message.send", "webhook.send", "code.execute"],
            domains: ["api.github.com"],
          },
        ],
      });
      expect(
        evaluate([open], {
          ...base,
          tool: "act",
          capability,
          grantedCapabilities: [capability],
          targetDomain: "api.github.com",
        }),
      ).toMatchObject({
        decision: "require_approval",
        policyId: "builtin",
        ruleId: "side-effect-approval",
      });
    },
  );

  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "192.168.1.1",
    "169.254.169.254",
    "0x7f.1",
    "2130706433",
    "[::1]",
    "::ffff:127.0.0.1",
    "fd00::1",
    "localhost",
    "api.localhost",
    "metadata.google.internal",
    "printer.local",
    "metadata",
    "router.home.arpa",
  ])("denies the blocked host %s even under a wildcard allowlist", (host) => {
    const decision = evaluate([defaultPolicy], { ...base, targetDomain: host });
    expect(decision).toMatchObject({
      decision: "deny",
      policyId: "builtin",
      ruleId: "blocked-host",
    });
  });

  it("still allows ordinary public hosts under the guest policy", () => {
    expect(
      evaluate([defaultPolicy], { ...base, targetDomain: "news.ycombinator.com" }),
    ).toMatchObject({ decision: "allow" });
    expect(isBlockedEgressHost("example.com")).toBe(false);
    expect(isBlockedEgressHost("1password.com")).toBe(false);
  });
});

describe("fail-closed defaults", () => {
  it("treats a missing data classification as restricted", () => {
    expect(evaluate([workspace], { ...base, dataClassification: undefined })).toMatchObject({
      decision: "deny",
      ruleId: "confidential",
    });
    const context = { ...base };
    delete context.dataClassification;
    const decision = evaluate([defaultPolicy], context);
    expect(decision).toMatchObject({ decision: "deny", ruleId: "no-confidential-data" });
    expect(decision.reason).toMatch(/unclassified/i);
  });

  it("denies under provider_terms when no provider is declared", () => {
    const context = { ...base };
    delete context.provider;
    expect(evaluate([defaultPolicy], context)).toMatchObject({
      decision: "deny",
      ruleId: "public-demo-providers",
    });
  });

  it("denies under a classification rule with provider restrictions when no provider is declared", () => {
    const context: PolicyContext = {
      ...base,
      tool: "summarise",
      capability: "artifact.write",
      dataClassification: "confidential",
    };
    delete context.provider;
    delete context.targetDomain;
    expect(evaluate([workspace], context)).toMatchObject({
      decision: "deny",
      ruleId: "confidential",
    });
  });
});

describe("PolicySchema", () => {
  it("rejects unknown rule kinds and defaults spend caps to deny", () => {
    expect(() => PolicySchema.parse({ id: "p", name: "P", rules: [{ kind: "vibes" }] })).toThrow();
    const parsed = PolicySchema.parse({
      id: "p",
      name: "P",
      rules: [{ kind: "spend_cap", perRunMicroUsd: 1 }],
    });
    expect(parsed.rules[0]).toMatchObject({ onExceed: "deny" });
  });

  it("accepts the default guest policy", () => {
    expect(() => PolicySchema.parse(defaultPolicy)).not.toThrow();
  });
});

describe("matchesDomain", () => {
  it.each([
    ["example.com", "example.com", true],
    ["a.example.com", "*.example.com", true],
    ["a.b.example.com", "*.example.com", true],
    ["example.com", "*.example.com", false],
    ["badexample.com", "*.example.com", false],
    ["anything.test", "*", true],
    ["", "*", false],
  ])("%s against %s is %s", (domain, pattern, expected) => {
    expect(matchesDomain(domain, pattern)).toBe(expected);
  });
});
