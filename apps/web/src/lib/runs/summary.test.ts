import { describe, expect, it } from "vitest";

import { summaryItems } from "./summary";

describe("summaryItems", () => {
  it("reports duration, agents, sources, citation accuracy, cost and models honestly", () => {
    const items = summaryItems({
      createdAt: "2026-11-25T10:00:00.000Z",
      finishedAt: "2026-11-25T10:02:41.000Z",
      agents: 4,
      sources: 23,
      citation: { kind: "reported", value: 0.956, checked: 45 },
      costMicroUsd: 0,
      providers: [{ provider: "pollinations" }],
      models: ["gpt-oss-120b", "kimi-k3", "gpt-oss-120b"],
    });
    expect(items).toEqual([
      { label: "duration", value: "2m41s" },
      { label: "agents", value: "4" },
      { label: "sources", value: "23" },
      { label: "citation accuracy", value: "96%", hint: "45 claims checked" },
      { label: "cost", value: "$0.00", hint: "free tier" },
      { label: "models", value: "gpt-oss-120b + kimi-k3" },
    ]);
  });

  it("never invents a metric it does not have", () => {
    const items = summaryItems({
      createdAt: "2026-11-25T10:00:00.000Z",
      finishedAt: "2026-11-25T10:00:30.000Z",
      agents: 0,
      sources: null,
      citation: { kind: "resolved", resolved: 3, total: 4 },
      costMicroUsd: 0,
      providers: [],
      models: [],
    });
    expect(items.map((item) => item.label)).toEqual([
      "duration",
      "agents",
      "citation accuracy",
      "cost",
    ]);
    expect(items.find((item) => item.label === "citation accuracy")).toEqual({
      label: "citation accuracy",
      value: "75%",
      hint: "3/4 citations resolved",
    });
  });
});
