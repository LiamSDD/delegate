"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";

import { readError } from "@/components/control/http";
import { actionButton, Chip } from "@/components/run/primitives";

const automationSchema = z.object({
  autoApprovePlans: z.boolean(),
  preapprovedTools: z.array(z.string()),
  changedTools: z.array(z.string()),
});
export type AutomationState = z.infer<typeof automationSchema>;

const responseSchema = z.object({ automation: automationSchema });

const link =
  "text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent";

export function AutomationPanel({ initial }: { initial: AutomationState }) {
  const [automation, setAutomation] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (key: string, update: Partial<Omit<AutomationState, "changedTools">>) => {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch("/api/settings/automation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      if (response.ok) {
        const parsed = responseSchema.safeParse(await response.json().catch(() => null));
        if (parsed.success) setAutomation(parsed.data.automation);
        else setError("Saved, but the answer could not be read. Reload to see the current state.");
      } else setError(await readError(response));
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    }
    setBusy(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-medium text-text">Mission plans</h3>
          <Chip tone={automation.autoApprovePlans ? "warning" : "neutral"}>
            {automation.autoApprovePlans ? "Approved automatically" : "Ask every time"}
          </Chip>
        </div>
        <label className="inline-flex items-start gap-3 text-sm text-text">
          <input
            type="checkbox"
            checked={automation.autoApprovePlans}
            disabled={busy !== null}
            onChange={(event) => {
              void save("plans", { autoApprovePlans: event.target.checked });
            }}
            className="mt-1"
          />
          <span>
            Approve mission plans automatically
            <span className="block max-w-2xl text-text-muted text-pretty">
              Applies to every run in this workspace, however it is started: the web app, the API,
              MCP clients and the steps of an Autopilot run. With it off, each plan waits in the
              approvals inbox and is rejected if nobody answers before its deadline. An automatic
              approval is still written to the run log.
            </span>
          </span>
        </label>
      </div>

      <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-medium text-text">Pre-approved connector tools</h3>
          <Chip>{automation.preapprovedTools.length} pre-approved</Chip>
        </div>
        <p className="max-w-2xl text-sm text-text-muted text-pretty">
          A connector tool with side effects asks before every call unless it is pre-approved. You
          choose tools one by one, next to each connector, on{" "}
          <Link href="/settings/connections#connectors" className={link}>
            Connections
          </Link>
          ; here you can see the whole list and take a tool off it.
        </p>
        {automation.preapprovedTools.length === 0 ? (
          <p
            data-empty-state=""
            className="rounded-lg border border-dashed border-border-strong px-4 py-4 text-sm text-text-muted"
          >
            No connector tool is pre-approved: every side effect asks first. Tools you pre-approve
            on Connections will be listed here.
          </p>
        ) : (
          <ul className="flex flex-col rounded-lg border border-border">
            {automation.preapprovedTools.map((tool) => (
              <li
                key={tool}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <code className="min-w-0 font-mono text-sm break-all text-text">{tool}</code>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    void save(tool, {
                      preapprovedTools: automation.preapprovedTools.filter((name) => name !== tool),
                    });
                  }}
                  className={actionButton}
                >
                  {busy === tool ? "Saving…" : "Ask again for this tool"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {automation.changedTools.length === 0 ? null : (
          <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning">
            <p>
              Changed on their server since you pre-approved them, so they ask again until you
              pre-approve them once more on Connections:
            </p>
            <ul className="flex flex-col gap-0.5 font-mono text-xs">
              {automation.changedTools.map((tool) => (
                <li key={tool} className="break-all">
                  {tool}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
