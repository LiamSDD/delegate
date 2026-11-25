import { PolicySchema, type Policy } from "./types";

export const CAPABILITIES = {
  webFetch: "web.fetch",
  artifactWrite: "artifact.write",
  scratchpadWrite: "scratchpad.write",
  codeExecute: "code.execute",
  repoWrite: "repo.write",
  messageSend: "message.send",
  webhookSend: "webhook.send",
  connectorRead: "connector.read",
  connectorWrite: "connector.write",
  sandboxRead: "sandbox.read",
  sandboxWrite: "sandbox.write",
  sandboxExec: "sandbox.exec",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const SIDE_EFFECT_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.codeExecute,
  CAPABILITIES.repoWrite,
  CAPABILITIES.messageSend,
  CAPABILITIES.webhookSend,
  CAPABILITIES.connectorWrite,
];

export const EGRESS_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.webFetch,
  CAPABILITIES.repoWrite,
  CAPABILITIES.messageSend,
  CAPABILITIES.webhookSend,
  CAPABILITIES.connectorRead,
  CAPABILITIES.connectorWrite,
];

export const CONNECTOR_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.connectorRead,
  CAPABILITIES.connectorWrite,
];

export function withConnectorAccess(base: Policy, connectorHosts: readonly string[]): Policy {
  if (connectorHosts.length === 0) return base;
  return PolicySchema.parse({
    ...base,
    id: `${base.id}+connectors`,
    rules: [
      ...base.rules.map((rule) =>
        rule.kind === "capability_allowlist" || rule.kind === "egress_allowlist"
          ? {
              ...rule,
              capabilities: [...new Set([...rule.capabilities, ...CONNECTOR_CAPABILITIES])],
            }
          : rule,
      ),
      {
        id: "connector-hosts",
        kind: "egress_allowlist",
        capabilities: [...CONNECTOR_CAPABILITIES],
        domains: [...new Set(connectorHosts.map((host) => host.toLowerCase()))],
      },
    ],
  });
}

export const defaultPolicy: Policy = PolicySchema.parse({
  id: "guest-demo",
  name: "Guest demo workspace",
  description:
    "Public demo: research and drafting only, keyless public-demo providers, outbound requests only through fetch tools to public hostnames (the engine always denies IP literals, localhost, link-local, metadata and private hosts; DNS-level SSRF checks stay in the fetch tool), no spend.",
  rules: [
    {
      id: "read-only-capabilities",
      kind: "capability_allowlist",
      capabilities: [
        CAPABILITIES.webFetch,
        CAPABILITIES.artifactWrite,
        CAPABILITIES.scratchpadWrite,
      ],
    },
    {
      id: "fetch-only-egress",
      kind: "egress_allowlist",
      capabilities: [CAPABILITIES.webFetch],
      domains: ["*"],
    },
    { id: "zero-spend", kind: "spend_cap", perRunMicroUsd: 0, perDayMicroUsd: 0, onExceed: "deny" },
    {
      id: "public-demo-providers",
      kind: "provider_terms",
      allowed: ["public-demo-ok", "local-only", "byok"],
    },
    {
      id: "no-confidential-data",
      kind: "classification",
      classifications: ["confidential", "restricted"],
      forbiddenTools: ["*"],
    },
  ],
});

export const ownerDefaultPolicy: Policy = PolicySchema.parse({
  id: "owner-research",
  name: "Owner research runs",
  description:
    "Owner-run evaluations and recordings: the same research-only capabilities and egress rules as the guest demo, any configured provider (including evaluation-only trial tiers), and a spend cap for bring-your-own-key models.",
  rules: [
    {
      id: "read-only-capabilities",
      kind: "capability_allowlist",
      capabilities: [
        CAPABILITIES.webFetch,
        CAPABILITIES.artifactWrite,
        CAPABILITIES.scratchpadWrite,
      ],
    },
    {
      id: "fetch-only-egress",
      kind: "egress_allowlist",
      capabilities: [CAPABILITIES.webFetch],
      domains: ["*"],
    },
    {
      id: "owner-spend-cap",
      kind: "spend_cap",
      perRunMicroUsd: 2_000_000,
      perDayMicroUsd: 10_000_000,
      onExceed: "deny",
    },
    {
      id: "no-confidential-data",
      kind: "classification",
      classifications: ["confidential", "restricted"],
      forbiddenTools: ["*"],
    },
  ],
});

export const GITHUB_OPEN_PR_TOOL = "github.open_pr";
export const GITHUB_API_HOST = "api.github.com";

export const SANDBOX_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.sandboxRead,
  CAPABILITIES.sandboxWrite,
  CAPABILITIES.sandboxExec,
];

export const shipDemoPolicy: Policy = PolicySchema.parse({
  id: "ship-demo",
  name: "Ship-a-PR for guests",
  description:
    "Public demo Ship-a-PR: the Engineer reads, writes and runs allowlisted commands only inside an isolated sandbox, keyless public-demo providers, no spend. Pull requests are denied outright: guests only ever receive a patch and a test report.",
  rules: [
    {
      id: "sandbox-capabilities",
      kind: "capability_allowlist",
      capabilities: [...SANDBOX_CAPABILITIES, CAPABILITIES.artifactWrite],
    },
    { id: "no-pull-requests", kind: "deny_tools", tools: [GITHUB_OPEN_PR_TOOL] },
    { id: "zero-spend", kind: "spend_cap", perRunMicroUsd: 0, perDayMicroUsd: 0, onExceed: "deny" },
    {
      id: "public-demo-providers",
      kind: "provider_terms",
      allowed: ["public-demo-ok", "local-only", "byok"],
    },
    {
      id: "no-confidential-data",
      kind: "classification",
      classifications: ["confidential", "restricted"],
      forbiddenTools: ["*"],
    },
  ],
});

export const shipConnectedPolicy: Policy = PolicySchema.parse({
  id: "ship-connected",
  name: "Ship-a-PR for a visitor with a connected GitHub installation",
  description:
    "A visitor who connected their own GitHub App installation: sandbox-only reads, writes and allowlisted commands; one pull request to the GitHub API on a repository their installation covers, always after human approval; no spend. The pull request is a system action with no model provider, so provider terms are enforced by the public-demo model routing rather than by this policy.",
  rules: [
    {
      id: "sandbox-capabilities",
      kind: "capability_allowlist",
      capabilities: [...SANDBOX_CAPABILITIES, CAPABILITIES.artifactWrite, CAPABILITIES.repoWrite],
    },
    {
      id: "github-api-only",
      kind: "egress_allowlist",
      capabilities: [CAPABILITIES.repoWrite],
      domains: [GITHUB_API_HOST],
    },
    { id: "pull-request-approval", kind: "require_approval", tools: [GITHUB_OPEN_PR_TOOL] },
    { id: "zero-spend", kind: "spend_cap", perRunMicroUsd: 0, perDayMicroUsd: 0, onExceed: "deny" },
    {
      id: "no-confidential-data",
      kind: "classification",
      classifications: ["confidential", "restricted"],
      forbiddenTools: ["*"],
    },
  ],
});

export const shipOwnerPolicy: Policy = PolicySchema.parse({
  id: "ship-owner",
  name: "Ship-a-PR for the owner",
  description:
    "Owner Ship-a-PR: sandbox-only reads, writes and allowlisted commands; one pull request to the GitHub API on the repository the GitHub App is installed on, always after human approval; spend cap for bring-your-own-key models.",
  rules: [
    {
      id: "sandbox-capabilities",
      kind: "capability_allowlist",
      capabilities: [...SANDBOX_CAPABILITIES, CAPABILITIES.artifactWrite, CAPABILITIES.repoWrite],
    },
    {
      id: "github-api-only",
      kind: "egress_allowlist",
      capabilities: [CAPABILITIES.repoWrite],
      domains: [GITHUB_API_HOST],
    },
    { id: "pull-request-approval", kind: "require_approval", tools: [GITHUB_OPEN_PR_TOOL] },
    {
      id: "owner-spend-cap",
      kind: "spend_cap",
      perRunMicroUsd: 2_000_000,
      perDayMicroUsd: 10_000_000,
      onExceed: "deny",
    },
    {
      id: "no-confidential-data",
      kind: "classification",
      classifications: ["confidential", "restricted"],
      forbiddenTools: ["*"],
    },
  ],
});
