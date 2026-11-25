"use client";

import type { RunEvent, TestRunSummary } from "@delegate/runtime";
import {
  Check,
  Download,
  ExternalLink,
  FileCode2,
  GitPullRequest,
  RefreshCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { z } from "zod";

import {
  buildShipView,
  COMMAND_PURPOSE_LABELS,
  parsePatch,
  type PatchFile,
  type ShipCommandView,
  shipStatusLabel,
  type ShipView,
} from "@/lib/runs/ship";
import { formatDuration } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow, primaryButton, type Tone } from "./primitives";

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

function testTone(summary: TestRunSummary | null | undefined): Tone {
  if (summary === null || summary === undefined) return "neutral";
  if (summary.command === null) return "neutral";
  if (summary.timedOut === true) return "warning";
  return summary.passed === true ? "success" : "danger";
}

function testLabel(summary: TestRunSummary | null | undefined): string {
  if (summary === null || summary === undefined) return "pending";
  if (summary.command === null) return "none detected";
  if (summary.timedOut === true) return "timed out";
  return `${summary.passed === true ? "passed" : "failed"} · exit ${summary.exitCode ?? "?"} · ${formatDuration(summary.durationMs)}`;
}

function download(fileName: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1_000);
}

function TestComparison({ view }: { view: ShipView }) {
  const rows: { label: string; before: TestRunSummary | null; after: TestRunSummary | null }[] = [
    { label: "Tests", before: view.baseline?.test ?? null, after: view.after?.test ?? null },
    { label: "Lint", before: view.baseline?.lint ?? null, after: view.after?.lint ?? null },
    {
      label: "Typecheck",
      before: view.baseline?.typecheck ?? null,
      after: view.after?.typecheck ?? null,
    },
  ].filter((row) => row.label === "Tests" || row.before !== null || row.after !== null);
  return (
    <section aria-label="Tests before and after" className="flex flex-col gap-2">
      <Eyebrow>Repository checks · before → after</Eyebrow>
      <div className="overflow-hidden rounded-lg border border-border">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium text-text">{row.label}</span>
              <span className="truncate font-mono text-2xs text-text-subtle">
                {row.after?.command ??
                  row.before?.command ??
                  view.workspace?.profile.commands.test?.argv.join(" ") ??
                  "—"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={testTone(row.before)}>{testLabel(row.before)}</Chip>
              <span aria-hidden="true" className="text-text-subtle">
                →
              </span>
              <Chip tone={testTone(row.after)}>{testLabel(row.after)}</Chip>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DiffFileView({ file }: { file: PatchFile }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex w-full items-center gap-2 bg-surface-2 px-3 py-2 text-left"
      >
        <FileCode2 className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">{file.path}</span>
        <Chip
          tone={
            file.status === "added" ? "success" : file.status === "deleted" ? "danger" : "neutral"
          }
        >
          {file.status}
        </Chip>
        <span className="font-mono text-2xs text-success tabular">+{file.additions}</span>
        <span className="font-mono text-2xs text-danger tabular">−{file.deletions}</span>
      </button>
      {open ? (
        file.binary ? (
          <p className="px-3 py-2 text-xs text-text-muted">
            Binary file; download the patch to inspect it.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-2xs leading-5">
              <tbody>
                {file.hunks.flatMap((hunk, hunkIndex) => [
                  <tr key={`h${hunkIndex}`} className="bg-accent-soft/40 text-text-subtle">
                    <td colSpan={3} className="px-3 py-0.5 whitespace-pre">
                      {hunk.header}
                    </td>
                  </tr>,
                  ...hunk.lines.map((line, lineIndex) => (
                    <tr
                      key={`l${hunkIndex}-${lineIndex}`}
                      className={cn(
                        line.kind === "add" && "bg-success-soft/50",
                        line.kind === "del" && "bg-danger-soft/50",
                      )}
                    >
                      <td className="w-10 px-2 text-right text-text-subtle tabular select-none">
                        {line.oldNo ?? ""}
                      </td>
                      <td className="w-10 px-2 text-right text-text-subtle tabular select-none">
                        {line.newNo ?? ""}
                      </td>
                      <td className="px-2 whitespace-pre text-text">
                        <span aria-hidden="true" className="mr-1 text-text-subtle select-none">
                          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                        </span>
                        <span className="sr-only">
                          {line.kind === "add" ? "added: " : line.kind === "del" ? "removed: " : ""}
                        </span>
                        {line.text}
                      </td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

function DiffViewer({ view }: { view: ShipView }) {
  const files = useMemo(() => (view.diff === null ? [] : parsePatch(view.diff.patch)), [view.diff]);
  if (view.diff === null) return null;
  return (
    <section aria-label="Diff" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>
          Diff · {view.diff.stat.files} file{view.diff.stat.files === 1 ? "" : "s"}
        </Eyebrow>
        <span className="font-mono text-2xs text-success tabular">+{view.diff.stat.additions}</span>
        <span className="font-mono text-2xs text-danger tabular">−{view.diff.stat.deletions}</span>
        <span className="font-mono text-2xs text-text-subtle">
          base {view.diff.baseSha.slice(0, 7)} · {view.diff.rounds} round
          {view.diff.rounds === 1 ? "" : "s"}
        </span>
      </div>
      {view.diff.summary === "" ? null : (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <span className="font-medium text-text">
            Engineer’s note (model output, unverified):{" "}
          </span>
          {view.diff.summary}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {files.map((file) => (
          <DiffFileView key={file.path} file={file} />
        ))}
      </div>
    </section>
  );
}

function CommandRow({ command }: { command: ShipCommandView }) {
  const [open, setOpen] = useState(command.exitCode !== 0);
  const failed = command.exitCode !== 0;
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className="w-16 shrink-0 font-mono text-2xs text-text-subtle uppercase">
          {COMMAND_PURPOSE_LABELS[command.purpose]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">
          $ {command.command}
        </span>
        <Chip tone={command.timedOut ? "warning" : failed ? "danger" : "success"}>
          {command.timedOut ? "timeout" : `exit ${command.exitCode ?? "?"}`}
        </Chip>
        <span className="hidden w-14 text-right font-mono text-2xs text-text-subtle tabular sm:inline">
          {formatDuration(command.durationMs)}
        </span>
      </button>
      {open && command.output !== "" ? (
        <pre className="max-h-64 overflow-auto bg-surface-2 px-3 py-2 font-mono text-2xs leading-4 whitespace-pre-wrap text-text-muted">
          {command.truncated ? "… (earlier output truncated)\n" : ""}
          {command.output}
        </pre>
      ) : null}
    </li>
  );
}

function CommandLog({
  commands,
  running,
}: {
  commands: readonly ShipCommandView[];
  running: boolean;
}) {
  return (
    <section aria-label="Sandbox command log" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Terminal className="size-3.5 text-text-subtle" aria-hidden="true" />
        <Eyebrow>Sandbox commands · {commands.length}</Eyebrow>
        {running ? (
          <span
            className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse"
            aria-hidden="true"
          />
        ) : null}
      </div>
      {commands.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-text-muted">
          {running ? "Waiting for the sandbox to start…" : "No command ran."}
        </p>
      ) : (
        <ol aria-live="polite" className="overflow-hidden rounded-lg border border-border">
          {commands.map((command) => (
            <CommandRow key={command.key} command={command} />
          ))}
        </ol>
      )}
    </section>
  );
}

type Submission = "idle" | "approving" | "rejecting" | "sent";

function ShipApprovalCard({ runId, view }: { runId: string; view: ShipView }) {
  const approval = view.approval;
  const [submission, setSubmission] = useState<Submission>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const headingId = useId();
  if (approval?.status !== "pending") return null;
  const busy = submission !== "idle";
  const pr = approval.mode === "pull_request";

  const send = async (body: unknown, mode: "approving" | "rejecting") => {
    setSubmission(mode);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/ship`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        setSubmission("sent");
        return;
      }
      const parsed = errorSchema.safeParse(await response.json().catch(() => null));
      setError(
        parsed.success ? parsed.data.error.message : `The server answered HTTP ${response.status}.`,
      );
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setSubmission("idle");
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-surface p-4 shadow-md motion-safe:animate-card-in"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          {pr ? (
            <GitPullRequest className="size-4" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Eyebrow>Approval needed · {pr ? "pull request" : "patch"}</Eyebrow>
          <h2 id={headingId} className="text-lg font-medium text-text">
            {pr ? `Open a pull request on ${approval.repo}?` : "Hand over this change as a patch?"}
          </h2>
          <p className="text-sm text-text-muted">{approval.reason}</p>
          <p className="font-mono text-2xs break-all text-text-subtle">
            {pr ? `${approval.branch} → ${approval.base}` : approval.branch} ·{" "}
            {approval.diffStat.files} file
            {approval.diffStat.files === 1 ? "" : "s"} · +{approval.diffStat.additions} −
            {approval.diffStat.deletions}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
        <span>Tests</span>
        <Chip tone={testTone(approval.baseline)}>{testLabel(approval.baseline)}</Chip>
        <span aria-hidden="true">→</span>
        <Chip tone={testTone(approval.after)}>{testLabel(approval.after)}</Chip>
      </div>
      {submission === "sent" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
          <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
          Decision recorded; the run continues.
        </p>
      ) : rejecting ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Reason (optional, kept in the audit log)
            <input
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-text"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className={actionButton}
              onClick={() => {
                void send(
                  reason.trim() === ""
                    ? { decision: "rejected" }
                    : { decision: "rejected", reason: reason.trim() },
                  "rejecting",
                );
              }}
            >
              <X className="size-3.5" aria-hidden="true" />
              {submission === "rejecting" ? "Rejecting…" : "Reject"}
            </button>
            <button
              type="button"
              disabled={busy}
              className={actionButton}
              onClick={() => {
                setRejecting(false);
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className={primaryButton}
            onClick={() => {
              void send({ decision: "approved" }, "approving");
            }}
          >
            <Check className="size-3.5" aria-hidden="true" />
            {submission === "approving"
              ? "Approving…"
              : pr
                ? "Approve and open PR"
                : "Approve patch"}
          </button>
          <button
            type="button"
            disabled={busy}
            className={actionButton}
            onClick={() => {
              setRejecting(true);
            }}
          >
            <X className="size-3.5" aria-hidden="true" />
            Reject
          </button>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <p className="text-2xs text-text-subtle">
        Review the diff below first. Nothing leaves the sandbox until you decide; without a decision
        the request times out as rejected.
      </p>
    </section>
  );
}

function ShipResultCard({ view }: { view: ShipView }) {
  const result = view.result;
  if (result === null) return null;
  if (result.status === "opened" && view.pullRequest !== null)
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-success/40 bg-success-soft/30 p-4">
        <Eyebrow>Shipped</Eyebrow>
        <a
          href={view.pullRequest.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-2 text-lg font-medium text-text underline-offset-4 hover:underline"
        >
          <GitPullRequest className="size-4 text-success" aria-hidden="true" />
          {view.pullRequest.repo}#{view.pullRequest.number}
          <ExternalLink className="size-3.5 text-text-subtle" aria-hidden="true" />
        </a>
        <p className="font-mono text-2xs text-text-subtle">
          {view.pullRequest.branch} → {view.pullRequest.base} · commit{" "}
          {view.pullRequest.commitSha.slice(0, 7)}
        </p>
      </section>
    );
  if (result.status === "patch_ready" && result.patch !== undefined) {
    const patch = result.patch;
    return (
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <Eyebrow>Patch ready</Eyebrow>
        <p className="text-sm text-text-muted">{result.reason}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryButton}
            onClick={() => {
              download(patch.fileName, patch.content, "text/x-diff");
            }}
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download {patch.fileName}
          </button>
          {result.testReport === undefined ? null : (
            <button
              type="button"
              className={actionButton}
              onClick={() => {
                download(
                  patch.fileName.replace(/\.patch$/, "-tests.md"),
                  result.testReport ?? "",
                  "text/markdown",
                );
              }}
            >
              <Download className="size-3.5" aria-hidden="true" />
              Test report
            </button>
          )}
        </div>
        <p className="font-mono text-2xs text-text-subtle">
          Apply with: git apply {patch.fileName}
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-border bg-surface-2 p-4">
      <Eyebrow>Not shipped</Eyebrow>
      <p className="text-sm text-text-muted">{result.reason}</p>
    </section>
  );
}

export function ShipPanel({
  runId,
  events,
  running,
}: {
  runId: string;
  events: readonly RunEvent[];
  running: boolean;
}) {
  const view = useMemo(() => buildShipView(events), [events]);
  const status = shipStatusLabel(view, running);
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Eyebrow>Ship-a-PR{view.repo === null ? "" : ` · ${view.repo}`}</Eyebrow>
        <h2 className="font-serif text-xl tracking-display text-text">
          {view.title ?? "Improvement"}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            tone={
              view.result?.status === "opened"
                ? "success"
                : view.approval?.status === "pending"
                  ? "accent"
                  : "neutral"
            }
          >
            {status}
          </Chip>
          {view.workspace === null ? null : (
            <span className="font-mono text-2xs text-text-subtle">
              {view.workspace.sandboxKind} sandbox · {view.workspace.profile.ecosystem}
              {view.workspace.profile.packageManager === null
                ? ""
                : ` · ${view.workspace.profile.packageManager}`}{" "}
              · base {view.workspace.baseSha.slice(0, 7)}
            </span>
          )}
        </div>
      </header>
      <ShipApprovalCard runId={runId} view={view} />
      <ShipResultCard view={view} />
      {view.acceptance.length === 0 ? null : (
        <section aria-label="Acceptance criteria" className="flex flex-col gap-1.5">
          <Eyebrow>Acceptance criteria · for your review</Eyebrow>
          <ul className="flex flex-col gap-1 text-sm text-text-muted">
            {view.acceptance.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-text-subtle">
                  ☐
                </span>
                {item}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TestComparison view={view} />
      <DiffViewer view={view} />
      <CommandLog commands={view.commands} running={running} />
    </div>
  );
}
