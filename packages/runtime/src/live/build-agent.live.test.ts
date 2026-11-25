import { writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createMemoryLeases } from "../durable/lease";
import { foldRun, parseRunEvent, type RunEvent, type RunEventDraft } from "../events";
import { createMemoryKnowledgeStore } from "../knowledge/memory-store";
import { type AnswerEvent } from "../missions/build-agent/answer";
import {
  AssistantArtifactSchema,
  AssistantEvalsSchema,
  GapsReportSchema,
  createMemoryAssistantStore,
} from "../missions/build-agent/schema";
import { answerQuestion, resumeMission, runMission } from "../server";
import { redactSecrets } from "../smoke";
import { loadRepoEnv } from "./env";

function log(runId: string, input: Record<string, unknown>) {
  const events: RunEvent[] = [];
  const append = (draft: RunEventDraft) => {
    events.push(parseRunEvent({ ...draft, seq: events.length + 1, at: new Date().toISOString() }));
  };
  append({
    runId,
    type: "run.created",
    payload: {
      workspaceId: "live",
      missionId: "build-agent",
      input,
      actor: { type: "system", id: "live-test" },
      budget: { maxTokens: 600_000, maxMicroUsd: 0 },
    },
  });
  return { events, append };
}

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

it("builds a cited assistant from a real site, answers questions and resumes after a kill", async () => {
  const env = loadRepoEnv();
  const url = env.BUILD_URL ?? "";
  const goal = env.BUILD_GOAL ?? "";
  const questions = (env.BUILD_QUESTIONS ?? "")
    .split("|")
    .filter((question) => question.trim() !== "");
  if (url === "" || goal === "") throw new Error("Set BUILD_URL and BUILD_GOAL");
  const audience = env.BUILD_AUDIENCE === "public-demo" ? "public-demo" : "owner";
  const input = { url, goal };
  const stores = {
    knowledge: createMemoryKnowledgeStore(),
    assistants: createMemoryAssistantStore(),
  };
  const base = {
    context: { audience, classification: "public" } as const,
    env,
    latency: "interactive" as const,
    knowledge: stores.knowledge,
    assistants: stores.assistants,
  };

  const runId = `live_build_${Date.now()}`;
  const { events, append } = log(runId, input);
  const started = Date.now();
  const result = await runMission({
    ...base,
    runId,
    missionId: "build-agent",
    input,
    emit: (draft) => {
      append(draft);
      return Promise.resolve();
    },
  });
  const durationMs = Date.now() - started;
  const state = foldRun(events);
  const assistant = AssistantArtifactSchema.safeParse(lastContent(events, "assistant"));
  const evals = AssistantEvalsSchema.safeParse(lastContent(events, "assistant-evals"));
  const gaps = GapsReportSchema.safeParse(lastContent(events, "gaps-report"));
  const served = new Map<string, Set<string>>();
  for (const event of events)
    if (event.type === "usage.updated")
      served.set(
        event.stepId ?? "planner",
        new Set([
          ...(served.get(event.stepId ?? "planner") ?? []),
          `${event.payload.provider}/${event.payload.model}`,
        ]),
      );

  const answers: unknown[] = [];
  if (assistant.success)
    for (const question of questions) {
      const t0 = Date.now();
      const streamed: AnswerEvent[] = [];
      let firstDeltaMs: number | undefined;
      for await (const event of answerQuestion({
        assistantId: assistant.data.id,
        question,
        env,
        audience,
        assistants: stores.assistants,
        knowledge: stores.knowledge,
      })) {
        if (event.type === "delta" && firstDeltaMs === undefined) firstDeltaMs = Date.now() - t0;
        streamed.push(event);
      }
      const done = streamed.find((event) => event.type === "done");
      const refusal = streamed.find((event) => event.type === "refusal");
      answers.push({
        question,
        ms: Date.now() - t0,
        firstDeltaMs,
        deltas: streamed.filter((event) => event.type === "delta").length,
        refusal: refusal?.type === "refusal" ? `${refusal.reason}: ${refusal.message}` : undefined,
        answer: done?.type === "done" ? done.answer : undefined,
        citations:
          done?.type === "done"
            ? done.citations.map((citation) => `[${citation.index}] ${citation.url}`)
            : [],
        retrieval: done?.type === "done" ? done.retrieval : undefined,
        servedBy: done?.type === "done" ? done.servedBy : undefined,
      });
    }

  const crashId = `live_build_crash_${Date.now()}`;
  const crash = log(crashId, input);
  const controller = new AbortController();
  let killed = false;
  const killAfter = env.BUILD_KILL_AFTER ?? "design";
  const crashStarted = Date.now();
  await runMission({
    ...base,
    runId: crashId,
    missionId: "build-agent",
    input,
    signal: controller.signal,
    emit: (draft) => {
      if (killed) return Promise.reject(new Error("killed"));
      crash.append(draft);
      if (draft.type === "step.completed" && draft.stepId === killAfter) {
        killed = true;
        controller.abort();
      }
      return Promise.resolve();
    },
  });
  const killedAt = crash.events.length;
  const beforeResumeMs = Date.now() - crashStarted;
  const leases = createMemoryLeases();
  const resumeStarted = Date.now();
  const resumed = await resumeMission({
    ...base,
    runId: crashId,
    events: [...crash.events],
    lease: leases.lease(crashId, "worker-2", 60_000),
    emit: (draft) => {
      crash.append(draft);
      return Promise.resolve();
    },
  });
  const resumeMs = Date.now() - resumeStarted;
  const restarted = crash.events
    .slice(killedAt)
    .filter((event) => event.type === "step.started")
    .map((event) => event.stepId);

  const report = {
    status: result.status,
    error: state.error,
    durationMs,
    audience,
    plan: state.plan?.steps.map((step) => step.id),
    servedBy: Object.fromEntries([...served].map(([step, models]) => [step, [...models]])),
    fallbacks: state.fallbacks.length,
    steps: state.steps.map((step) => `${step.id}: ${step.status} - ${step.summary ?? ""}`),
    assistant: assistant.success
      ? {
          id: assistant.data.id,
          name: assistant.data.name,
          scope: assistant.data.scope,
          starterQuestions: assistant.data.starterQuestions,
          refusalPolicy: assistant.data.refusalPolicy,
          contactUrl: assistant.data.contactUrl,
          corpusStats: assistant.data.corpusStats,
          retrieval: assistant.data.retrieval,
          passRate: assistant.data.passRate,
        }
      : assistant.error.message.slice(0, 300),
    evals: evals.success
      ? {
          passRate: evals.data.passRate,
          passed: evals.data.passed,
          total: evals.data.total,
          grader: evals.data.grader,
          note: evals.data.note,
          results: evals.data.results.map((entry) => {
            const item = evals.data.cases.find((candidate) => candidate.id === entry.caseId);
            return `${entry.verdict} ${item?.answerable === true ? "A" : "U"} ${item?.question ?? ""} -> ${entry.reason}`;
          }),
        }
      : undefined,
    gaps: gaps.success
      ? {
          count: gaps.data.gaps.length,
          coverage: gaps.data.coverage,
          items: gaps.data.gaps.map((gap) => `${gap.kind}: ${gap.topic}`),
        }
      : undefined,
    flags: events.filter((event) => event.type === "critic.flagged").length,
    tokens: state.totals,
    answers,
    resume: {
      killAfter,
      beforeKillMs: beforeResumeMs,
      eventsAtKill: killedAt,
      resumeMs,
      result: resumed,
      restartedSteps: restarted,
      finalStatus: foldRun(crash.events).status,
      crashCrawlStarts: crash.events.filter(
        (event) => event.type === "step.started" && event.stepId === "crawl",
      ).length,
    },
  };
  process.stdout.write(`\n${redactSecrets(JSON.stringify(report, null, 2))}\n`);
  const out = env.BUILD_EVENTS_OUT;
  if (out !== undefined && out !== "")
    writeFileSync(out, redactSecrets(JSON.stringify(events, null, 2)));
  expect(result.status).toBe("completed");
});
