import type { LivePrompt, MissionPrompts } from "@/server/eval-results";

import { Badge, Code, Empty } from "./parts";

function Version({ prompt }: { prompt: LivePrompt }) {
  if (prompt.liveVersion === null)
    return (
      <span className="text-danger">
        {prompt.file} is missing from <span className="whitespace-nowrap">the prompts folder</span>
      </span>
    );
  const others = prompt.onDisk.filter((version) => version !== prompt.liveVersion);
  return (
    <>
      <span className="text-text tabular">v{prompt.liveVersion}</span>
      {others.length === 0 ? null : (
        <span className="text-text-subtle tabular">
          {" "}
          · also on disk: {others.map((version) => `v${version}`).join(", ")}
        </span>
      )}
    </>
  );
}

export function PromptVersions({ missions }: { missions: readonly MissionPrompts[] }) {
  if (missions.every((entry) => entry.prompts.every((prompt) => prompt.onDisk.length === 0)))
    return (
      <Empty title="Prompt files not found">
        <p>
          The page reads <Code>packages/runtime/prompts/</Code> at build time and found no versioned
          prompt file there.
        </p>
      </Empty>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <caption className="sr-only">Live prompt version per mission prompt</caption>
        <thead className="border-b border-border">
          <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            <th scope="col" className="px-4 py-3 font-normal">
              Mission
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Prompt
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Live version
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Training
            </th>
          </tr>
        </thead>
        {missions.map((entry) => (
          <tbody key={entry.mission} className="border-b border-border last:border-b-0">
            {entry.prompts.map((prompt, index) => (
              <tr key={prompt.key} className="align-top">
                {index === 0 ? (
                  <th
                    scope="rowgroup"
                    rowSpan={entry.prompts.length}
                    className="px-4 py-3 font-medium"
                  >
                    {entry.title}
                    <p className="mt-1 font-mono text-2xs font-normal text-text-subtle">
                      {entry.playbooks.length === 0
                        ? "no house playbook shipped"
                        : entry.playbooks
                            .map(
                              (playbook) =>
                                `house playbook ${playbook.key} v${playbook.version} (${playbook.entries} ${playbook.entries === 1 ? "entry" : "entries"})`,
                            )
                            .join(" · ")}
                    </p>
                  </th>
                ) : null}
                <td className="px-4 py-1.5 font-mono text-xs text-text-muted">{prompt.name}</td>
                <td className="px-4 py-1.5 font-mono text-xs text-text-muted">
                  <Version prompt={prompt} />
                </td>
                <td className="px-4 py-1.5 font-mono text-xs text-text-subtle">
                  {prompt.awaitingPointer !== null ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="warning">v{prompt.awaitingPointer} promoted</Badge>
                      <span>not live until RUNTIME_PROMPT_FILES.{prompt.key} points at it</span>
                    </span>
                  ) : prompt.trainable ? (
                    <Badge tone="neutral">training target</Badge>
                  ) : prompt.shared ? (
                    "shared across missions, hand-tuned"
                  ) : (
                    "not a training target"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
