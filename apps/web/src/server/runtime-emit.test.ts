import { describe, expect, it, vi } from "vitest";

import { adaptRuntimeEmit } from "./runtime-emit";

describe("adaptRuntimeEmit", () => {
  it("forwards type, payload, stepId and agentId and drops the envelope", async () => {
    const sink = vi.fn(() => Promise.resolve());
    const emit = adaptRuntimeEmit("run-1", sink);
    await emit({
      runId: "run-1",
      type: "agent.message",
      stepId: "s",
      agentId: "a",
      payload: { text: "hi" },
    });
    await emit({ runId: "run-1", type: "run.completed", payload: { summary: "ok" } });
    expect(sink.mock.calls).toEqual([
      [{ type: "agent.message", payload: { text: "hi" }, stepId: "s", agentId: "a" }],
      [{ type: "run.completed", payload: { summary: "ok" } }],
    ]);
  });

  it("refuses events addressed to another run", async () => {
    const emit = adaptRuntimeEmit("run-1", () => Promise.resolve());
    await expect(
      emit({ runId: "run-2", type: "run.completed", payload: { summary: "x" } }),
    ).rejects.toThrow(/run-2/);
  });
});
