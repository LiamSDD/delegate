"use client";

import type { Citation, RepoXray, RunEvent } from "@delegate/runtime";
import { Check, Copy, FileWarning } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  citationHref,
  citationLabel,
  diagramLayers,
  formatBytes,
  type RepoXrayDiagram,
  repoXrayOf,
  SKIP_REASON_LABELS,
} from "@/lib/runs/repo-xray";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow, type Tone } from "./primitives";
import { ShipItButton } from "./ship-it-button";
import { PartialNotice } from "./partial-notice";

function Cite({ xray, citations }: { xray: RepoXray; citations: readonly Citation[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-baseline">
      {citations.map((citation) => (
        <a
          key={citationLabel(citation)}
          href={citationHref(xray, citation)}
          target="_blank"
          rel="noreferrer noopener"
          className="max-w-full truncate rounded-xs bg-accent-soft px-1 font-mono text-2xs text-accent hover:bg-accent hover:text-accent-fg"
        >
          {citationLabel(citation)}
        </a>
      ))}
    </span>
  );
}

function SupportChip({ support }: { support: "weak" | "unverified" | undefined }) {
  if (support === undefined) return null;
  return (
    <Chip tone="warning" className="ml-1 align-middle">
      {support === "weak" ? "weakly supported" : "unverified"}
    </Chip>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="flex items-baseline gap-2">
        <Eyebrow>{title}</Eyebrow>
        {count === undefined ? null : (
          <span className="font-mono text-2xs text-text-subtle tabular">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-subtle">{children}</p>;
}

function ModuleMap({ diagram }: { diagram: RepoXrayDiagram }) {
  const layers = useMemo(() => diagramLayers(diagram), [diagram]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3 md:flex-row md:items-start md:overflow-x-auto md:pb-1">
        {layers.map((layer, index) => (
          <li key={index} className="flex min-w-0 flex-col gap-2 md:w-52 md:shrink-0">
            <span className="font-mono text-2xs text-text-subtle">
              {index === 0
                ? "imports others"
                : index === layers.length - 1
                  ? "leaf modules"
                  : `layer ${index + 1}`}
            </span>
            {layer.map((node) => (
              <div
                key={node.id}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <span
                  className="truncate font-mono text-xs font-medium text-text"
                  title={node.module}
                >
                  {node.module === "." ? "(repository root)" : node.module}
                </span>
                {node.role === null ? null : (
                  <span className="text-xs text-text-muted">{node.role}</span>
                )}
                {node.targets.length === 0 ? null : (
                  <ul className="flex flex-col gap-0.5 border-t border-border pt-1">
                    {node.targets.map((target) => (
                      <li
                        key={target.module}
                        className="flex items-center gap-1 font-mono text-2xs text-text-muted"
                      >
                        <span aria-hidden="true">→</span>
                        <span className="sr-only">imports</span>
                        <span className="truncate" title={target.module}>
                          {target.module}
                        </span>
                        <span className="ml-auto text-text-subtle tabular">×{target.imports}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </li>
        ))}
      </ol>
      <details className="rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-mono text-2xs text-text-muted">
          Mermaid source (
          {diagram.source === "model" ? "modules chosen by the architect" : "from the import graph"}
          ; edges from the import graph)
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <pre className="overflow-x-auto font-mono text-2xs text-text">{diagram.mermaid}</pre>
          <button
            type="button"
            className={cn(actionButton, "w-fit")}
            onClick={() => {
              void navigator.clipboard.writeText(diagram.mermaid).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                }, 2000);
              });
            }}
          >
            {copied ? (
              <Check className="size-3.5 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy Mermaid"}
          </button>
        </div>
      </details>
    </div>
  );
}

const SEVERITY_TONE: Record<string, Tone> = { high: "danger", medium: "warning", low: "neutral" };

function Overview({ xray }: { xray: RepoXray }) {
  const skipped = Object.entries(xray.snapshot.skippedByReason);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-text">
        <a
          href={xray.repo.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono font-medium hover:underline"
        >
          {xray.repo.owner}/{xray.repo.name}
        </a>{" "}
        <span className="font-mono text-xs text-text-muted">
          @{xray.repo.commit?.slice(0, 7) ?? xray.repo.ref}
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {xray.languages.slice(0, 4).map((language) => (
          <Chip key={language.language}>
            {language.language} {Math.round(language.share * 100)}%
          </Chip>
        ))}
      </div>
      <PartialNotice partial={xray.partial} />
      <p className="text-xs text-text-muted">
        {xray.snapshot.keptFiles} text files read from a{" "}
        {formatBytes(xray.snapshot.compressedBytes)} archive
        {skipped.length === 0
          ? "."
          : `; skipped ${skipped.map(([reason, count]) => `${count} ${SKIP_REASON_LABELS[reason] ?? reason}`).join(", ")}.`}
        {xray.snapshot.truncated === null
          ? ""
          : " The archive was larger than the read cap, so the snapshot is partial."}
        {xray.snapshot.secretsRedacted === 0
          ? ""
          : ` ${xray.snapshot.secretsRedacted} secret-like value${xray.snapshot.secretsRedacted === 1 ? " was" : "s were"} redacted before any model saw the code.`}
      </p>
      <p className="font-mono text-2xs text-text-subtle tabular">
        {xray.verification.citationsValid}/{xray.verification.citationsChecked} citations resolve to
        lines in the snapshot
        {xray.verification.citationAccuracy === null
          ? ""
          : ` · claim support ${Math.round(xray.verification.citationAccuracy * 100)}%`}
        {xray.verification.claimsDropped === 0
          ? ""
          : ` · ${xray.verification.claimsDropped} unsupported claims removed`}
      </p>
    </div>
  );
}

export interface ShipContext {
  enabled: boolean;
  runId?: string | undefined;
}

function Improvements({ xray, ship }: { xray: RepoXray; ship: ShipContext }) {
  if (xray.improvements.length === 0)
    return (
      <Empty>
        {xray.status === "draft"
          ? "The improver is ranking changes…"
          : "No improvement survived the checks."}
      </Empty>
    );
  return (
    <ol className="flex flex-col gap-3">
      {xray.improvements.map((improvement) => (
        <li
          key={improvement.id}
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-xs text-text-subtle tabular">{improvement.rank}</span>
              <h4 className="text-sm font-medium text-text">{improvement.title}</h4>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Chip>{improvement.kind}</Chip>
              <Chip tone={improvement.effort === "S" ? "success" : "neutral"}>
                effort {improvement.effort}
              </Chip>
            </div>
          </div>
          <p className="text-sm text-text-muted">
            {improvement.rationale} <Cite xray={xray} citations={improvement.citations} />
            <SupportChip support={improvement.support} />
          </p>
          <p className="flex flex-wrap gap-1 font-mono text-2xs text-text-muted">
            {improvement.files.map((file) => (
              <span key={file} className="rounded-xs bg-surface-2 px-1">
                {file}
              </span>
            ))}
          </p>
          <ul className="list-disc pl-5 text-xs text-text-muted">
            {improvement.acceptance.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <ShipItButton
            ship={{
              repoUrl: xray.repo.url,
              ref: xray.repo.commit ?? xray.repo.ref,
              improvement: {
                id: improvement.id,
                title: improvement.title,
                rationale: improvement.rationale,
                files: improvement.files,
                kind: improvement.kind,
                effort: improvement.effort,
                acceptance: improvement.acceptance,
              },
              ...(ship.runId === undefined ? {} : { parentRunId: ship.runId }),
            }}
            primary={improvement.rank === 1 && ship.enabled}
            disabled={!ship.enabled}
            disabledLabel="Ship-a-PR is turned off on this deployment"
          />
        </li>
      ))}
    </ol>
  );
}

function Deliverable({ xray, ship }: { xray: RepoXray; ship: ShipContext }) {
  const responsibilities = xray.modules.filter((module) => module.responsibility !== null);
  return (
    <div className="flex flex-col gap-4">
      <Overview xray={xray} />
      <Section title="Architecture">
        {xray.architecture.summary.length === 0 ? (
          <Empty>
            {xray.status === "draft"
              ? "The architect is writing the summary…"
              : "No summary claim survived the checks."}
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-text">
            {xray.architecture.summary.map((claim) => (
              <li key={claim.text}>
                {claim.text} <Cite xray={xray} citations={claim.citations} />
                <SupportChip support={claim.support} />
              </li>
            ))}
          </ul>
        )}
        {xray.architecture.diagram === null ? (
          <Empty>No module map: no code modules were found.</Empty>
        ) : (
          <ModuleMap diagram={xray.architecture.diagram} />
        )}
      </Section>
      <Section title="Module responsibilities" count={responsibilities.length}>
        {responsibilities.length === 0 ? (
          <Empty>
            {xray.status === "draft" ? "Pending the architect." : "None survived the checks."}
          </Empty>
        ) : (
          <dl className="flex flex-col gap-2 text-sm">
            {responsibilities.map((module) => (
              <div
                key={module.path}
                className="grid grid-cols-1 gap-0.5 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-3"
              >
                <dt className="truncate font-mono text-xs text-text" title={module.path}>
                  {module.path}
                </dt>
                <dd className="text-text-muted">
                  {module.responsibility?.text}{" "}
                  {module.responsibility === null ? null : (
                    <Cite xray={xray} citations={module.responsibility.citations} />
                  )}
                  <SupportChip support={module.responsibility?.support} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Section>
      <Section title="Onboarding">
        {xray.onboarding.entryPoints.length === 0 ? null : (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
            Entry points:
            {xray.onboarding.entryPoints.map((entry) => (
              <a
                key={entry.path}
                href={citationHref(xray, entry.citation)}
                target="_blank"
                rel="noreferrer noopener"
                className="rounded-xs bg-surface-2 px-1 font-mono text-2xs text-text hover:underline"
              >
                {entry.path} · {entry.kind}
              </a>
            ))}
          </p>
        )}
        {xray.onboarding.steps.length === 0 ? (
          <Empty>
            {xray.status === "draft"
              ? "Pending the architect."
              : "No onboarding step survived the checks."}
          </Empty>
        ) : (
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
            {xray.onboarding.steps.map((step) => (
              <li key={step.title}>
                <span className="font-medium text-text">{step.title}.</span>{" "}
                <span className="text-text-muted">{step.claim.text}</span>{" "}
                <Cite xray={xray} citations={step.claim.citations} />
                <SupportChip support={step.claim.support} />
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="Risk hotspots" count={xray.hotspots.length}>
        {xray.hotspots.length === 0 ? (
          <Empty>
            No deprecated dependencies, risky patterns, secret-like values or hotspot files found by
            the deterministic scan.
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {xray.hotspots.map((hotspot) => (
              <li key={hotspot.id} className="flex flex-col gap-1 text-sm">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={SEVERITY_TONE[hotspot.severity] ?? "neutral"}>
                    {hotspot.severity}
                  </Chip>
                  <span className="font-medium text-text">{hotspot.title}</span>
                </span>
                <span className="text-text-muted">
                  {hotspot.detail} <Cite xray={xray} citations={hotspot.citations} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Tests" count={xray.tests.files}>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
          {xray.tests.frameworks.length === 0 ? "No test framework detected." : "Frameworks:"}
          {xray.tests.frameworks.map((framework) => (
            <a
              key={framework.name}
              href={citationHref(xray, framework.citation)}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Chip tone="accent">{framework.name}</Chip>
            </a>
          ))}
          {xray.tests.ci.length === 0 ? " · No CI configuration found." : " · CI:"}
          {xray.tests.ci.map((ci) => (
            <a
              key={ci.path}
              href={citationHref(xray, ci.citation)}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Chip>{ci.provider}</Chip>
            </a>
          ))}
        </p>
        {xray.tests.gaps.length === 0 ? (
          <Empty>Every module has a test that imports it or shares its file name.</Empty>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {xray.tests.gaps.map((gap) => (
              <li key={gap.module} className="flex flex-wrap items-baseline gap-x-2">
                <a
                  href={citationHref(xray, gap.citation)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-xs text-text hover:underline"
                >
                  {gap.module}
                </a>
                <span className="text-xs text-text-muted">
                  {gap.lines} lines
                  {gap.importedBy === 0
                    ? ""
                    : `, imported by ${gap.importedBy} module${gap.importedBy === 1 ? "" : "s"}`}
                  , no test imports it
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Dependencies" count={xray.dependencies.total}>
        {xray.dependencies.manifests.length === 0 ? (
          <Empty>No package manifest found.</Empty>
        ) : (
          <details className="text-xs">
            <summary className="cursor-pointer text-text-muted">
              {xray.dependencies.manifests
                .map(
                  (manifest) =>
                    `${manifest.path} (${manifest.ecosystem}, ${manifest.dependencies})`,
                )
                .join(" · ")}
            </summary>
            <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 font-mono text-2xs sm:grid-cols-2">
              {xray.dependencies.items.map((item) => (
                <li
                  key={`${item.ecosystem}:${item.name}:${item.scope}:${citationLabel(item.citation)}`}
                  className="flex min-w-0 gap-1.5"
                >
                  <a
                    href={citationHref(xray, item.citation)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate text-text hover:underline"
                  >
                    {item.name}
                  </a>
                  <span className="truncate text-text-muted">{item.version || "any"}</span>
                  <span className="ml-auto text-text-subtle">{item.scope}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>
      <Section title="Ranked improvements" count={xray.improvements.length}>
        <Improvements xray={xray} ship={ship} />
      </Section>
    </div>
  );
}

export function RepoXrayPanel({
  runId,
  events,
  running,
  shipEnabled = false,
}: {
  runId?: string;
  events: readonly RunEvent[];
  running: boolean;
  shipEnabled?: boolean;
}) {
  const view = useMemo(() => repoXrayOf(events), [events]);
  return (
    <section aria-labelledby="repo-heading" className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2">
        <h2 id="repo-heading">
          <Eyebrow>Repo X-ray</Eyebrow>
        </h2>
        {view.version === 0 ? null : (
          <span className="font-mono text-2xs text-text-subtle">v{view.version}</span>
        )}
        {view.xray?.status === "draft" ? <Chip tone="accent">draft</Chip> : null}
      </div>
      {view.invalid ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft/40 px-3 py-2.5 text-sm"
        >
          <FileWarning className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="text-text">
            The Repo X-ray did not match the expected schema, so it is not rendered. Nothing was
            guessed.
          </p>
        </div>
      ) : null}
      {view.xray === null ? (
        view.invalid ? null : (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
            {running
              ? "The repository is downloaded once as an archive and analysed in code first; the map, hotspots and test gaps appear here as soon as the analysis finishes."
              : "This run produced no Repo X-ray."}
            {running ? (
              <div aria-hidden="true" className="flex flex-col gap-2">
                <span className="h-4 w-2/3 rounded bg-surface-2 motion-safe:animate-pulse" />
                <span className="h-24 rounded-lg bg-surface-2 motion-safe:animate-pulse" />
              </div>
            ) : null}
          </div>
        )
      ) : (
        <Deliverable xray={view.xray} ship={{ enabled: shipEnabled, runId }} />
      )}
    </section>
  );
}
