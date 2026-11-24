import { describe, expect, it } from "vitest";

import { type RunEventDraft } from "../events";
import { TextCoalescer, createRunEmitter } from "./emitter";

const runId = "run_1";

describe("createRunEmitter", () => {
  it("delivers queued and awaited events strictly in call order", async () => {
    const delivered: string[] = [];
    const emitter = createRunEmitter(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, event.type === "plan.proposed" ? 5 : 0));
      delivered.push(event.type);
    });
    emitter.queue({
      runId,
      type: "plan.proposed",
      payload: { version: 1, steps: [] },
    });
    await emitter.emit({
      runId,
      type: "plan.approved",
      payload: { version: 1, approvedBy: { type: "system", id: "x" } },
    });
    expect(delivered).toEqual(["plan.proposed", "plan.approved"]);
  });

  it("rejects drafts that do not match the event schema", async () => {
    const emitter = createRunEmitter(() => Promise.resolve());
    const bad = {
      runId,
      type: "usage.updated",
      payload: { inputTokens: -1 },
    } as unknown as RunEventDraft;
    await expect(emitter.emit(bad)).rejects.toThrow();
  });

  it("surfaces a failed queued delivery on the next flush", async () => {
    const emitter = createRunEmitter(() => Promise.reject(new Error("db down")));
    emitter.queue({ runId, type: "run.completed", payload: { summary: "x" } });
    await expect(emitter.flush()).rejects.toThrow("db down");
  });
});

describe("TextCoalescer", () => {
  it("batches deltas and flushes at most every interval", () => {
    let clock = 0;
    const chunks: string[] = [];
    const coalescer = new TextCoalescer(
      (text) => chunks.push(text),
      () => clock,
      250,
    );
    coalescer.push("Hel");
    clock = 100;
    coalescer.push("lo ");
    expect(chunks).toEqual([]);
    clock = 260;
    coalescer.push("world");
    expect(chunks).toEqual(["Hello world"]);
    clock = 300;
    coalescer.push("!");
    coalescer.flush();
    expect(chunks).toEqual(["Hello world", "!"]);
    coalescer.flush();
    expect(chunks).toHaveLength(2);
  });
});
