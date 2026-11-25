import { defaultPolicy } from "@delegate/policy";
import { describe, expect, it } from "vitest";

import { Budget } from "../budget";
import { type RunEventDraft } from "../events";
import { parseModelsConfig } from "../models";
import { type ModelProvider, type ModelRequest, type StreamOptions } from "../providers/types";
import { textTurn } from "../testing/fakes";
import { createRunContext, resolveQuality, type QualitySettings } from "./context";
import { createRunEmitter } from "./emitter";
import { callModel, qualityNote } from "./model-call";
import { callStructured } from "./structured";

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "slow",
      kind: "openai-compatible",
      baseUrl: "https://slow.example",
      keyless: true,
      terms: "evaluation-only",
      maxClassification: "public",
      dataPolicy: "test",
    },
    {
      id: "quick",
      kind: "openai-compatible",
      baseUrl: "https://quick.example",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "test",
    },
  ],
  roles: {
    planner: [
      {
        provider: "slow",
        model: "slow-pro",
        displayName: "Slow Pro",
        contextWindow: 100_000,
        supportsTools: true,
        interactive: false,
      },
      { provider: "quick", model: "quick-planner", contextWindow: 100_000, supportsTools: true },
    ],
    worker: [
      { provider: "quick", model: "quick-worker", contextWindow: 100_000, supportsTools: true },
    ],
    fast: [{ provider: "quick", model: "quick-fast", contextWindow: 100_000, supportsTools: true }],
  },
});

interface Seen {
  provider: string;
  request: ModelRequest;
  options: StreamOptions | undefined;
}

function provider(id: string, seen: Seen[], behaviour: "answer" | "hang"): ModelProvider {
  return {
    id,
    async *stream(request, options) {
      seen.push({ provider: id, request, options });
      if (behaviour === "hang") {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      yield* textTurn(`{"answer":"${request.model}"}`);
    },
  };
}

function run(quality: QualitySettings, slow: "answer" | "hang" = "answer") {
  const events: RunEventDraft[] = [];
  const seen: Seen[] = [];
  const providers = {
    slow: provider("slow", seen, slow),
    quick: provider("quick", seen, "answer"),
  };
  const ctx = createRunContext({
    runId: "run_1",
    workspaceId: "ws",
    audience: "owner",
    classification: "public",
    config,
    env: {},
    emitter: createRunEmitter((event) => {
      events.push(event);
      return Promise.resolve();
    }),
    budget: new Budget({ run: { maxTokens: 100_000, maxMicroUsd: 0 } }),
    policies: [defaultPolicy],
    createProvider: (entry) => providers[entry.provider.id as keyof typeof providers],
    quality,
  });
  const said: string[] = [];
  const say = (text: string) => {
    said.push(text);
    return Promise.resolve();
  };
  return { ctx, events, seen, said, say };
}

const request = {
  system: "Design the assistant.",
  messages: [{ role: "user" as const, content: "Go" }],
  maxTokens: 100,
};

const MAX: QualitySettings = { mode: "max", firstTokenMs: 40, totalMs: 200 };

describe("max quality mode", () => {
  it("routes a quality-critical call to the offline entry with the long per-call timeout", async () => {
    const { ctx, events, seen, said, say } = run(MAX);
    const result = await callModel(ctx, {
      role: "planner",
      stepId: "design",
      request,
      quality: { say },
    });
    expect(result.model).toBe("slow-pro");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.options?.timeouts).toEqual({ firstTokenMs: 40, totalMs: 200 });
    expect(said).toEqual(["Waiting for Slow Pro (max quality, can take several minutes)"]);
    await ctx.emitter.flush();
    expect(events.find((event) => event.type === "usage.updated")?.payload).toMatchObject({
      provider: "slow",
      model: "slow-pro",
    });
    expect(qualityNote([result])).toBe("Max quality: Slow Pro");
  });

  it("falls back to the normal chain with model.fallback reason timeout", async () => {
    const { ctx, events, seen, said, say } = run(MAX, "hang");
    const result = await callModel(ctx, {
      role: "planner",
      stepId: "design",
      request,
      quality: { say },
    });
    expect(result.model).toBe("quick-planner");
    expect(seen.map((entry) => entry.provider)).toEqual(["slow", "quick"]);
    expect(seen[1]?.options?.timeouts).toBeUndefined();
    expect(said).toHaveLength(1);
    await ctx.emitter.flush();
    expect(events.find((event) => event.type === "model.fallback")?.payload).toMatchObject({
      role: "planner",
      reason: "timeout",
      from: { provider: "slow", model: "slow-pro" },
      to: { provider: "quick", model: "quick-planner" },
    });
    expect(events.find((event) => event.type === "usage.updated")?.payload).toMatchObject({
      model: "quick-planner",
    });
    expect(qualityNote([result])).toBeUndefined();
  });

  it("keeps calls without a quality request on the fast chain", async () => {
    const { ctx, seen } = run(MAX);
    const result = await callModel(ctx, { role: "planner", stepId: "rerank", request });
    expect(result.model).toBe("quick-planner");
    expect(seen.map((entry) => entry.provider)).toEqual(["quick"]);
  });

  it("ignores the quality request in standard mode", async () => {
    const { ctx, seen, said, say } = run({ mode: "standard", firstTokenMs: 40, totalMs: 200 });
    const result = await callModel(ctx, { role: "planner", request, quality: { say } });
    expect(result.model).toBe("quick-planner");
    expect(seen).toHaveLength(1);
    expect(said).toEqual([]);
  });

  it("passes the preference through structured calls", async () => {
    const { ctx, say } = run(MAX);
    const { z } = await import("zod");
    const result = await callStructured(ctx, {
      role: "planner",
      system: "s",
      user: "u",
      schema: z.object({ answer: z.string() }),
      maxTokens: 100,
      quality: { say },
    });
    expect(result.value.answer).toBe("slow-pro");
  });
});

describe("resolveQuality", () => {
  it("defaults to standard with 300 s first token and 600 s total", () => {
    expect(resolveQuality("owner", undefined)).toEqual({
      mode: "standard",
      firstTokenMs: 300_000,
      totalMs: 600_000,
    });
  });

  it("honours max for the owner with configurable timeouts", () => {
    expect(resolveQuality("owner", "max", { firstTokenMs: 1_000 })).toEqual({
      mode: "max",
      firstTokenMs: 1_000,
      totalMs: 600_000,
    });
  });

  it("ignores max for the public demo and records why", () => {
    const settings = resolveQuality("public-demo", "max");
    expect(settings.mode).toBe("standard");
    expect(settings.ignoredReason).toMatch(/public demo/i);
  });
});
