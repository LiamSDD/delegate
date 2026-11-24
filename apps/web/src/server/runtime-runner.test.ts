import type { RunMissionOptions, RunMissionResult } from "@delegate/runtime/server";
import { describe, expect, it } from "vitest";

import { createRuntimeRunner, loadRepoPrompts } from "./runtime-runner";
import type { EventDraft } from "./runs";

function capture() {
  const calls: RunMissionOptions[] = [];
  const runMission = async (options: RunMissionOptions): Promise<RunMissionResult> => {
    calls.push(options);
    await options.emit({ runId: options.runId, type: "run.completed", payload: { summary: "ok" } });
    return { status: "completed" };
  };
  return { calls, runMission };
}

async function run(env: Record<string, string | undefined>) {
  const { calls, runMission } = capture();
  const emitted: EventDraft[] = [];
  const runner = createRuntimeRunner({ env, runMission, loadPrompts: loadRepoPrompts });
  const result = await runner({
    runId: "run-1",
    missionId: "company-xray",
    input: { url: "https://example.com/" },
    emit: (draft) => {
      emitted.push(draft);
      return Promise.resolve();
    },
    signal: new AbortController().signal,
  });
  return { result, call: calls[0], emitted };
}

describe("createRuntimeRunner", () => {
  it("runs guests as the public demo with the bundled models config and adapts events", async () => {
    const { result, call, emitted } = await run({ NODE_ENV: "production", NVIDIA_API_KEY: "x" });
    expect(result).toEqual({ status: "completed" });
    expect(call?.context).toEqual({ audience: "public-demo", classification: "public" });
    expect(call?.latency).toBe("interactive");
    expect(call?.modelsConfig).toMatchObject({ version: 1 });
    expect(call?.input).toEqual({ url: "https://example.com/" });
    expect(call?.prompts?.synthesis.name).toBe("company-xray.synthesis");
    expect(emitted).toEqual([{ type: "run.completed", payload: { summary: "ok" } }]);
  });

  it("uses the owner audience only with DELEGATE_OWNER_MODE=1 outside production", async () => {
    expect(
      (await run({ NODE_ENV: "development", DELEGATE_OWNER_MODE: "1" })).call?.context.audience,
    ).toBe("owner");
    expect(
      (await run({ NODE_ENV: "production", DELEGATE_OWNER_MODE: "1" })).call?.context.audience,
    ).toBe("public-demo");
  });
});
