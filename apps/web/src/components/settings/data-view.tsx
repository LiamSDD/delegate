import { Download } from "lucide-react";

import { actionButton } from "@/components/run/primitives";
import { type DataInventory, isEmptyInventory } from "@/server/data/inventory";

import { DeleteDataForm } from "./delete-data-form";
import { SettingsFrame, SettingsSection } from "./settings-frame";

export const DATA_TITLE = "Take your data with you, or remove it";
export const DATA_SUMMARY =
  "Everything this workspace holds, as a file you can keep, and a way to delete it for good. Both act on this workspace only.";

export type ExportOutcome = "nothing" | "rate_limited";

export interface ExportFacts {
  maxBytes: number;
  maxSeconds: number;
  perHour: number;
}

const count = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

const INVENTORY: readonly { key: keyof DataInventory; one: string; many: string }[] = [
  { key: "runs", one: "run", many: "runs" },
  { key: "events", one: "run event", many: "run events" },
  { key: "artifacts", one: "artifact", many: "artifacts" },
  { key: "assistants", one: "assistant", many: "assistants" },
  { key: "connectors", one: "MCP connector", many: "MCP connectors" },
  { key: "githubInstallations", one: "GitHub installation", many: "GitHub installations" },
  { key: "apiTokens", one: "API token", many: "API tokens" },
  { key: "settings", one: "settings record", many: "settings records" },
];

const EXPORT_OUTCOME: Record<ExportOutcome, string> = {
  nothing: "There is no workspace in this browser, so there was nothing to export.",
  rate_limited: "That is too many exports in an hour. Try again later.",
};

export function parseExportOutcome(value: unknown): ExportOutcome | null {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return first === "nothing" || first === "rate_limited" ? first : null;
}

function megabytes(bytes: number): string {
  return `${count.format(Math.round(bytes / (1024 * 1024)))} MiB`;
}

function Inventory({ inventory }: { inventory: DataInventory }) {
  if (isEmptyInventory(inventory))
    return (
      <div
        data-empty-state=""
        className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border-strong px-5 py-6"
      >
        <p className="text-sm font-medium text-text">This workspace holds no data yet</p>
        <p className="max-w-2xl text-sm text-text-muted text-pretty">
          After your first run this lists how many runs, events, artifacts, assistants, connectors,
          tokens and settings the workspace holds: exactly what an export contains and a deletion
          removes.
        </p>
      </div>
    );
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-sm sm:grid-cols-4">
      {INVENTORY.map((entry) => (
        <div key={entry.key} className="flex min-w-0 flex-col gap-0.5 bg-surface px-4 py-3">
          <dd className="font-mono text-lg text-text tabular">
            {count.format(inventory[entry.key])}
          </dd>
          <dt className="text-sm break-words text-text-muted">
            {inventory[entry.key] === 1 ? entry.one : entry.many}
          </dt>
        </div>
      ))}
    </dl>
  );
}

export function DataView({
  inventory,
  hasWorkspace,
  exportFacts,
  exportOutcome,
  deletePhrase,
}: {
  inventory: DataInventory;
  hasWorkspace: boolean;
  exportFacts: ExportFacts;
  exportOutcome: ExportOutcome | null;
  deletePhrase: string;
}) {
  return (
    <SettingsFrame current="/settings/data" title={DATA_TITLE} summary={DATA_SUMMARY}>
      <SettingsSection
        id="held"
        title="What this workspace holds"
        lede="Counted now, for this workspace only."
      >
        <Inventory inventory={inventory} />
      </SettingsSection>

      <SettingsSection
        id="export"
        title="Export my data"
        lede="One JSON file with the workspace, its settings and connections, and every run with its events and artifacts, newest run first. Secrets and token values are never stored in readable form and are not in the file."
      >
        {exportOutcome === null ? null : (
          <p
            role="status"
            className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
          >
            {EXPORT_OUTCOME[exportOutcome]}
          </p>
        )}
        <form
          method="post"
          action="/settings/data/export"
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 shadow-sm"
        >
          <ul className="flex max-w-2xl list-disc flex-col gap-1 pl-5 text-sm text-text-muted">
            <li>
              The file stops at {megabytes(exportFacts.maxBytes)} or {exportFacts.maxSeconds}{" "}
              seconds, whichever comes first.
            </li>
            <li>
              If it had to stop early it is still valid JSON, and its{" "}
              <code className="font-mono text-text">truncated</code> field says why and which runs
              are missing or incomplete. A complete file has{" "}
              <code className="font-mono text-text">&quot;truncated&quot;: null</code>.
            </li>
            <li>
              Up to {exportFacts.perHour} exports an hour. Each one is recorded in the workspace
              audit trail before the file starts.
            </li>
          </ul>
          <button type="submit" disabled={!hasWorkspace} className={`${actionButton} self-start`}>
            <Download className="size-3.5" aria-hidden="true" />
            Export my data
          </button>
          {hasWorkspace ? null : (
            <p className="text-sm text-text-subtle">
              There is no workspace in this browser yet, so there is nothing to export.
            </p>
          )}
        </form>
      </SettingsSection>

      <SettingsSection
        id="delete"
        title="Delete my data"
        lede="Permanently removes this workspace's runs with their events, artifacts and approvals, its assistants, documents, memories, playbooks, connectors, GitHub links, API tokens and settings, then signs this browser out. Active runs are stopped first. It cannot be undone, and there is no backup to restore from."
      >
        <p className="max-w-2xl text-sm text-text-muted text-pretty">
          Before anything is removed, one audit entry is written that records the deletion and how
          many rows of each kind went, with no content. That entry is the only thing kept. API
          tokens stop working at once; an assistant embedded on another site can keep answering from
          a server&apos;s memory for a short while until that server is recycled.
        </p>
        <DeleteDataForm phrase={deletePhrase} disabled={!hasWorkspace} />
      </SettingsSection>
    </SettingsFrame>
  );
}
