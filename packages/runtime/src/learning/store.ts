import { type RunLessons } from "./lessons";
import { foldLessons, type Playbook, type PlaybookScope } from "./playbook";

export interface PlaybookPair {
  workspace: Playbook | null;
  house: Playbook | null;
}

export interface PlaybookStore {
  read(key: string): Promise<PlaybookPair>;
  record(run: RunLessons, options: { house: boolean }): Promise<void>;
}

export function createMemoryPlaybookStore(
  seed: readonly Playbook[] = [],
): PlaybookStore & { all(scope: PlaybookScope): Playbook[] } {
  const latest = new Map<string, Playbook>();
  const slot = (scope: PlaybookScope, key: string) => `${scope}\u0000${key}`;
  for (const playbook of seed) latest.set(slot(playbook.scope, playbook.key), playbook);
  const fold = (scope: PlaybookScope, run: RunLessons) => {
    const current = latest.get(slot(scope, run.key)) ?? null;
    latest.set(slot(scope, run.key), foldLessons(current, run, scope));
  };
  return {
    all: (scope) => [...latest.values()].filter((playbook) => playbook.scope === scope),
    read: (key) =>
      Promise.resolve({
        workspace: latest.get(slot("workspace", key)) ?? null,
        house: latest.get(slot("house", key)) ?? null,
      }),
    record: (run, options) => {
      fold("workspace", run);
      if (options.house) fold("house", run);
      return Promise.resolve();
    },
  };
}
