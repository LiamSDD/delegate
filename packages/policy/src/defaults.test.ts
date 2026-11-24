import { describe, expect, it } from "vitest";

import { CAPABILITIES, defaultPolicy, ownerDefaultPolicy } from "./defaults";
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
