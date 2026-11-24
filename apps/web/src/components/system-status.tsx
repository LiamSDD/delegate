import type { ChainSummary } from "@/lib/model-chain";
import { repoFileUrl } from "@/lib/site";

const PLACEMENT_LABEL = { hosted: "hosted", "in-browser": "in-browser" } as const;

export function SystemStatus({ summary }: { summary: ChainSummary }) {
  return (
    <section
      aria-label="Default model chain"
      className="flex flex-col gap-2 font-mono text-xs text-text-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4"
    >
      <span className="flex items-center gap-2 text-text-subtle">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-text-subtle" />
        Default chain
      </span>
      {summary.status === "ok" ? (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {summary.providers.map((provider) => (
            <li key={provider.id} className="flex items-center gap-1.5">
              <span className="text-text">{provider.name}</span>
              <span className="text-text-subtle">{PLACEMENT_LABEL[provider.placement]}</span>
              <span className="rounded-xs border border-border px-1 text-2xs text-success">
                keyless
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-text">{summary.reason}</span>
      )}
      <a
        href={repoFileUrl("config/models.json")}
        target="_blank"
        rel="noreferrer"
        className="text-text-subtle underline-offset-4 hover:text-text hover:underline sm:ml-auto"
      >
        Configured, not health-checked · config/models.json
      </a>
    </section>
  );
}
