import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { parseRunEvent, type RunEvent, type RunEventDraft } from "../events";
import { createMemoryKnowledgeStore } from "../knowledge/memory-store";
import { AssistantEvalsSchema, createMemoryAssistantStore } from "../missions/build-agent/schema";
import { runMission } from "../server";
import { loadRepoEnv } from "./env";

function lastContent(events: readonly RunEvent[], kind: string): unknown {
  const created = events.find(
    (event) => event.type === "artifact.created" && event.payload.kind === kind,
  );
  const id = created?.type === "artifact.created" ? created.payload.artifactId : "";
  const last = events
    .filter((event) => event.type === "artifact.updated" && event.payload.artifactId === id)
    .at(-1);
  if (last?.type === "artifact.updated") return last.payload.content;
  return created?.type === "artifact.created" ? created.payload.content : undefined;
}

it("builds an assistant in max quality mode and reports which model served each step", async () => {
  const env = loadRepoEnv();
  const url = env.BUILD_URL ?? "";
  const goal = env.BUILD_GOAL ?? "";
  if (url === "" || goal === "") throw new Error("Set BUILD_URL and BUILD_GOAL");
  const runId = `live_build_max_${Date.now()}`;
  const events: RunEvent[] = [];
  const out = env.LIVE_OUT;
  if (out !== undefined) mkdirSync(out, { recursive: true });
  const append = (draft: RunEventDraft) => {
    const event = parseRunEvent({ ...draft, seq: events.length + 1, at: new Date().toISOString() });
    events.push(event);
    if (out !== undefined)
      appendFileSync(`${out}/build-agent-max.events.jsonl`, `${JSON.stringify(event)}\n`);
    return Promise.resolve();
  };
  const started = Date.now();
  const result = await runMission({
    runId,
    missionId: "build-agent",
    input: { url, goal },
    context: { audience: "owner", classification: "public" },
    env,
    quality: "max",
    knowledge: createMemoryKnowledgeStore(),
    assistants: createMemoryAssistantStore(),
    emit: append,
  });
  const durationMs = Date.now() - started;
  const stepTimes = new Map<string, { startedAt?: number; ms?: number; summary?: string }>();
  for (const event of events) {
    if (event.type === "step.started")
      stepTimes.set(event.stepId, { startedAt: Date.parse(event.at) });
    if (event.type === "step.completed") {
      const entry = stepTimes.get(event.stepId) ?? {};
      entry.ms = Date.parse(event.at) - (entry.startedAt ?? Date.parse(event.at));
      entry.summary = event.payload.summary;
      stepTimes.set(event.stepId, entry);
    }
  }
  const served: Record<string, string[]> = {};
  for (const event of events)
    if (event.type === "usage.updated") {
      const key = event.stepId ?? "planner";
      served[key] = [...(served[key] ?? []), `${event.payload.provider}/${event.payload.model}`];
    }
  const fallbacks = events.flatMap((event) =>
    event.type === "model.fallback"
      ? [
          {
            step: event.stepId ?? null,
            from: `${event.payload.from.provider}/${event.payload.from.model}`,
            to:
              event.payload.to === null
                ? null
                : `${event.payload.to.provider}/${event.payload.to.model}`,
            reason: event.payload.reason,
          },
        ]
      : [],
  );
  const messages = events.flatMap((event) =>
    event.type === "agent.message" && /Waiting for|Max quality/.test(event.payload.text)
      ? [{ step: event.stepId, text: event.payload.text }]
      : [],
  );
  const evals = AssistantEvalsSchema.safeParse(lastContent(events, "assistant-evals"));
  const report = {
    url,
    status: result.status,
    durationMs,
    failure: events.find((event) => event.type === "run.failed")?.payload ?? null,
    steps: Object.fromEntries(
      [...stepTimes].map(([id, entry]) => [id, { ms: entry.ms, summary: entry.summary }]),
    ),
    served,
    fallbacks,
    messages,
    evals: evals.success
      ? { passRate: evals.data.passRate, passed: evals.data.passed, total: evals.data.total }
      : null,
  };
  if (out !== undefined) {
    writeFileSync(`${out}/build-agent-max.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${out}/build-agent-max.events.json`, JSON.stringify(events, null, 2));
  }
  console.warn(JSON.stringify(report, null, 2));
  expect(result.status).toBe("completed");
}, 1_500_000);
