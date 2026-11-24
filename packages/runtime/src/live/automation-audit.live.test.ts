import { writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { foldRun, parseRunEvent, type RunEvent } from "../events";
import { estimateRoi } from "../missions/automation-audit/roi";
import { AutomationAuditSchema } from "../missions/automation-audit/schema";
import { runMission } from "../server";
import { redactSecrets } from "../smoke";
import { loadRepoEnv } from "./env";

it("runs the AI Automation Audit end to end against a real company site", async () => {
  const env = loadRepoEnv();
  const url = env.AUDIT_URL;
  if (url === undefined || url === "")
    throw new Error("Set AUDIT_URL to the company homepage to audit");
  const audience = env.AUDIT_AUDIENCE === "public-demo" ? "public-demo" : "owner";
  const runId = `live_audit_${Date.now()}`;
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
      missionId: "automation-audit",
      input: { url },
      actor: { type: "system", id: "live-test" },
      budget: { maxTokens: 600000, maxMicroUsd: 0 },
    },
  });
  const started = Date.now();
  const department = env.AUDIT_DEPARTMENT;
  const input = { url, ...(department === undefined || department === "" ? {} : { department }) };
  const result = await runMission({
    runId,
    missionId: "automation-audit",
    input,
    context: { audience, classification: "public" },
    env,
    latency: "interactive",
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
    const key = event.stepId ?? "planner";
    served.set(
      key,
      new Set([...(served.get(key) ?? []), `${event.payload.provider}/${event.payload.model}`]),
    );
  }
  const auditArtifact = events.find(
    (event) => event.type === "artifact.created" && event.payload.kind === "automation-audit",
  );
  const auditId =
    auditArtifact?.type === "artifact.created" ? auditArtifact.payload.artifactId : "";
  const last = [...events]
    .reverse()
    .find(
      (event) =>
        (event.type === "artifact.updated" || event.type === "artifact.created") &&
        event.payload.artifactId === auditId,
    );
  const audit =
    last?.type === "artifact.updated" || last?.type === "artifact.created"
      ? AutomationAuditSchema.safeParse(last.payload.content)
      : undefined;
  const critic = events.find(
    (event) => event.type === "step.completed" && event.stepId === "critic",
  );
  const proposed = events.find((event) => event.type === "plan.proposed");
  const report = {
    status: result.status,
    error: state.error,
    durationMs,
    audience,
    planSource: proposed?.type === "plan.proposed" ? proposed.payload.source : undefined,
    planSteps:
      proposed?.type === "plan.proposed" ? proposed.payload.steps.map((step) => step.id) : [],
    revisions: state.planRevisions.map((revision) => `${revision.version}: ${revision.reason}`),
    servedBy: Object.fromEntries(
      [...served.entries()].map(([step, models]) => [step, [...models]]),
    ),
    fallbacks: state.fallbacks.length,
    critic: critic?.type === "step.completed" ? critic.payload.critic : undefined,
    auditValid: audit?.success === true,
    company: audit?.success === true ? audit.data.company : undefined,
    opportunities:
      audit?.success === true
        ? audit.data.opportunities.map((opportunity) => ({
            title: opportunity.title,
            department: opportunity.department,
            eurPerMonth: estimateRoi(opportunity).eurPerMonth,
            hoursPerMonth: estimateRoi(opportunity).hoursPerMonth,
            workflow: opportunity.workflow,
            evidence: opportunity.evidence.map(
              (entry) => `${entry.text} [${entry.citations.join(",")}]`,
            ),
            inputs: [
              opportunity.frequencyPerMonth,
              opportunity.minutesPerTask,
              opportunity.peopleInvolved,
              opportunity.adoptionRate,
              opportunity.hourlyCostEur,
            ],
          }))
        : undefined,
    sourcesCited: audit?.success === true ? audit.data.sources.length : 0,
    flags: events
      .filter((event) => event.type === "critic.flagged")
      .map(
        (event) =>
          `${event.payload.category ?? "claim"}/${event.payload.severity}: ${event.payload.claim.slice(0, 80)}`,
      ),
    tokens: state.totals,
    stepSummaries: state.steps.map((step) => `${step.id}: ${step.status} - ${step.summary ?? ""}`),
  };
  process.stdout.write(`\n${redactSecrets(JSON.stringify(report, null, 2))}\n`);
  const out = env.AUDIT_EVENTS_OUT;
  if (out !== undefined && out !== "")
    writeFileSync(out, redactSecrets(JSON.stringify(events, null, 2)));
  expect(result.status).toBe("completed");
});
