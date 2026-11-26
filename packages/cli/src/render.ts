import type { Run, RunEvent, RunStep, RunSummary } from "@delegate/sdk";
import { z } from "zod";

const ONE_LINE_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 1_200;

export function plain(text: string, max = ONE_LINE_MAX_CHARS): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function block(text: string, max = SUMMARY_MAX_CHARS): string[] {
  const capped = text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  return capped
    .split(/\r?\n/)
    .map((line) => plain(line, max))
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""));
}

function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toISOString().slice(11, 19);
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const count = new Intl.NumberFormat("en-US");

const Step = z.object({ id: z.string(), objective: z.string() });
const Payloads = {
  plan: z.object({ version: z.number(), steps: z.array(Step) }),
  revised: z.object({ version: z.number(), steps: z.array(Step), reason: z.string() }),
  planApproved: z.object({ approvedBy: z.object({ type: z.string() }).optional() }),
  stepCompleted: z.object({ outcome: z.enum(["succeeded", "failed"]), summary: z.string() }),
  toolCalled: z.object({ tool: z.string(), argsSummary: z.string() }),
  policy: z.object({
    tool: z.string(),
    decision: z.string(),
    policyId: z.string(),
    reason: z.string(),
  }),
  artifact: z.object({ artifactId: z.string(), kind: z.string(), title: z.string() }),
  critic: z.object({ claim: z.string(), reason: z.string(), severity: z.string() }),
  approval: z.object({ approvalId: z.string(), summary: z.string() }),
  resolved: z.object({ approvalId: z.string(), resolution: z.string() }),
  ship: z.object({ mode: z.string(), repo: z.string(), title: z.string() }),
  shipDecided: z.object({ decision: z.string() }),
  pullRequest: z.object({ url: z.string(), number: z.number(), repo: z.string() }),
  fallback: z.object({
    from: z.object({ provider: z.string(), model: z.string() }),
    to: z.object({ provider: z.string(), model: z.string() }).nullable(),
    reason: z.string(),
  }),
  childStarted: z.object({ childRunId: z.string(), missionId: z.string(), label: z.string() }),
  childCompleted: z.object({
    missionId: z.string(),
    outcome: z.object({ status: z.string(), summary: z.string() }),
  }),
  completed: z.object({ summary: z.string() }),
  failed: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
  message: z.object({ text: z.string() }),
};

export interface RenderOptions {
  runUrl: string;
  verbose: boolean;
}

function row(at: string, label: string, text: string): string {
  return `${clock(at)}  ${label.padEnd(8)} ${text}`;
}

function planLines(steps: readonly { id: string; objective: string }[]): string[] {
  const width = String(steps.length).length;
  return steps.map(
    (step, index) =>
      `            ${String(index + 1).padStart(width)}. ${plain(step.id, 40)}: ${plain(step.objective)}`,
  );
}

export function renderEvent(event: RunEvent, options: RenderOptions): string[] {
  const { at, type, payload } = event;
  const step = event.stepId === undefined ? "" : plain(event.stepId, 40);
  const read = <T extends z.ZodType>(schema: T): z.output<T> | null => {
    const parsed = schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  };
  switch (type) {
    case "run.created":
      return [row(at, "run", `started · ${options.runUrl}`)];
    case "plan.proposed": {
      const plan = read(Payloads.plan);
      if (plan === null) return [row(at, "plan", "proposed")];
      return [
        row(at, "plan", `version ${plan.version}, ${plan.steps.length} steps`),
        ...planLines(plan.steps),
      ];
    }
    case "plan.revised": {
      const plan = read(Payloads.revised);
      if (plan === null) return [row(at, "plan", "revised")];
      return [
        row(at, "plan", `revised to version ${plan.version}: ${plain(plan.reason)}`),
        ...planLines(plan.steps),
      ];
    }
    case "plan.approved": {
      const approved = read(Payloads.planApproved);
      const by = approved?.approvedBy?.type;
      return [row(at, "plan", by === undefined ? "approved" : `approved by ${plain(by, 20)}`)];
    }
    case "step.started":
      return [row(at, "step", `${step} started`)];
    case "step.completed": {
      const done = read(Payloads.stepCompleted);
      if (done === null) return [row(at, "step", `${step} finished`)];
      return [
        row(
          at,
          done.outcome === "succeeded" ? "ok" : "failed",
          `${step}${done.summary === "" ? "" : `: ${plain(done.summary)}`}`,
        ),
      ];
    }
    case "approval.requested": {
      const approval = read(Payloads.approval);
      return [
        row(at, "approve", `needs a decision: ${plain(approval?.summary ?? "a side effect")}`),
        `            decide in the web app: ${options.runUrl}`,
      ];
    }
    case "approval.resolved": {
      const resolved = read(Payloads.resolved);
      return [row(at, "approve", plain(resolved?.resolution ?? "resolved", 20))];
    }
    case "ship.approval.requested": {
      const ship = read(Payloads.ship);
      const what =
        ship === null
          ? "a change"
          : `${ship.mode === "pull_request" ? "open a pull request on" : "prepare a patch for"} ${plain(ship.repo, 80)}: ${plain(ship.title)}`;
      return [
        row(at, "approve", `needs a decision: ${what}`),
        `            review the diff and decide in the web app: ${options.runUrl}`,
      ];
    }
    case "ship.approval.decided": {
      const decided = read(Payloads.shipDecided);
      return [row(at, "approve", `change ${plain(decided?.decision ?? "decided", 20)}`)];
    }
    case "pr.opened": {
      const pr = read(Payloads.pullRequest);
      return pr === null
        ? [row(at, "pr", "opened")]
        : [row(at, "pr", `#${pr.number} on ${plain(pr.repo, 80)} · ${plain(pr.url, 300)}`)];
    }
    case "artifact.created": {
      const artifact = read(Payloads.artifact);
      return artifact === null
        ? []
        : [row(at, "artifact", `${plain(artifact.title)} (${plain(artifact.kind, 40)})`)];
    }
    case "policy.decided": {
      const policy = read(Payloads.policy);
      if (policy === null || (policy.decision === "allow" && !options.verbose)) return [];
      return [
        row(
          at,
          policy.decision === "allow" ? "policy" : "blocked",
          `${plain(policy.tool, 60)} ${plain(policy.decision, 30)} by ${plain(policy.policyId, 60)}: ${plain(policy.reason)}`,
        ),
      ];
    }
    case "critic.flagged": {
      const flag = read(Payloads.critic);
      return flag === null
        ? []
        : [row(at, "critic", `${plain(flag.severity, 10)}: ${plain(flag.reason)}`)];
    }
    case "model.fallback": {
      const fallback = read(Payloads.fallback);
      if (fallback === null) return [];
      const to =
        fallback.to === null
          ? "no model left"
          : `${plain(fallback.to.provider, 40)}/${plain(fallback.to.model, 60)}`;
      return [
        row(
          at,
          "model",
          `${plain(fallback.from.provider, 40)}/${plain(fallback.from.model, 60)} unavailable (${plain(fallback.reason, 40)}), using ${to}`,
        ),
      ];
    }
    case "child.started": {
      const child = read(Payloads.childStarted);
      return child === null
        ? []
        : [row(at, "child", `${plain(child.label, 120)} (${plain(child.missionId, 40)}) started`)];
    }
    case "child.completed": {
      const child = read(Payloads.childCompleted);
      return child === null
        ? []
        : [
            row(
              at,
              "child",
              `${plain(child.missionId, 40)} ${plain(child.outcome.status, 20)}: ${plain(child.outcome.summary)}`,
            ),
          ];
    }
    case "tool.called": {
      const call = read(Payloads.toolCalled);
      return !options.verbose || call === null
        ? []
        : [row(at, "tool", `${plain(call.tool, 60)} ${plain(call.argsSummary, 120)}`)];
    }
    case "agent.message": {
      const message = read(Payloads.message);
      return !options.verbose || message === null ? [] : [row(at, "agent", plain(message.text))];
    }
    case "run.completed":
      return [row(at, "done", "completed")];
    case "run.failed": {
      const failure = read(Payloads.failed);
      if (failure === null) return [row(at, "failed", "the run failed")];
      return failure.error.code === "cancelled"
        ? [row(at, "stopped", "cancelled")]
        : [row(at, "failed", `${plain(failure.error.code, 60)}: ${plain(failure.error.message)}`)];
    }
    default:
      return [];
  }
}

export function planDecisionHint(runId: string, runUrl: string): string[] {
  return [
    `            approve: delegate approve-plan ${runId}`,
    `            reject:  delegate reject-plan ${runId} --reason "..."`,
    `            or edit and decide in the web app: ${runUrl}`,
  ];
}

export function renderOutcome(run: Run, elapsedMs: number | null): string[] {
  const lines: string[] = [""];
  const totals = `${count.format(run.totals.inputTokens + run.totals.outputTokens)} tokens, ${count.format(run.totals.toolCalls)} tool calls`;
  const took = elapsedMs === null ? "" : ` in ${duration(elapsedMs)}`;
  if (run.status === "completed") {
    lines.push(`Run completed${took} · ${totals}`);
    if (run.deliverable !== null)
      lines.push(
        `Deliverable: ${plain(run.deliverable.title)} (${plain(run.deliverable.kind, 40)})`,
        `  delegate artifacts get ${run.id} ${plain(run.deliverable.artifactId, 200)}`,
      );
    if (run.summary !== null && run.summary !== "") lines.push("", ...block(run.summary));
  } else if (run.status === "failed") {
    const cancelled = run.error?.code === "cancelled";
    lines.push(
      cancelled
        ? `Run cancelled${took} · ${totals}`
        : `Run failed${took}: ${plain(run.error?.code ?? "unknown", 60)}: ${plain(run.error?.message ?? "", 400)}`,
    );
  } else {
    lines.push(`Run is ${run.status} · ${totals}`);
  }
  lines.push("", `Open: ${run.webUrl}`);
  return lines;
}

function stepMark(status: RunStep["status"]): string {
  if (status === "succeeded") return "ok     ";
  if (status === "failed") return "failed ";
  if (status === "running") return "running";
  return "pending";
}

export function renderRun(run: Run): string[] {
  const lines = [
    `Run      ${run.id}`,
    `Mission  ${plain(run.mission, 60)}${run.target === null ? "" : ` · ${plain(run.target)}`}`,
    `Status   ${run.status}${run.execution === "simulated" ? " (simulated)" : ""}`,
    `Created  ${run.createdAt}${run.finishedAt === null ? "" : ` · finished ${run.finishedAt}`}`,
    `Usage    ${count.format(run.totals.inputTokens + run.totals.outputTokens)} tokens, ${count.format(run.totals.toolCalls)} tool calls`,
    `Open     ${run.webUrl}`,
  ];
  if (run.pendingPlan !== null) {
    lines.push("", "Plan waiting for approval:", ...planLines(run.pendingPlan));
    lines.push(...planDecisionHint(run.id, run.webUrl));
  }
  if (run.pendingApprovals.length > 0) {
    lines.push("", "Waiting for a decision in the web app:");
    for (const approval of run.pendingApprovals) lines.push(`  - ${plain(approval.summary)}`);
    lines.push(`  decide at ${run.webUrl}`);
  }
  if (run.steps.length > 0) {
    lines.push("", "Steps:");
    for (const step of run.steps)
      lines.push(
        `  ${stepMark(step.status)}  ${plain(step.id, 40)}: ${plain(step.summary ?? step.objective)}`,
      );
  }
  if ((run.children ?? []).length > 0) {
    lines.push("", "Child runs:");
    for (const child of run.children ?? [])
      lines.push(
        `  ${plain(child.status, 24).padEnd(24)} ${plain(child.label, 80)}${child.runId === null ? "" : ` · ${child.runId}`}`,
      );
  }
  if (run.artifacts.length > 0) {
    lines.push("", "Artifacts:");
    for (const artifact of run.artifacts)
      lines.push(
        `  ${plain(artifact.artifactId, 60)}  ${plain(artifact.title)} (${plain(artifact.kind, 40)}, v${artifact.version})`,
      );
  }
  if (run.error !== null)
    lines.push("", `Error: ${plain(run.error.code, 60)}: ${plain(run.error.message, 400)}`);
  if (run.summary !== null && run.summary !== "") lines.push("", ...block(run.summary));
  return lines;
}

export function renderRunList(runs: readonly RunSummary[]): string[] {
  if (runs.length === 0) return ["No runs."];
  const rows = runs.map((run) => [
    run.id,
    run.status,
    plain(run.mission, 24),
    run.createdAt.slice(0, 16).replace("T", " "),
    run.target === null ? "" : plain(run.target, 60),
  ]);
  const header = ["RUN", "STATUS", "MISSION", "CREATED (UTC)", "TARGET"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((cells) => (cells[column] ?? "").length)),
  );
  return [header, ...rows].map((cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}
