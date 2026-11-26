"use client";

import { FlaskConical } from "lucide-react";
import { type SyntheticEvent, useId, useState } from "react";
import { z } from "zod";

import { postJson, readErrorLines } from "@/components/control/http";
import { Chip, primaryButton, type Tone } from "@/components/run/primitives";

const decisionSchema = z.object({
  decision: z.enum(["allow", "deny", "require_approval"]),
  policyId: z.string(),
  ruleId: z.string(),
  reason: z.string(),
});

const simulationSchema = z.object({
  decision: decisionSchema,
  matched: z.array(decisionSchema),
  call: z.object({
    tool: z.string(),
    capability: z.string(),
    host: z.string().nullable(),
    sideEffect: z.boolean(),
    caller: z.enum(["agent", "system"]),
    provider: z.object({ id: z.string(), terms: z.string() }).nullable(),
    granted: z.boolean(),
  }),
  policies: z.array(z.object({ id: z.string(), name: z.string() })),
  notes: z.array(z.string()),
});
type SimulationResult = z.infer<typeof simulationSchema>;

const DECISION: Record<SimulationResult["decision"]["decision"], { label: string; tone: Tone }> = {
  allow: { label: "Allowed", tone: "success" },
  deny: { label: "Denied", tone: "danger" },
  require_approval: { label: "Needs approval", tone: "warning" },
};

const fieldLabel = "font-mono text-2xs tracking-label text-text-subtle uppercase";
const control =
  "h-9 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-subtle focus-visible:border-accent focus-visible:outline-none";

export interface SimulatorOptions {
  missions: { id: string; label: string }[];
  capabilities: string[];
  sideEffectCapabilities: string[];
  knownTools: string[];
}

function Result({ result }: { result: SimulationResult }) {
  const verdict = DECISION[result.decision.decision];
  const others = result.matched.filter(
    (entry) =>
      entry.policyId !== result.decision.policyId || entry.ruleId !== result.decision.ruleId,
  );
  return (
    <div
      role="status"
      data-simulation={result.decision.decision}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface-2/50 px-4 py-4"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={verdict.tone}>{verdict.label}</Chip>
          <span className="font-mono text-sm break-all text-text">
            rule {result.decision.ruleId}
          </span>
          <span className="font-mono text-2xs break-all text-text-subtle">
            in policy {result.decision.policyId}
          </span>
        </div>
        <p className="text-sm break-words text-text">{result.decision.reason}</p>
      </div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2">
        {[
          ["Tool checked", result.call.tool],
          ["Capability", result.call.capability],
          ["Target host", result.call.host ?? "none"],
          ["Side effect", result.call.sideEffect ? "yes" : "no"],
          ["Called by", result.call.caller === "system" ? "the runtime" : "an agent"],
          [
            "Model provider",
            result.call.provider === null
              ? "none involved"
              : `${result.call.provider.id} (${result.call.provider.terms})`,
          ],
          ["Mission grants this capability", result.call.granted ? "yes" : "no"],
          ["Policy set", result.policies.map((policy) => policy.id).join(", ") || "none"],
        ].map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <dt className={fieldLabel}>{label}</dt>
            <dd className="font-mono text-sm break-all text-text">{value}</dd>
          </div>
        ))}
      </dl>
      {result.notes.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm text-text-muted">
          {result.notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      )}
      {others.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={fieldLabel}>Other rules that also matched</p>
          <ul className="flex flex-col gap-1.5">
            {others.map((entry) => (
              <li
                key={`${entry.policyId}:${entry.ruleId}`}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
              >
                <Chip tone={DECISION[entry.decision].tone}>{DECISION[entry.decision].label}</Chip>
                <span className="font-mono break-all text-text">{entry.ruleId}</span>
                <span className="min-w-0 break-words text-text-muted">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-text-subtle">
        Computed on the server by the policy engine that checks real tool calls. No model was called
        and nothing was written or sent.
      </p>
    </div>
  );
}

export function PolicySimulator({ options }: { options: SimulatorOptions }) {
  const formId = useId();
  const [missionId, setMissionId] = useState(options.missions[0]?.id ?? "");
  const [origin, setOrigin] = useState<"direct" | "autopilot">("direct");
  const [capability, setCapability] = useState("");
  const [tool, setTool] = useState("");
  const [host, setHost] = useState("");
  const [sideEffect, setSideEffect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setErrors(null);
    try {
      const response = await postJson("/settings/policies/simulate", {
        missionId,
        origin,
        ...(capability === "" ? {} : { capability }),
        ...(tool.trim() === "" ? {} : { tool: tool.trim() }),
        ...(host.trim() === "" ? {} : { host: host.trim() }),
        sideEffect,
      });
      if (response.ok) {
        const parsed = simulationSchema.safeParse(await response.json().catch(() => null));
        if (parsed.success) setResult(parsed.data);
        else setErrors(["The server answered in a form this page does not understand."]);
      } else {
        setResult(null);
        setErrors(await readErrorLines(response));
      }
    } catch {
      setErrors(["Could not reach the server. Try again."]);
    }
    setBusy(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface px-4 py-4 shadow-sm"
      >
        <div className="grid grid-cols-1 min-w-0 gap-4 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Mission</span>
            <select
              value={missionId}
              onChange={(event) => {
                setMissionId(event.target.value);
              }}
              className={control}
            >
              {options.missions.map((mission) => (
                <option key={mission.id} value={mission.id}>
                  {mission.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>How the run starts</span>
            <select
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value === "autopilot" ? "autopilot" : "direct");
              }}
              className={control}
            >
              <option value="direct">Started by you</option>
              <option value="autopilot">A step of an Autopilot run</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Capability</span>
            <select
              value={capability}
              onChange={(event) => {
                const next = event.target.value;
                setCapability(next);
                if (next !== "") setSideEffect(options.sideEffectCapabilities.includes(next));
              }}
              className={control}
            >
              <option value="">Work it out from the tool</option>
              {options.capabilities.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Tool (optional with a capability)</span>
            <input
              value={tool}
              maxLength={140}
              list={`${formId}-tools`}
              placeholder="mcp__server__tool or github.open_pr"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setTool(event.target.value);
              }}
              className={`${control} font-mono`}
            />
            <datalist id={`${formId}-tools`}>
              {options.knownTools.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Target host (optional)</span>
            <input
              value={host}
              maxLength={2048}
              placeholder="api.example.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              onChange={(event) => {
                setHost(event.target.value);
              }}
              className={`${control} font-mono`}
            />
          </label>
        </div>
        <label className="inline-flex items-start gap-3 text-sm text-text">
          <input
            type="checkbox"
            checked={sideEffect}
            onChange={(event) => {
              setSideEffect(event.target.checked);
            }}
            className="mt-1"
          />
          <span>
            The call has a side effect
            <span className="block text-text-muted">
              It changes something outside the run: opens a pull request, sends a message, writes
              through a connector.
            </span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy || (capability === "" && tool.trim() === "")}
            className={primaryButton}
          >
            <FlaskConical className="size-3.5" aria-hidden="true" />
            {busy ? "Checking…" : "Run the dry run"}
          </button>
          {capability === "" && tool.trim() === "" ? (
            <span className="text-sm text-text-subtle">Choose a capability or name a tool.</span>
          ) : null}
        </div>
      </form>
      {errors === null ? null : (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger-soft/40 px-3 py-2 text-sm text-danger"
        >
          {errors.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {result === null ? (
        errors === null ? (
          <div
            data-empty-state=""
            className="rounded-xl border border-dashed border-border-strong px-5 py-6 text-sm text-text-muted"
          >
            The decision will appear here: allowed, denied or needs approval, with the rule that
            produced it and its reason.
          </div>
        ) : null
      ) : (
        <Result result={result} />
      )}
    </div>
  );
}
