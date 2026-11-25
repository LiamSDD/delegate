import type { LiveChain } from "@/lib/model-chain";
import { repoFileUrl } from "@/lib/site";

const SHOWN = 4;

export function SystemStatus({ chain }: { chain: LiveChain }) {
  return (
    <section
      aria-label="Live model chain"
      className="flex flex-col gap-2 font-mono text-xs text-text-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4"
    >
      <span className="flex items-center gap-2 text-text-subtle">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        Model chain
      </span>
      {chain.status === "ok" ? (
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {chain.models.slice(0, SHOWN).map((model, index) => (
            <li key={model.name} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-text-subtle">
                  →
                </span>
              ) : null}
              <span className={index === 0 ? "text-text" : undefined}>{model.name}</span>
              {model.keyless ? (
                <span className="rounded-xs border border-border px-1 text-2xs text-success">
                  keyless
                </span>
              ) : null}
            </li>
          ))}
          {chain.models.length > SHOWN ? (
            <li className="text-text-subtle">+{chain.models.length - SHOWN} fallbacks</li>
          ) : null}
        </ol>
      ) : (
        <span className="text-text">{chain.reason}</span>
      )}
      <a
        href={repoFileUrl("config/models.json")}
        target="_blank"
        rel="noreferrer"
        className="text-text-subtle underline-offset-4 hover:text-text hover:underline sm:ml-auto"
      >
        $0 · free models · config/models.json
      </a>
    </section>
  );
}
