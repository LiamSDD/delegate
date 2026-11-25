import type { Rule } from "@delegate/policy";
import type { ReactNode } from "react";

import { Chip } from "@/components/run/primitives";
import { missionLabel } from "@/lib/m2-contract";
import type { AppliedPolicy, PolicyFacts, RunOrigin } from "@/server/control/policies";

const RULE_KIND: Record<Rule["kind"], string> = {
  require_approval: "Ask a person first",
  deny_tools: "Always deny",
  capability_allowlist: "Allowed capabilities",
  egress_allowlist: "Allowed outbound hosts",
  spend_cap: "Spend cap",
  classification: "Data classification",
  provider_terms: "Model provider terms",
};

const ORIGIN_LABEL: Record<RunOrigin, string> = {
  direct: "Started by you (web app, API or MCP)",
  autopilot: "Started as a step of an Autopilot run",
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function Values({ values, none }: { values: readonly string[]; none: string }) {
  if (values.length === 0) return <span className="text-text-muted">{none}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <code
          key={value}
          className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-xs break-all text-text"
        >
          {value === "*" ? "* (any)" : value}
        </code>
      ))}
    </span>
  );
}

function money(microUsd: number | undefined): string {
  return microUsd === undefined ? "no limit" : usd.format(microUsd / 1_000_000);
}

function RuleBody({ rule }: { rule: Rule }): ReactNode {
  switch (rule.kind) {
    case "require_approval":
      return (
        <>
          <p>These tools run only after a person approves the call:</p>
          <Values values={rule.tools} none="none" />
        </>
      );
    case "deny_tools":
      return (
        <>
          <p>These tools are refused whatever else allows them:</p>
          <Values values={rule.tools} none="none" />
        </>
      );
    case "capability_allowlist":
      return (
        <>
          <p>A tool call is denied unless its capability is one of:</p>
          <Values values={rule.capabilities} none="none: every capability is denied" />
        </>
      );
    case "egress_allowlist":
      return (
        <>
          <p>Calls with these capabilities may reach only the hosts listed:</p>
          <Values values={rule.capabilities} none="no capability" />
          <Values values={rule.domains} none="no host: all outbound requests are denied" />
          <p className="text-text-muted">
            IP literals, localhost, link-local, metadata and private hosts are always denied.
          </p>
        </>
      );
    case "spend_cap":
      return (
        <p>
          At most {money(rule.perRunMicroUsd)} per run and {money(rule.perDayMicroUsd)} per day, in
          US dollars of model spend. A call that would go over is{" "}
          {rule.onExceed === "deny" ? "denied" : "sent for approval"}.
        </p>
      );
    case "classification":
      return (
        <>
          <p>When the data in play is classified as:</p>
          <Values values={rule.classifications} none="none" />
          <p>these tools are forbidden:</p>
          <Values values={rule.forbiddenTools} none="none" />
          <p>and these model providers and provider terms:</p>
          <Values
            values={[...rule.forbiddenProviders, ...rule.forbiddenProviderTerms]}
            none="none"
          />
        </>
      );
    case "provider_terms":
      return (
        <>
          <p>A model call is denied unless the provider&apos;s terms are one of:</p>
          <Values values={rule.allowed} none="none: every provider is denied" />
        </>
      );
  }
}

function Uses({ applied }: { applied: AppliedPolicy }) {
  const origins = [...new Set(applied.uses.map((use) => use.origin))];
  return (
    <dl className="flex flex-col gap-2">
      {origins.map((origin) => (
        <div key={origin} className="flex min-w-0 flex-col gap-1">
          <dt className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            {ORIGIN_LABEL[origin]}
          </dt>
          <dd className="flex flex-wrap gap-1.5">
            {applied.uses
              .filter((use) => use.origin === origin)
              .map((use) => (
                <Chip key={use.missionId}>{missionLabel(use.missionId)}</Chip>
              ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PolicySets({
  applied,
  facts,
}: {
  applied: AppliedPolicy[];
  facts: Pick<PolicyFacts, "audience" | "tier" | "connectorHosts">;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm break-words text-text-muted text-pretty">
        Built for this workspace as it is now:{" "}
        {facts.audience === "owner" ? "owner mode" : "the public demo"},{" "}
        {facts.tier === "connected" ? "connected" : "guest"} tier,{" "}
        {facts.connectorHosts.length === 0
          ? "no connector hosts"
          : `connector hosts ${facts.connectorHosts.join(", ")}`}
        . These sets are defined in code and cannot be edited here. On top of them the engine always
        denies a capability the mission was never granted.
      </p>
      <ol className="flex flex-col gap-4">
        {applied.map((entry) => (
          <li
            key={entry.policy.id}
            data-policy={entry.policy.id}
            className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface px-4 py-4 shadow-sm"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="text-base font-medium text-text">{entry.policy.name}</h3>
                <code className="font-mono text-2xs break-all text-text-subtle">
                  {entry.policy.id}
                </code>
                <Chip>read-only</Chip>
              </div>
              {entry.policy.description === undefined ? null : (
                <p className="max-w-3xl text-sm text-text-muted text-pretty">
                  {entry.policy.description}
                </p>
              )}
            </div>
            <Uses applied={entry} />
            <ol className="flex flex-col rounded-lg border border-border">
              {entry.policy.rules.map((rule, index) => (
                <li
                  key={rule.id ?? `${rule.kind}-${String(index)}`}
                  className="grid min-w-0 gap-2 border-b border-border px-3 py-3 last:border-b-0 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-text">{RULE_KIND[rule.kind]}</span>
                    <code className="font-mono text-2xs break-all text-text-subtle">
                      {rule.id ?? rule.kind}
                    </code>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 text-sm text-text">
                    <RuleBody rule={rule} />
                  </div>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
