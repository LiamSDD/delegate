import { writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { foldRun, parseRunEvent, type RunEvent } from "../events";
import { CompanyXrayBriefSchema, SECTION_KEYS } from "../missions/company-xray/brief";
import { runMission } from "../server";
import { redactSecrets } from "../smoke";
import { loadRepoEnv } from "./env";

it("runs Company X-ray end to end against a real company site", async () => {
  const env = loadRepoEnv();
  const url = env.XRAY_URL;
  if (url === undefined || url === "")
    throw new Error("Set XRAY_URL to the company homepage to research");
  const audience = env.XRAY_AUDIENCE === "public-demo" ? "public-demo" : "owner";
  const runId = `live_${Date.now()}`;
  const events: RunEvent[] = [];
  const append = (draft: unknown) => {
    events.push(
      parseRunEvent({ ...(draft as object), seq: events.length + 1, at: new Date().toISOString() }),
    );
  };
  append({
    runId,
    type: "run.created",
    payload: {
      workspaceId: "live",
      missionId: "company-xray",
      input: { url },
      actor: { type: "system", id: "live-test" },
      budget: { maxTokens: 600000, maxMicroUsd: 0 },
    },
  });
  const started = Date.now();
  const result = await runMission({
    runId,
    missionId: "company-xray",
    input: { url },
    context: { audience, classification: "public" },
    env,
    emit: (draft) => {
      append(draft);
      return Promise.resolve();
    },
  });
  const durationMs = Date.now() - started;
  const state = foldRun(events);
  const served = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    const key = event.stepId ?? "run";
    served.set(
      key,
      new Set([...(served.get(key) ?? []), `${event.payload.provider}/${event.payload.model}`]),
    );
  }
  const lastArtifact = events.filter((event) => event.type === "artifact.updated").at(-1);
  const brief =
    lastArtifact?.type === "artifact.updated"
      ? CompanyXrayBriefSchema.safeParse(lastArtifact.payload.content)
      : undefined;
  const claims =
    brief?.success === true
      ? (JSON.stringify(brief.data.sections).match(/"citations":/g) ?? []).length
      : 0;
  const report = {
    status: result.status,
    error: state.error,
    durationMs,
    audience,
    sourcesFetched: events
      .filter(
        (event) => event.type === "artifact.created" && event.payload.kind === "source-snapshot",
      )
      .reduce((sum, event) => {
        const content =
          event.type === "artifact.created"
            ? (event.payload.content as { sources?: unknown[] } | undefined)
            : undefined;
        return sum + (content?.sources?.length ?? 0);
      }, 0),
    sourcesCited: brief?.success === true ? brief.data.sources.length : 0,
    sourceMix: brief?.success === true ? brief.data.sourceMix : undefined,
    claims,
    citationsValid: brief?.success === true,
    servedBy: Object.fromEntries(
      [...served.entries()].map(([step, models]) => [step, [...models]]),
    ),
    fallbacks: state.fallbacks.map(
      (fallback) =>
        `${fallback.role}: ${fallback.from.provider}/${fallback.from.model} -> ${fallback.to === null ? "none" : `${fallback.to.provider}/${fallback.to.model}`} (${fallback.reason})`,
    ),
    policyDenials: events
      .filter((event) => event.type === "policy.decided" && event.payload.decision === "deny")
      .map((event) =>
        event.type === "policy.decided" ? `${event.payload.tool}: ${event.payload.reason}` : "",
      ),
    flags: events
      .filter((event) => event.type === "critic.flagged")
      .map((event) => `${event.payload.category ?? "claim"}: ${event.payload.claim.slice(0, 100)}`),
    tokens: state.totals,
    sections:
      brief?.success === true
        ? Object.fromEntries(SECTION_KEYS.map((key) => [key, brief.data.sections[key].status]))
        : undefined,
    stepSummaries: state.steps.map((step) => `${step.id}: ${step.status} - ${step.summary ?? ""}`),
  };
  process.stdout.write(`\n${redactSecrets(JSON.stringify(report, null, 2))}\n`);
  const out = env.XRAY_EVENTS_OUT;
  if (out !== undefined && out !== "")
    writeFileSync(out, redactSecrets(JSON.stringify(events, null, 2)));
  expect(result.status).toBe("completed");
});
