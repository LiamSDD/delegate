"use client";

import { Check, Copy, FileWarning } from "lucide-react";
import { useMemo, useState } from "react";

import { missionLabel } from "@/lib/m2-contract";
import { type CitationTarget } from "@/lib/runs/brief";
import {
  goalBriefToMarkdown,
  goalCitationIndex,
  levelLabel,
  parseGoalBrief,
} from "@/lib/runs/goal";
import type { BriefArtifact } from "@/lib/runs/run-view";

import { CitationMarker } from "./brief-panel";
import { actionButton, Chip, Eyebrow } from "./primitives";
import { PartialNotice } from "./partial-notice";

function Cites({
  citations,
  index,
}: {
  citations: readonly string[];
  index: Map<string, CitationTarget>;
}) {
  return citations.map((sourceId) => {
    const target = index.get(sourceId);
    return target === undefined ? null : <CitationMarker key={sourceId} target={target} />;
  });
}

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h4 id={id} className="text-sm font-medium text-text">
      {children}
    </h4>
  );
}

export function GoalBriefPanel({
  artifact,
  running,
}: {
  artifact: BriefArtifact | null;
  running: boolean;
}) {
  const parsed = useMemo(
    () =>
      artifact === null || artifact.content === null ? null : parseGoalBrief(artifact.content),
    [artifact],
  );
  const brief = parsed?.ok === true ? parsed.brief : null;
  const index = useMemo(
    () => (brief === null ? new Map<string, CitationTarget>() : goalCitationIndex(brief)),
    [brief],
  );
  const [copied, setCopied] = useState(false);

  return (
    <section aria-labelledby="goal-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id="goal-heading">
            <Eyebrow>Goal brief</Eyebrow>
          </h2>
          {artifact === null ? null : (
            <span className="font-mono text-2xs text-text-subtle">v{artifact.version}</span>
          )}
        </div>
        {brief === null ? null : (
          <button
            type="button"
            className={actionButton}
            onClick={() => {
              void navigator.clipboard.writeText(goalBriefToMarkdown(brief)).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                }, 2000);
              });
            }}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy Markdown"}
          </button>
        )}
      </div>

      {artifact === null || artifact.content === null ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
          {running
            ? "The goal brief renders here once the editor has drafted it from the research."
            : "This run produced no goal brief."}
        </div>
      ) : parsed?.ok === false ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger-soft/40 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-danger">
            <FileWarning className="size-4" aria-hidden="true" />
            Unexpected artifact shape
          </p>
          <p className="text-sm text-text-muted">
            Version {artifact.contentVersion ?? artifact.version} does not match the goal brief
            schema, so it is not rendered. Nothing was guessed.
          </p>
          <ul className="font-mono text-2xs text-text-muted">
            {parsed.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : brief === null ? null : (
        <article className="flex flex-col gap-6">
          <PartialNotice partial={brief.partial} />
          <div className="flex flex-col gap-2">
            <h3 className="font-serif text-xl tracking-display text-balance text-text">
              {brief.objective}
            </h3>
            <p className="text-sm text-text-muted">
              {brief.company === null ? (
                "No company named; research covered the topic."
              ) : (
                <>
                  {brief.company.name}{" "}
                  <a
                    href={brief.company.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="font-mono text-xs underline decoration-border-strong underline-offset-4 hover:text-accent"
                  >
                    {new URL(brief.company.url).hostname.replace(/^www\./, "")}
                  </a>{" "}
                  <span className="font-mono text-2xs text-text-subtle">
                    {brief.company.resolvedBy === "wikidata"
                      ? `resolved via Wikidata ${brief.company.entity ?? ""}`
                      : brief.company.resolvedBy === "input"
                        ? "given"
                        : "named in the goal"}
                  </span>
                </>
              )}
            </p>
            {brief.status === "draft" ? (
              <Chip tone="neutral" className="w-fit">
                draft · critic pending
              </Chip>
            ) : null}
            {brief.verification === undefined ? null : (
              <p className="font-mono text-2xs text-text-subtle">
                {brief.verification.citationAccuracy === null
                  ? "citations unchecked"
                  : `citations ${String(Math.round(brief.verification.citationAccuracy * 100))}% supported`}
                {brief.verification.specificity.score === null
                  ? ""
                  : ` · specificity ${String(Math.round(brief.verification.specificity.score * 100))}%`}
                {brief.verification.specificity.generic === 0
                  ? ""
                  : ` (${String(brief.verification.specificity.generic)} generic claims moved or dropped)`}
                {brief.verification.research === undefined
                  ? ""
                  : ` · ${String(brief.verification.research.rounds.length)} research round${brief.verification.research.rounds.length === 1 ? "" : "s"}`}
              </p>
            )}
          </div>

          {brief.context === undefined || brief.context.length === 0 ? null : (
            <aside
              aria-label="Context"
              className="rounded-md border border-border bg-surface-2/60 px-3 py-2 text-sm leading-6 text-text-muted"
            >
              <span className="font-mono text-2xs uppercase tracking-wide text-text-subtle">
                Context
              </span>
              {brief.context.map((line, c) => (
                <p key={String(c)}>
                  {line.text}
                  <Cites citations={line.citations} index={index} />
                </p>
              ))}
            </aside>
          )}

          {brief.workstreams.length === 0 ? (
            <p className="rounded-md border border-border bg-surface-2/60 px-3 py-2 text-sm text-text-muted">
              No finding survived citation checks, so there are no workstreams. Nothing was guessed.
            </p>
          ) : (
            brief.workstreams.map((stream, s) => (
              <section
                key={stream.name}
                aria-labelledby={`stream-${String(s)}`}
                className="flex flex-col gap-2"
              >
                <Heading id={`stream-${String(s)}`}>{stream.name}</Heading>
                <ul className="flex flex-col gap-1.5">
                  {stream.findings.map((finding, f) => (
                    <li key={`${String(s)}-${String(f)}`} className="text-sm leading-6 text-text">
                      {finding.text}
                      <Cites citations={finding.citations} index={index} />
                      {finding.support === undefined ? null : (
                        <Chip tone="warning" className="ml-2">
                          {finding.support}
                        </Chip>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}

          <section aria-labelledby="goal-actions" className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <Heading id="goal-actions">Action plan</Heading>
              <p className="font-mono text-2xs text-text-subtle">{brief.rankFormula}</p>
            </div>
            {brief.actions.length === 0 ? (
              <p className="text-sm text-text-subtle">No cited action could be proposed.</p>
            ) : (
              <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {brief.actions.map((action) => (
                  <li key={action.rank} className="flex gap-3 px-3 py-3">
                    <span className="w-5 shrink-0 font-mono text-sm leading-6 text-text-subtle tabular">
                      {action.rank}
                    </span>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="text-sm leading-6 font-medium text-text">{action.title}</p>
                      <p className="text-sm leading-6 text-text-muted">
                        {action.basis.text}
                        <Cites citations={action.basis.citations} index={index} />
                      </p>
                      {action.firstStep === undefined ? null : (
                        <p className="text-sm leading-6 text-text">
                          <span className="text-text-subtle">First step: </span>
                          {action.firstStep}
                        </p>
                      )}
                      {action.successMetric === undefined ? null : (
                        <p className="text-sm leading-6 text-text">
                          <span className="text-text-subtle">Success: </span>
                          {action.successMetric}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        <Chip>{action.owner}</Chip>
                        <Chip>effort {levelLabel(action.effort).toLowerCase()}</Chip>
                        <Chip tone={action.impact === "high" ? "success" : "neutral"}>
                          impact {levelLabel(action.impact).toLowerCase()}
                        </Chip>
                        <Chip>score {action.score}</Chip>
                        {action.mission === null ? null : (
                          <Chip tone="accent">{missionLabel(action.mission)}</Chip>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {brief.risks.length === 0 ? null : (
            <section aria-labelledby="goal-risks" className="flex flex-col gap-2">
              <Heading id="goal-risks">Risks</Heading>
              <ul className="flex flex-col gap-1.5">
                {brief.risks.map((risk, r) => (
                  <li key={String(r)} className="text-sm leading-6 text-text">
                    {risk.text}
                    <Cites citations={risk.citations} index={index} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {brief.openQuestions.length === 0 ? null : (
            <section aria-labelledby="goal-questions" className="flex flex-col gap-2">
              <Heading id="goal-questions">Open questions</Heading>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-6 text-text-muted">
                {brief.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </section>
          )}

          <section
            aria-labelledby="goal-sources"
            className="flex flex-col gap-2 border-t border-border pt-4"
          >
            <h4 id="goal-sources" className="text-sm font-medium text-text">
              Sources{" "}
              <span className="font-mono text-2xs text-text-subtle">{brief.sources.length}</span>
            </h4>
            {brief.sources.length === 0 ? (
              <p className="text-sm text-text-subtle">No cited sources.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {brief.sources.map((source) => (
                  <li key={source.sourceId} className="flex gap-2 text-sm">
                    <span className="w-5 shrink-0 font-mono text-2xs leading-5 text-text-subtle tabular">
                      {index.get(source.sourceId)?.number ?? "–"}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="truncate text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
                      >
                        {source.title || source.url}
                      </a>
                      <span className="font-mono text-2xs text-text-subtle">
                        {source.kind.replace("_", " ")} · fetched{" "}
                        {new Date(source.fetchedAt).toLocaleString()}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </article>
      )}
    </section>
  );
}
