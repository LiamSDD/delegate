"use client";

import {
  ArrowRightLeft,
  Ban,
  CircleCheck,
  Hand,
  MessageSquareText,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";

import { type ActivityItem, formatDuration } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { Chip, Eyebrow } from "./primitives";

const FALLBACK_REASONS: Record<string, string> = {
  rate_limited: "rate limited",
  server_error: "server error",
  timeout: "timed out",
  network_error: "network error",
  context_too_small: "context too small",
  tools_unsupported: "tools unsupported",
  unhealthy: "unhealthy",
  client_error: "request rejected",
  model_unavailable: "model unavailable",
  exceeds_provider_capacity: "over provider capacity",
};

function Card({
  tone = "neutral",
  icon,
  children,
  fresh,
}: {
  tone?: "neutral" | "success" | "warning" | "danger";
  icon: ReactNode;
  children: ReactNode;
  fresh: boolean;
}) {
  return (
    <li
      className={cn(
        "flex gap-3 rounded-lg border bg-surface px-3 py-2.5 shadow-sm",
        tone === "neutral" && "border-border",
        tone === "success" && "border-success/30",
        tone === "warning" && "border-warning/40 bg-warning-soft/40",
        tone === "danger" && "border-danger/40 bg-danger-soft/40",
        fresh && "motion-safe:animate-card-in",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0",
          tone === "neutral" && "text-text-subtle",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </li>
  );
}

const iconClass = "size-4";

function ToolCard({
  item,
  fresh,
}: {
  item: Extract<ActivityItem, { kind: "tool" }>;
  fresh: boolean;
}) {
  const tone = item.status === "error" ? "danger" : "neutral";
  return (
    <Card tone={tone} icon={<Wrench className={iconClass} />} fresh={fresh}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-sm font-medium break-all text-text">
          {item.tool}
        </span>
        {item.host === null ? null : (
          <span className="min-w-0 truncate font-mono text-xs text-text-muted">{item.host}</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {item.durationMs === null ? null : (
            <span className="font-mono text-2xs text-text-subtle tabular">
              {formatDuration(item.durationMs)}
            </span>
          )}
          {item.status === "running" ? (
            <Chip tone="accent">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
              />
              running
            </Chip>
          ) : item.status === "ok" ? (
            <Chip tone="success">
              <CircleCheck className="size-3" aria-hidden="true" />
              ok
            </Chip>
          ) : (
            <Chip tone="danger">error</Chip>
          )}
        </span>
      </div>
      {item.summary === null ? (
        <p className="truncate font-mono text-xs text-text-subtle">{item.argsSummary}</p>
      ) : (
        <p className="text-xs break-words text-text-muted">{item.summary}</p>
      )}
      {item.error === null ? null : <p className="text-xs break-words text-danger">{item.error}</p>}
    </Card>
  );
}

function PolicyCard({
  item,
  fresh,
}: {
  item: Extract<ActivityItem, { kind: "policy" }>;
  fresh: boolean;
}) {
  if (item.decision === "allow") {
    return (
      <Card tone="success" icon={<ShieldCheck className={iconClass} />} fresh={fresh}>
        <p className="text-sm">
          <span className="font-medium text-success">Allowed</span>{" "}
          <span className="font-mono text-xs text-text-muted">{item.tool}</span>
        </p>
        <p className="text-xs break-words text-text-muted">
          {item.reason} <span className="font-mono text-text-subtle">· {item.policyId}</span>
        </p>
      </Card>
    );
  }
  const deny = item.decision === "deny";
  return (
    <Card
      tone={deny ? "danger" : "warning"}
      icon={deny ? <Ban className={iconClass} /> : <Hand className={iconClass} />}
      fresh={fresh}
    >
      <p className="text-sm">
        <span className={cn("font-medium", deny ? "text-danger" : "text-warning")}>
          {deny ? "Denied by policy" : "Needs approval"}
        </span>{" "}
        <span className="font-mono text-xs text-text-muted">{item.tool}</span>
      </p>
      <p className="text-xs break-words text-text">{item.reason}</p>
      <p className="font-mono text-2xs break-all text-text-subtle">rule {item.policyId}</p>
    </Card>
  );
}

function FlagCard({
  item,
  fresh,
}: {
  item: Extract<ActivityItem, { kind: "flag" }>;
  fresh: boolean;
}) {
  return (
    <Card
      tone="warning"
      icon={
        item.injection ? (
          <ShieldAlert className={iconClass} />
        ) : (
          <TriangleAlert className={iconClass} />
        )
      }
      fresh={fresh}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-warning">
        {item.injection ? "Prompt injection suspected" : "Critic flag"}
        <Chip tone="warning">{item.severity}</Chip>
      </p>
      <blockquote className="rounded-md border border-warning/30 bg-surface px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap text-text">
        {item.claim}
      </blockquote>
      <p className="text-xs break-words text-text">
        <span className="font-medium">Verdict: </span>
        {item.reason.replace(/^Verdict:\s*/i, "")}
        {item.sourceId === null ? null : (
          <span className="font-mono text-text-subtle"> · source {item.sourceId}</span>
        )}
      </p>
      {item.injection ? (
        <p className="text-2xs text-text-subtle">
          Quoted as inert text. The span was not passed to a privileged agent.
        </p>
      ) : null}
    </Card>
  );
}

function MessageCard({
  item,
  fresh,
}: {
  item: Extract<ActivityItem, { kind: "message" }>;
  fresh: boolean;
}) {
  return (
    <Card icon={<MessageSquareText className={iconClass} />} fresh={fresh}>
      <p className="font-mono text-2xs text-text-subtle">{item.agentId}</p>
      <p className="text-sm break-words whitespace-pre-wrap text-text">{item.text}</p>
    </Card>
  );
}

function FallbackCard({
  item,
  fresh,
}: {
  item: Extract<ActivityItem, { kind: "fallback" }>;
  fresh: boolean;
}) {
  return (
    <Card tone="warning" icon={<ArrowRightLeft className={iconClass} />} fresh={fresh}>
      <p className="text-sm">
        <span className="font-medium text-warning">Model fallback</span>{" "}
        <span className="font-mono text-2xs text-text-subtle">{item.role}</span>
      </p>
      <p className="font-mono text-xs break-words text-text-muted">
        {item.from.provider} · {item.from.model} →{" "}
        {item.to === null ? "no model left in the chain" : `${item.to.provider} · ${item.to.model}`}
      </p>
      <p className="text-xs text-text-muted">
        {FALLBACK_REASONS[item.reason] ?? item.reason}
        {item.retryAfterMs === null ? null : `, retry after ${formatDuration(item.retryAfterMs)}`}
      </p>
    </Card>
  );
}

function ApprovalCard({
  item,
  fresh,
}: {
  item: Extract<ActivityItem, { kind: "approval" }>;
  fresh: boolean;
}) {
  return (
    <Card tone="warning" icon={<Hand className={iconClass} />} fresh={fresh}>
      <p className="text-sm font-medium text-warning">Approval requested</p>
      <p className="text-sm break-words text-text">{item.summary}</p>
      <p className="text-xs break-words text-text-muted">
        {item.reason} <span className="font-mono text-text-subtle">· {item.policyId}</span>
      </p>
    </Card>
  );
}

export function ActivityItemCard({ item, fresh }: { item: ActivityItem; fresh: boolean }) {
  switch (item.kind) {
    case "tool":
      return <ToolCard item={item} fresh={fresh} />;
    case "policy":
      return <PolicyCard item={item} fresh={fresh} />;
    case "flag":
      return <FlagCard item={item} fresh={fresh} />;
    case "message":
      return <MessageCard item={item} fresh={fresh} />;
    case "fallback":
      return <FallbackCard item={item} fresh={fresh} />;
    case "approval":
      return <ApprovalCard item={item} fresh={fresh} />;
  }
}

export function ActivityLane({
  items,
  liveFromSeq,
  waiting,
}: {
  items: readonly ActivityItem[];
  liveFromSeq: number | null;
  waiting: boolean;
}) {
  return (
    <section aria-labelledby="activity-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="activity-heading">
          <Eyebrow>Agent activity</Eyebrow>
        </h2>
        <span className="font-mono text-2xs text-text-subtle tabular">{items.length} items</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-text-muted">
          {waiting
            ? "Tool calls, policy decisions and agent messages appear here as they happen."
            : "This run recorded no agent activity."}
        </div>
      ) : (
        <ol role="log" aria-live="off" className="flex flex-col gap-2">
          {items.map((item) => (
            <ActivityItemCard
              key={item.key}
              item={item}
              fresh={liveFromSeq !== null && item.seq > liveFromSeq}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
