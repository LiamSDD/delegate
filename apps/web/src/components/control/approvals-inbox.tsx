"use client";

import type { TestRunSummary } from "@delegate/runtime";
import { ArrowRight, Check, GitPullRequest, ListChecks, Plug, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { actionButton, Chip, Eyebrow, primaryButton } from "@/components/run/primitives";
import { missionLabel } from "@/lib/m2-contract";
import { cn } from "@/lib/utils";
import type {
  InboxItem,
  PlanInboxItem,
  ShipInboxItem,
  ToolInboxItem,
} from "@/server/control/inbox";

import { useClock } from "./clock";
import { formatSpan, plural, shortId } from "./format";
import { postJson, readErrorLines } from "./http";
import { inboxAction, type InboxDecision, runHref, SHIP_NEEDS_THE_DIFF } from "./inbox-actions";
import { EmptyState, Fact } from "./section";

const KIND = {
  plan: { label: "Plan", icon: ListChecks },
  ship: { label: "Ship", icon: GitPullRequest },
  tool: { label: "Connector tool call", icon: Plug },
} as const;

const URGENT_MS = 2 * 60_000;

export function prettyArguments(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2);
  } catch {
    return json;
  }
}

function question(item: InboxItem): string {
  switch (item.kind) {
    case "plan":
      return `Run this plan of ${plural(item.steps.length, "step")}?`;
    case "ship":
      return item.mode === "pull_request"
        ? `Open a pull request on ${item.repo}?`
        : `Hand over the change to ${item.repo} as a patch?`;
    case "tool":
      return item.server === null ? `Run ${item.action}?` : `Run ${item.action} on ${item.server}?`;
  }
}

function PlanDetails({ item }: { item: PlanInboxItem }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">
        Approving here approves exactly these steps. To edit, reorder or switch steps off, open the
        run.
      </p>
      <ol className="flex flex-col rounded-lg border border-border">
        {item.steps.map((step, index) => (
          <li
            key={step.id}
            className="flex min-w-0 gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
          >
            <span className="w-5 shrink-0 font-mono text-2xs leading-5 text-text-subtle tabular">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-sm break-words text-text">{step.objective}</p>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-2xs text-text-subtle">
                <Chip>{step.role}</Chip>
                {step.capabilities.map((capability) => (
                  <Chip key={capability} tone="accent">
                    {capability}
                  </Chip>
                ))}
                <span className="break-all">
                  {step.id}
                  {step.inputs.length === 0 ? "" : ` · after ${step.inputs.join(", ")}`} ·{" "}
                  {Math.round(step.budgetShare * 100)}% of budget
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function testResult(summary: TestRunSummary | null): string {
  if (summary === null) return "not recorded";
  if (summary.timedOut === true) return "timed out";
  if (summary.passed === null) return "no test command found";
  return summary.passed ? "passed" : `failed (exit ${String(summary.exitCode ?? "unknown")})`;
}

function ShipDetails({ item }: { item: ShipInboxItem }) {
  return (
    <div className="flex flex-col gap-3">
      {item.title === null ? null : <p className="text-sm break-words text-text">{item.title}</p>}
      {item.reason === null ? null : (
        <p className="text-sm break-words text-text-muted">{item.reason}</p>
      )}
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Repository">{item.repo}</Fact>
        <Fact label={item.mode === "pull_request" ? "Branch → base" : "Branch"}>
          {item.branch === null
            ? "not recorded"
            : item.mode === "pull_request" && item.base !== null
              ? `${item.branch} → ${item.base}`
              : item.branch}
        </Fact>
        <Fact label="Diff summary">
          {item.diffStat === null
            ? "not recorded"
            : `${plural(item.diffStat.files, "file")} · +${String(item.diffStat.additions)} −${String(item.diffStat.deletions)} lines`}
        </Fact>
        <Fact label="Tests before → after">
          {testResult(item.baseline)} → {testResult(item.after)}
        </Fact>
      </dl>
      <p className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm text-text-muted">
        This is a summary. {SHIP_NEEDS_THE_DIFF} Rejecting needs no diff, so it is offered here.
      </p>
    </div>
  );
}

function ToolDetails({ item }: { item: ToolInboxItem }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="warning">side effects</Chip>
        {item.capability === null ? null : <Chip tone="accent">{item.capability}</Chip>}
        {item.policyId === null ? null : <Chip>policy {item.policyId}</Chip>}
        <Chip>full arguments, exactly as they will be sent</Chip>
      </div>
      <p className="font-mono text-2xs break-all text-text-subtle">{item.tool}</p>
      <pre
        tabIndex={0}
        aria-label={`Full arguments for ${item.action}`}
        className="max-h-80 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-text"
      >
        {prettyArguments(item.argsJson)}
      </pre>
      <p className="font-mono text-2xs break-all text-text-subtle">sha256 {item.argsSha256}</p>
      <p className="text-xs text-text-subtle">
        Approving sends this hash. If the arguments changed since this page read them, the server
        refuses and nothing runs.
      </p>
    </div>
  );
}

type Submission = "idle" | "approving" | "rejecting" | "sent";

function Item({ item, now }: { item: InboxItem; now: number }) {
  const router = useRouter();
  const headingId = useId();
  const [submission, setSubmission] = useState<Submission>("idle");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<string[] | null>(null);
  const [sent, setSent] = useState<InboxDecision | null>(null);

  const leftMs = Date.parse(item.expiresAt) - now;
  const current: InboxItem = { ...item, expired: item.expired || leftMs <= 0 };
  const approve = inboxAction(current, "approved");
  const reject = inboxAction(current, "rejected", reason);
  const busy = submission !== "idle";
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  const name = item.target ?? shortId(item.runId);

  const send = async (decision: InboxDecision) => {
    const action = decision === "approved" ? approve : reject;
    if (action.via !== "request") return;
    setSubmission(decision === "approved" ? "approving" : "rejecting");
    setErrors(null);
    try {
      const response = await postJson(action.url, action.body);
      if (response.ok) {
        setSent(decision);
        setSubmission("sent");
        router.refresh();
        return;
      }
      setErrors(await readErrorLines(response));
      if (response.status === 409) router.refresh();
    } catch {
      setErrors(["Could not reach the server. Try again."]);
    }
    setSubmission("idle");
  };

  return (
    <li
      data-approval={item.kind}
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 border-b border-border px-4 py-4 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <Eyebrow>
            {kind.label} approval · {missionLabel(item.mission)}
          </Eyebrow>
          <h3 id={headingId} className="text-base font-medium break-words text-text">
            {question(item)}
          </h3>
          <p className="text-sm text-text-muted">
            For{" "}
            <Link
              href={runHref(item.runId)}
              className="font-mono break-all text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
            >
              {name}
            </Link>
          </p>
        </div>
        <Chip
          tone={current.expired ? "danger" : leftMs <= URGENT_MS ? "warning" : "neutral"}
          className="shrink-0"
        >
          {current.expired ? "Past its deadline" : `${formatSpan(leftMs)} left`}
        </Chip>
      </div>

      {item.kind === "plan" ? <PlanDetails item={item} /> : null}
      {item.kind === "ship" ? <ShipDetails item={item} /> : null}
      {item.kind === "tool" ? <ToolDetails item={item} /> : null}

      {errors === null ? null : (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger-soft/40 px-3 py-2 text-xs text-danger"
        >
          {errors.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}

      {rejecting && reject.via === "request" && submission !== "sent" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${headingId}-reason`} className="text-xs text-text-muted">
            Reason (optional, recorded in the run log)
          </label>
          <input
            id={`${headingId}-reason`}
            value={reason}
            maxLength={500}
            disabled={busy}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className="h-8 w-full max-w-xl rounded-md border border-border bg-surface px-2 text-sm text-text focus:border-accent focus:outline-none"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {submission === "sent" ? (
          <p role="status" className="text-sm text-text-muted">
            {sent === "approved" ? "Approved." : "Rejected."} The run picks the decision up within a
            few seconds.
          </p>
        ) : current.expired ? (
          <p className="text-sm text-text-muted">
            {approve.via === "run_page" ? approve.why : null}
          </p>
        ) : rejecting && reject.via === "request" ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void send("rejected");
              }}
              className={cn(actionButton, "border-danger/50 text-danger hover:border-danger")}
            >
              <X className="size-3.5" aria-hidden="true" />
              {submission === "rejecting" ? "Rejecting…" : "Confirm rejection"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
              }}
              className={actionButton}
            >
              Back
            </button>
          </>
        ) : (
          <>
            {approve.via === "request" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void send("approved");
                }}
                className={primaryButton}
              >
                <Check className="size-3.5" aria-hidden="true" />
                {submission === "approving"
                  ? "Approving…"
                  : item.kind === "plan"
                    ? "Approve these steps"
                    : "Approve this call"}
              </button>
            ) : (
              <Link href={approve.href} className={primaryButton}>
                Review the full diff
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            )}
            {reject.via === "request" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRejecting(true);
                }}
                className={actionButton}
              >
                Reject
              </button>
            ) : null}
          </>
        )}
        <Link
          href={runHref(item.runId)}
          className={cn(actionButton, "sm:ml-auto")}
          aria-label={`Open run ${name}`}
        >
          Open run
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </li>
  );
}

export function ApprovalsInbox({
  items,
  truncated,
  limit,
  renderedAt,
}: {
  items: InboxItem[];
  truncated: boolean;
  limit: number;
  renderedAt: number;
}) {
  const now = useClock(renderedAt);
  if (items.length === 0)
    return (
      <EmptyState title="Nothing is waiting for you">
        When a run asks before it acts, the request appears here with what it wants to do and the
        time left to answer: a plan before any agent starts, a connector tool call with its full
        arguments, or a change ready to ship with a summary of its diff.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
        {items.map((item) => (
          <Item key={item.approvalRowId} item={item} now={now} />
        ))}
      </ol>
      <p className="text-sm text-text-subtle">
        Soonest deadline first. A request nobody answers in time is rejected by the run itself.
        {truncated ? ` Showing the ${String(limit)} most recent requests.` : ""}
      </p>
    </div>
  );
}
