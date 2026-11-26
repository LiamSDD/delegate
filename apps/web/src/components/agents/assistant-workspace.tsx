"use client";

import { ArrowUpRight, Check, Copy } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { embedSnippet } from "@/lib/agents/embed";
import { AGENT_COMMAND_EVENT } from "@/lib/commands";
import type { AssistantArtifact, AssistantEvals, GapsReport } from "@/lib/m3-contract";
import { hostOf, passRateLabel } from "@/lib/runs/build-agent";
import { cn } from "@/lib/utils";

import { Chip, Eyebrow } from "../run/primitives";
import { AssistantChat } from "./assistant-chat";
import { corpusSummary, EvalResults, GapsList } from "./deliverables";

type PanelId = "embed" | "evals" | "gaps" | "settings";

const PANELS: { id: PanelId; label: string }[] = [
  { id: "embed", label: "Embed" },
  { id: "evals", label: "Evals" },
  { id: "gaps", label: "Gaps" },
  { id: "settings", label: "Settings" },
];

export interface AssistantWorkspaceProps {
  assistant: AssistantArtifact;
  evals: AssistantEvals | null;
  gaps: GapsReport | null;
  runId: string;
  runFinished: boolean;
  origin: string;
  maxQuestion: number;
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1600);
    });
  }, []);
  return [copied, copy];
}

function EmbedPanel({ assistant, origin }: { assistant: AssistantArtifact; origin: string }) {
  const snippet = embedSnippet(origin, assistant.id);
  const [copied, copy] = useCopy();

  useEffect(() => {
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "agent-copy-embed") copy(snippet);
    };
    window.addEventListener(AGENT_COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener(AGENT_COMMAND_EVENT, onCommand);
    };
  }, [copy, snippet]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Paste before <code className="font-mono text-xs text-text">&lt;/body&gt;</code> on any page.
        It adds a launcher in the corner that opens this assistant in an isolated frame.
      </p>
      <div className="relative rounded-lg border border-border bg-bg">
        <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs leading-5 text-text">
          <code>{snippet}</code>
        </pre>
        <button
          type="button"
          onClick={() => {
            copy(snippet);
          }}
          aria-label="Copy embed snippet"
          className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-md border border-border bg-surface text-text-muted hover:text-text"
        >
          {copied ? (
            <Check className="size-3.5 text-success" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <span aria-live="polite" className="sr-only">
          {copied ? "Snippet copied" : ""}
        </span>
      </div>
      <ul className="flex flex-col gap-1 font-mono text-2xs text-text-subtle">
        <li>Public chat: 20 questions per hour per visitor IP, 500 characters each.</li>
        <li>The frame only talks to {hostOf(origin)}; no cookies from the host page.</li>
      </ul>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Eyebrow>Preview</Eyebrow>
          <a
            href={`/embed/${assistant.id}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 font-mono text-2xs text-text-muted hover:text-accent"
          >
            Open frame
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </a>
        </div>
        <div className="relative h-[26rem] overflow-hidden rounded-xl border border-border bg-[repeating-linear-gradient(135deg,var(--color-surface-2)_0_1px,transparent_1px_12px)]">
          <iframe
            src={`/embed/${assistant.id}`}
            title={`${assistant.name} widget preview`}
            loading="lazy"
            className="absolute right-3 bottom-3 h-[23rem] w-[min(22rem,calc(100%-1.5rem))] rounded-xl border border-border bg-surface shadow-lg"
          />
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ assistant }: { assistant: AssistantArtifact }) {
  return (
    <dl className="flex flex-col gap-5 text-sm">
      <div className="flex flex-col gap-1.5">
        <dt>
          <Eyebrow>Scope</Eyebrow>
        </dt>
        <dd className="flex flex-col gap-1 text-text">
          <span>Covers: {assistant.scope.covers.join("; ")}</span>
          {assistant.scope.excludes.length === 0 ? null : (
            <span className="text-text-muted">Declines: {assistant.scope.excludes.join("; ")}</span>
          )}
        </dd>
      </div>
      <div className="flex flex-col gap-1.5">
        <dt>
          <Eyebrow>Refusal policy</Eyebrow>
        </dt>
        <dd className="text-text-muted">{assistant.refusalPolicy}</dd>
      </div>
      <div className="flex flex-col gap-1.5">
        <dt>
          <Eyebrow>Model chain</Eyebrow>
        </dt>
        <dd className="flex flex-col gap-1.5">
          {(
            [
              ["answer", assistant.modelChain.answer],
              ["rerank", assistant.modelChain.rerank],
            ] as const
          ).map(([role, chain]) => (
            <div key={role} className="flex flex-wrap items-center gap-1.5">
              <span className="w-14 font-mono text-2xs text-text-subtle">{role}</span>
              {chain.length === 0 ? (
                <span className="font-mono text-2xs text-text-subtle">none</span>
              ) : (
                chain.map((entry, index) => (
                  <Chip key={`${entry.provider}-${entry.model}`}>
                    {index + 1}. {entry.model} · {entry.provider}
                  </Chip>
                ))
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 font-mono text-2xs text-text-subtle">embed</span>
            {assistant.modelChain.embeddings === undefined ? (
              <span className="font-mono text-2xs text-text-subtle">
                none · {assistant.retrieval.mode} retrieval
              </span>
            ) : (
              <Chip>
                {assistant.modelChain.embeddings.model} · {assistant.modelChain.embeddings.provider}{" "}
                · {assistant.modelChain.embeddings.dimensions}d
              </Chip>
            )}
          </div>
        </dd>
      </div>
      <div className="flex flex-col gap-1.5">
        <dt>
          <Eyebrow>Prompt versions</Eyebrow>
        </dt>
        <dd className="flex flex-wrap gap-1.5">
          {Object.entries(assistant.prompts).map(([name, version]) => (
            <Chip key={name}>
              {name} v{version}
            </Chip>
          ))}
        </dd>
      </div>
      <div className="flex flex-col gap-1.5">
        <dt>
          <Eyebrow>System prompt · read-only</Eyebrow>
        </dt>
        <dd>
          <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-text-muted">
            {assistant.systemPrompt}
          </pre>
        </dd>
      </div>
    </dl>
  );
}

export function AssistantWorkspace({
  assistant,
  evals,
  gaps,
  runId,
  runFinished,
  origin,
  maxQuestion,
}: AssistantWorkspaceProps) {
  const [panel, setPanel] = useState<PanelId>("embed");
  const tabs = useRef<Record<PanelId, HTMLButtonElement | null>>({
    embed: null,
    evals: null,
    gaps: null,
    settings: null,
  });
  const passRate = evals?.passRate ?? assistant.passRate ?? null;

  useEffect(() => {
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "agent-copy-embed") setPanel("embed");
    };
    window.addEventListener(AGENT_COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener(AGENT_COMMAND_EVENT, onCommand);
    };
  }, []);

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = PANELS[(index + delta + PANELS.length) % PANELS.length];
    if (next === undefined) return;
    setPanel(next.id);
    tabs.current[next.id]?.focus();
  };

  return (
    <div className="flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[96rem] flex-col gap-4 px-4 py-5 md:px-6">
          <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-text-subtle">
            <Link href="/agents" className="hover:text-text">
              Agents
            </Link>
            <span aria-hidden="true">/</span>
            <span>{hostOf(assistant.url)}</span>
          </div>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-serif text-display-sm tracking-display text-balance text-text">
                  {assistant.name}
                </h1>
                <Chip
                  tone={passRate === null ? "neutral" : passRate >= 0.85 ? "success" : "warning"}
                >
                  evals {passRateLabel(passRate)}
                </Chip>
                {assistant.status === "ready" ? null : <Chip tone="warning">draft</Chip>}
              </div>
              <p className="max-w-2xl text-sm text-pretty text-text-muted">{assistant.goal}</p>
            </div>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              {corpusSummary(assistant.corpusStats).map((item) => (
                <div key={item.label} className="flex flex-col">
                  <span className="font-mono text-md font-medium text-text tabular">
                    {item.value}
                  </span>
                  <span className="font-mono text-2xs text-text-subtle">{item.label}</span>
                </div>
              ))}
              <div className="flex flex-col">
                <a
                  href={assistant.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex items-center gap-1 font-mono text-md text-text hover:text-accent"
                >
                  {hostOf(assistant.url)}
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
                <span className="font-mono text-2xs text-text-subtle">company</span>
              </div>
              <div className="flex flex-col">
                <Link
                  href={`/runs/${runId}`}
                  className="font-mono text-md text-text underline decoration-border-strong underline-offset-4 hover:text-accent"
                >
                  {runId.slice(0, 8)}
                </Link>
                <span className="font-mono text-2xs text-text-subtle">
                  built from run{runFinished ? "" : " · still running"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[96rem] grid-cols-1 gap-6 px-4 py-5 md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] xl:gap-8">
        <section
          aria-label="Chat"
          className="flex h-[min(44rem,calc(100dvh-14rem))] min-h-[28rem] flex-col"
        >
          <AssistantChat
            endpoint={`/api/agents/${assistant.id}/chat`}
            assistantName={assistant.name}
            starterQuestions={assistant.starterQuestions}
            maxQuestion={maxQuestion}
            listenForCommands
          />
        </section>

        <aside className="flex min-w-0 flex-col gap-4">
          <div
            role="tablist"
            aria-label="Assistant details"
            className="flex rounded-lg border border-border bg-surface-2 p-1"
          >
            {PANELS.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => {
                  tabs.current[item.id] = node;
                }}
                type="button"
                role="tab"
                id={`agent-tab-${item.id}`}
                aria-selected={panel === item.id}
                aria-controls={`agent-panel-${item.id}`}
                tabIndex={panel === item.id ? 0 : -1}
                onClick={() => {
                  setPanel(item.id);
                }}
                onKeyDown={(event) => {
                  onTabKey(event, index);
                }}
                className={cn(
                  "h-8 flex-1 rounded-md text-sm font-medium transition-colors",
                  panel === item.id
                    ? "bg-surface text-text shadow-sm"
                    : "text-text-muted hover:text-text",
                )}
              >
                {item.label}
                {item.id === "gaps" && gaps !== null && gaps.gaps.length > 0 ? (
                  <span className="ml-1 font-mono text-2xs text-text-subtle">
                    {gaps.gaps.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {PANELS.map((item) => (
            <div
              key={item.id}
              id={`agent-panel-${item.id}`}
              role="tabpanel"
              aria-labelledby={`agent-tab-${item.id}`}
              hidden={panel !== item.id}
            >
              {item.id === "embed" ? <EmbedPanel assistant={assistant} origin={origin} /> : null}
              {item.id === "evals" ? <EvalResults evals={evals} running={!runFinished} /> : null}
              {item.id === "gaps" ? <GapsList gaps={gaps} running={!runFinished} /> : null}
              {item.id === "settings" ? <SettingsPanel assistant={assistant} /> : null}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
