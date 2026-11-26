import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted((): { input: Record<string, unknown>; mission: string } => ({
  input: {},
  mission: "repo-xray",
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/components/trace/trace-view", () => ({ TraceView: () => null }));
vi.mock("@/server/page-session", () => ({
  currentGuest: () => Promise.resolve({ app: {}, session: { userId: "u" } }),
}));
vi.mock("@/server/runs", () => ({
  getRunRecord: () =>
    Promise.resolve({ id: "run-1", mission: stored.mission, input: stored.input }),
}));

const { default: TracePage } = await import("./page");

async function traceTarget(mission: string, input: Record<string, unknown>): Promise<unknown> {
  stored.mission = mission;
  stored.input = input;
  const element = await TracePage({
    params: Promise.resolve({ id: "run-1" }),
    searchParams: Promise.resolve({}),
  });
  if (!isValidElement<{ target: unknown }>(element)) throw new Error("no element");
  return element.props.target;
}

describe("trace page header target", () => {
  it("names the repository of a Repo X-ray, not the GitHub host", async () => {
    expect(await traceTarget("repo-xray", { url: "https://github.com/sindresorhus/ky" })).toBe(
      "sindresorhus/ky",
    );
    expect(await traceTarget("repo-xray", { repoUrl: "https://github.com/vercel/next.js" })).toBe(
      "vercel/next.js",
    );
  });

  it("names a custom goal by its shortened text", async () => {
    const goal = "Find the onboarding steps where trial users drop off and suggest three fixes";
    const target = await traceTarget("custom-goal", { goal });
    expect(target).toMatch(/^Find the onboarding steps where trial users drop off/);
    expect(target).toMatch(/…$/);
  });

  it("keeps the company host for company missions", async () => {
    expect(await traceTarget("company-xray", { url: "https://www.stripe.com/" })).toBe(
      "stripe.com",
    );
  });
});
