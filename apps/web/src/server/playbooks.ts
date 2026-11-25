import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { listPlaybookVersions } from "@delegate/db";
import { EvolutionLogSchema, type EvolutionLog } from "@delegate/evals/evolution";
import {
  entryScore,
  MISSION_IDS,
  playbookKey,
  type Playbook,
  type PlaybookEntry,
} from "@delegate/runtime";

import type { AppDatabase } from "./db";
import { resolveRepoRoot } from "./db";
import { readShippedPlaybook } from "./runtime-runner";
import type { GuestSession } from "./session";

export interface PlaybookEntryView {
  id: string;
  kind: string;
  polarity: PlaybookEntry["polarity"];
  text: string;
  evidence: number;
  score: number;
  lower: number;
  upper: number;
}

export interface PlaybookCard {
  key: string;
  scope: Playbook["scope"];
  origin: "database" | "shipped";
  version: number;
  versions: number;
  runs: number;
  updatedAt: string;
  entries: PlaybookEntryView[];
}

export interface EvolutionLogs {
  logs: EvolutionLog[];
  invalid: string[];
}

export function evolutionDir(root = resolveRepoRoot()): string {
  return path.join(root, "packages", "evals", "results", "evolution");
}

export function loadEvolutionLogs(dir: string): EvolutionLogs {
  if (!existsSync(dir)) return { logs: [], invalid: [] };
  const logs: EvolutionLog[] = [];
  const invalid: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = EvolutionLogSchema.safeParse(
        JSON.parse(readFileSync(path.join(dir, name), "utf8")) as unknown,
      );
      if (parsed.success) logs.push(parsed.data);
      else invalid.push(name);
    } catch {
      invalid.push(name);
    }
  }
  return { logs: logs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)), invalid };
}

export function entryViews(playbook: Playbook): PlaybookEntryView[] {
  const views = playbook.entries.map((entry) => {
    const score = entryScore(entry);
    return {
      id: entry.id,
      kind: entry.kind,
      polarity: entry.polarity,
      text: entry.text,
      evidence: entry.evidence,
      score: score.mean,
      lower: score.lower,
      upper: score.upper,
    };
  });
  return views.sort(
    (a, b) =>
      (a.polarity === b.polarity ? 0 : a.polarity === "keep" ? -1 : 1) ||
      (a.polarity === "keep" ? b.lower - a.lower : b.evidence - a.evidence) ||
      a.id.localeCompare(b.id),
  );
}

function card(playbook: Playbook, origin: PlaybookCard["origin"], versions: number): PlaybookCard {
  return {
    key: playbook.key,
    scope: playbook.scope,
    origin,
    version: playbook.version,
    versions,
    runs: playbook.runs,
    updatedAt: playbook.updatedAt,
    entries: entryViews(playbook),
  };
}

export async function listPlaybookCards(
  app: AppDatabase,
  session: GuestSession,
  readShipped: (key: string) => Playbook | null = (key) => readShippedPlaybook(key),
): Promise<PlaybookCard[]> {
  const rows = await listPlaybookVersions(app.db, session);
  const latest = new Map<string, { playbook: Playbook; versions: number }>();
  for (const row of rows) {
    const slot = `${row.scope}\u0000${row.key}`;
    const current = latest.get(slot);
    latest.set(slot, {
      playbook:
        current === undefined || current.playbook.version < row.version
          ? row.playbook
          : current.playbook,
      versions: (current?.versions ?? 0) + 1,
    });
  }
  const cards = [...latest.values()].map(({ playbook, versions }) =>
    card(playbook, "database", versions),
  );
  for (const missionId of MISSION_IDS) {
    const key = playbookKey(missionId, {});
    if (cards.some((existing) => existing.scope === "house" && existing.key === key)) continue;
    const shipped = readShipped(key);
    if (shipped !== null && shipped.entries.length > 0) cards.push(card(shipped, "shipped", 1));
  }
  return cards.sort(
    (a, b) =>
      a.key.localeCompare(b.key) || (a.scope === b.scope ? 0 : a.scope === "workspace" ? -1 : 1),
  );
}
