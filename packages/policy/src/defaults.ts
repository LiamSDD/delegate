import { PolicySchema, type Policy } from "./types";

export const CAPABILITIES = {
  webFetch: "web.fetch",
  artifactWrite: "artifact.write",
  scratchpadWrite: "scratchpad.write",
  codeExecute: "code.execute",
  repoWrite: "repo.write",
  messageSend: "message.send",
  webhookSend: "webhook.send",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const SIDE_EFFECT_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.codeExecute,
  CAPABILITIES.repoWrite,
  CAPABILITIES.messageSend,
  CAPABILITIES.webhookSend,
];

export const EGRESS_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.webFetch,
  CAPABILITIES.repoWrite,
  CAPABILITIES.messageSend,
  CAPABILITIES.webhookSend,
];

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
