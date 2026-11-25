import { describe, expect, it } from "vitest";

import { CAPABILITIES, defaultPolicy, withConnectorAccess } from "./defaults";
import { evaluate } from "./engine";
import { type PolicyContext } from "./types";

function context(capability: string, targetDomain: string): PolicyContext {
  return {
    workspaceId: "ws",
    runId: "run",
    stepId: "step",
    actor: { type: "agent", id: "worker" },
    tool: "mcp__tickets__search",
    capability,
    grantedCapabilities: [capability],
    argsSummary: "search",
    targetDomain,
    dataClassification: "public",
    provider: { id: "pollinations", terms: "public-demo-ok" },
    estimatedCostMicroUsd: 0,
    spentRunMicroUsd: 0,
    spentDayMicroUsd: 0,
  };
}

describe("connector capabilities", () => {
  const policy = withConnectorAccess(defaultPolicy, ["mcp.tickets.example"]);

  it("are denied by the guest baseline when no connector is configured", () => {
    expect(
      evaluate([defaultPolicy], context(CAPABILITIES.connectorRead, "mcp.tickets.example")),
    ).toMatchObject({ decision: "deny" });
  });

  it("leave the base policy untouched when there are no connector hosts", () => {
    expect(withConnectorAccess(defaultPolicy, [])).toBe(defaultPolicy);
  });

  it("allow read-only connector tools against the connector's own host", () => {
    expect(
      evaluate([policy], context(CAPABILITIES.connectorRead, "mcp.tickets.example")).decision,
    ).toBe("allow");
  });

  it("deny connector calls to any other host", () => {
    expect(
      evaluate([policy], context(CAPABILITIES.connectorRead, "attacker.example")),
    ).toMatchObject({ decision: "deny" });
  });

  it("always require approval for side-effecting connector tools", () => {
    expect(
      evaluate([policy], context(CAPABILITIES.connectorWrite, "mcp.tickets.example")),
    ).toMatchObject({ decision: "require_approval", ruleId: "side-effect-approval" });
  });

  it("cannot be turned into allow by a permissive workspace policy", () => {
    const permissive = {
      id: "allow-all",
      name: "Allow all",
      rules: [
        { kind: "capability_allowlist" as const, capabilities: [CAPABILITIES.connectorWrite] },
        {
          kind: "egress_allowlist" as const,
          capabilities: [CAPABILITIES.connectorWrite],
          domains: ["*"],
        },
      ],
    };
    expect(
      evaluate([permissive], context(CAPABILITIES.connectorWrite, "mcp.tickets.example")).decision,
    ).toBe("require_approval");
  });
});
