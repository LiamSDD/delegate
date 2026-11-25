import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  GITHUB_API_HOST,
  GITHUB_OPEN_PR_TOOL,
  SANDBOX_CAPABILITIES,
  defaultPolicy,
  ownerDefaultPolicy,
  shipConnectedPolicy,
  shipDemoPolicy,
  shipOwnerPolicy,
} from "./defaults";
import { evaluate } from "./engine";
import { type PolicyContext } from "./types";

const base: PolicyContext = {
  workspaceId: "ws_1",
  runId: "run_1",
  stepId: "s1",
  actor: { type: "agent", id: "a_1" },
  tool: "fetch_page",
  capability: CAPABILITIES.webFetch,
  grantedCapabilities: [CAPABILITIES.webFetch],
  argsSummary: "GET https://example.com/",
  targetDomain: "example.com",
  dataClassification: "public",
  provider: { id: "nvidia", terms: "evaluation-only" },
  estimatedCostMicroUsd: 0,
  spentRunMicroUsd: 0,
  spentDayMicroUsd: 0,
};

describe("ownerDefaultPolicy", () => {
  it("lets owner runs on evaluation-only providers research, unlike the guest policy", () => {
    expect(evaluate([defaultPolicy], base).decision).toBe("deny");
    expect(evaluate([ownerDefaultPolicy], base).decision).toBe("allow");
  });

  it("still blocks private targets, side effects and confidential data", () => {
    expect(
      evaluate([ownerDefaultPolicy], { ...base, targetDomain: "169.254.169.254" }).decision,
    ).toBe("deny");
    expect(
      evaluate([ownerDefaultPolicy], {
        ...base,
        tool: "send_email",
        capability: CAPABILITIES.messageSend,
        grantedCapabilities: [CAPABILITIES.messageSend],
        targetDomain: undefined,
      }).decision,
    ).toBe("deny");
    expect(
      evaluate([ownerDefaultPolicy], { ...base, dataClassification: "confidential" }).decision,
    ).toBe("deny");
  });

  it("caps owner spend per run and per day", () => {
    expect(evaluate([ownerDefaultPolicy], { ...base, spentRunMicroUsd: 2_000_001 }).decision).toBe(
      "deny",
    );
    expect(evaluate([ownerDefaultPolicy], { ...base, spentDayMicroUsd: 10_000_001 }).decision).toBe(
      "deny",
    );
  });
});

describe("ship-a-pr policies", () => {
  const sandbox = (capability: string): PolicyContext => ({
    ...base,
    tool: "write_file",
    capability,
    grantedCapabilities: [capability],
    argsSummary: "src/index.ts",
    targetDomain: undefined,
    provider: { id: "groq", terms: "public-demo-ok" },
  });
  const openPr: PolicyContext = {
    ...base,
    actor: { type: "system", id: "ship-a-pr" },
    tool: GITHUB_OPEN_PR_TOOL,
    capability: CAPABILITIES.repoWrite,
    grantedCapabilities: [CAPABILITIES.repoWrite],
    argsSummary: "PR on owner/repo",
    targetDomain: GITHUB_API_HOST,
    provider: undefined,
  };

  it("allows sandbox reads, writes and commands for guests and the owner", () => {
    for (const capability of SANDBOX_CAPABILITIES) {
      expect(evaluate([shipDemoPolicy], sandbox(capability)).decision).toBe("allow");
      expect(evaluate([shipOwnerPolicy], sandbox(capability)).decision).toBe("allow");
    }
  });

  it("denies a pull request to guests and requires approval for the owner", () => {
    expect(evaluate([shipDemoPolicy], openPr).decision).toBe("deny");
    expect(evaluate([shipOwnerPolicy], openPr).decision).toBe("require_approval");
  });

  it("requires approval for a connected visitor and keeps zero spend", () => {
    expect(evaluate([shipConnectedPolicy], openPr).decision).toBe("require_approval");
    expect(
      evaluate([shipConnectedPolicy], { ...openPr, targetDomain: "attacker.example" }).decision,
    ).toBe("deny");
    expect(
      evaluate([shipConnectedPolicy], {
        ...sandbox(CAPABILITIES.sandboxWrite),
        spentRunMicroUsd: 1,
      }).decision,
    ).toBe("deny");
  });

  it("never lets a pull request reach a host other than the GitHub API", () => {
    expect(
      evaluate([shipOwnerPolicy], { ...openPr, targetDomain: "attacker.example" }).decision,
    ).toBe("deny");
    expect(evaluate([shipOwnerPolicy], { ...openPr, targetDomain: undefined }).decision).toBe(
      "deny",
    );
  });

  it("keeps the research policies closed to sandbox capabilities", () => {
    expect(evaluate([defaultPolicy], sandbox(CAPABILITIES.sandboxExec)).decision).toBe("deny");
    expect(evaluate([ownerDefaultPolicy], sandbox(CAPABILITIES.sandboxWrite)).decision).toBe(
      "deny",
    );
  });
});
