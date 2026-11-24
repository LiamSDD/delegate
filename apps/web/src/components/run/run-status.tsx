"use client";

import {
  CircleCheck,
  CircleSlash,
  FileWarning,
  Gauge,
  Globe,
  RefreshCw,
  ShieldX,
  Unplug,
  Wallet,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";

import { type Brief, briefStats } from "@/lib/runs/brief";
import { formatDuration, type Outcome } from "@/lib/runs/run-view";
import { startCompanyXray } from "@/lib/runs/start-run";
import type { StreamState } from "@/lib/runs/stream-state";
import { MAX_AUTO_RETRIES } from "@/lib/runs/stream-state";
import { cn } from "@/lib/utils";

import { actionButton, primaryButton } from "./primitives";

function Banner({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center",
        tone === "neutral" && "border-border bg-surface",
        tone === "accent" && "border-accent/30 bg-accent-soft/60",
        tone === "success" && "border-success/30 bg-success-soft/60",
        tone === "warning" && "border-warning/40 bg-warning-soft/60",
        tone === "danger" && "border-danger/40 bg-danger-soft/60",
      )}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 shrink-0",
            tone === "neutral" && "text-text-muted",
            tone === "accent" && "text-accent",
            tone === "success" && "text-success",
            tone === "warning" && "text-warning",
            tone === "danger" && "text-danger",
          )}
        >
          {icon}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-text">{title}</p>
          {children === undefined ? null : (
            <div className="text-sm text-text-muted">{children}</div>
          )}
        </div>
      </div>
      {action === undefined ? null : <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

export function RunAgainButton({
  input,
  label = "Run again",
}: {
  input: { url: string; focus?: string } | null;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (input === null) return null;
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() => {
          setPending(true);
          setError(null);
          void startCompanyXray(input).then((result) => {
            if (result.ok) {
              router.push(`/runs/${result.runId}`);
              return;
            }
            setPending(false);
            setError(result.message);
          });
        }}
      >
        <RefreshCw
          className={cn("size-3.5", pending && "motion-safe:animate-spin")}
          aria-hidden="true"
        />
        {pending ? "Starting…" : label}
      </button>
      {error === null ? null : (
        <span role="alert" className="max-w-64 text-right text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

export function StreamBanner({
  stream,
  onReconnect,
}: {
  stream: StreamState;
  onReconnect: () => void;
}) {
  const reconnect = (
    <button type="button" className={actionButton} onClick={onReconnect}>
      <RefreshCw className="size-3.5" aria-hidden="true" />
      Reconnect
    </button>
  );
  switch (stream.phase) {
    case "connecting":
      return (
        <Banner
          tone="neutral"
          icon={<RefreshCw className="size-4 motion-safe:animate-spin" />}
          title="Connecting to the run…"
        />
      );
    case "replaying":
      return (
        <Banner
          tone="accent"
          icon={<RefreshCw className="size-4 motion-safe:animate-spin" />}
          title={`Replaying ${String(stream.replayCount ?? 0)} event${stream.replayCount === 1 ? "" : "s"}…`}
        >
          Rebuilding the view from the run’s event log.
        </Banner>
      );
    case "reconnecting":
      return (
        <Banner
          tone="warning"
          icon={<Unplug className="size-4" />}
          title="Connection lost. Reconnecting…"
          action={reconnect}
        >
          Attempt {stream.attempt} of {MAX_AUTO_RETRIES}. The run keeps going on the server; the
          view resumes from the last event it received.
        </Banner>
      );
    case "disconnected":
      return (
        <Banner
          tone="danger"
          icon={<Unplug className="size-4" />}
          title="Stream disconnected"
          action={reconnect}
        >
          Automatic retries gave up. The run may still be in progress on the server.
        </Banner>
      );
    case "live":
    case "ended":
    case "not_found":
      return null;
  }
}

const OUTCOME_COPY: Record<
  Exclude<Outcome["kind"], "completed">,
  { title: string; tone: "neutral" | "warning" | "danger"; icon: ReactNode }
> = {
  failed: { title: "Run failed", tone: "danger", icon: <XCircle className="size-4" /> },
  cancelled: { title: "Stopped by you", tone: "neutral", icon: <CircleSlash className="size-4" /> },
  budget: { title: "Budget reached", tone: "warning", icon: <Wallet className="size-4" /> },
  policy: { title: "Stopped by policy", tone: "danger", icon: <ShieldX className="size-4" /> },
  capacity: {
    title: "Free model capacity used up",
    tone: "warning",
    icon: <Gauge className="size-4" />,
  },
  site_unreachable: {
    title: "Could not read the company site",
    tone: "warning",
    icon: <Globe className="size-4" />,
  },
  invalid_input: {
    title: "Input rejected",
    tone: "neutral",
    icon: <CircleSlash className="size-4" />,
  },
  synthesis_invalid: {
    title: "The brief did not pass validation",
    tone: "danger",
    icon: <FileWarning className="size-4" />,
  },
  worker_lost: {
    title: "The worker stopped responding",
    tone: "danger",
    icon: <Unplug className="size-4" />,
  },
  runtime_unavailable: {
    title: "Runtime not available",
    tone: "neutral",
    icon: <CircleSlash className="size-4" />,
  },
};

export function OutcomeBanner({
  outcome,
  durationMs,
  brief,
  input,
}: {
  outcome: Outcome;
  durationMs: number;
  brief: Brief | null;
  input: { url: string; focus?: string } | null;
}) {
  if (outcome.kind === "completed") {
    const stats = brief === null ? null : briefStats(brief);
    return (
      <Banner
        tone="success"
        icon={<CircleCheck className="size-4" />}
        title="Run completed"
        action={<RunAgainButton input={input} />}
      >
        <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-text-muted tabular">
          <div className="flex gap-1.5">
            <dt>duration</dt>
            <dd className="text-text">{formatDuration(durationMs)}</dd>
          </div>
          {stats === null ? (
            <div className="flex gap-1.5">
              <dt>brief</dt>
              <dd className="text-text">none</dd>
            </div>
          ) : (
            <>
              <div className="flex gap-1.5">
                <dt>sources</dt>
                <dd className="text-text">{stats.sources}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt>claims</dt>
                <dd className="text-text">{stats.claims}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt>citations resolved</dt>
                <dd className="text-text">
                  {stats.verifiedCitations}/{stats.citations}
                </dd>
              </div>
              {stats.insufficient === 0 ? null : (
                <div className="flex gap-1.5">
                  <dt>gaps</dt>
                  <dd className="text-text">{stats.insufficient}</dd>
                </div>
              )}
            </>
          )}
        </dl>
        <p className="mt-1">{outcome.message}</p>
      </Banner>
    );
  }
  const copy = OUTCOME_COPY[outcome.kind];
  return (
    <Banner
      tone={copy.tone}
      icon={copy.icon}
      title={copy.title}
      action={<RunAgainButton input={input} />}
    >
      <p>
        {outcome.message}
        {outcome.code === null ? null : (
          <span className="ml-1.5 font-mono text-2xs text-text-subtle">{outcome.code}</span>
        )}
      </p>
      <p className="font-mono text-2xs text-text-subtle">after {formatDuration(durationMs)}</p>
    </Banner>
  );
}
