import { z } from "zod";

import { quoteAppearsIn, type QuarantineTask } from "../../quarantine/reader";
import { isSafePath } from "./analysis";
import { baseName, extensionOf, type RepoSnapshot } from "./snapshot";

export const REPO_TOPICS = [
  "purpose",
  "architecture",
  "setup",
  "usage",
  "testing",
  "contributing",
  "other",
] as const;
export type RepoTopic = (typeof REPO_TOPICS)[number];

export const REPO_READER_TASK: QuarantineTask<{ topic: RepoTopic }> = {
  name: "repo-xray",
  instructions:
    "Extract facts about this software repository from its documentation: what the project does and for whom, how it is structured (components, packages, layers and how they relate), how to install, configure, build and run it, how to run its tests, and rules for contributors. Skip badges, links, sponsor lists and marketing slogans.",
  extraSchema: z.object({ topic: z.enum(REPO_TOPICS).catch("other") }),
  extraDescription: `"topic": one of ${REPO_TOPICS.join(", ")}`,
  maxFactsPerSource: 6,
};

export const DOC_LIMITS = { maxSources: 6, maxDocsFolderFiles: 3, maxQuoteWindow: 6 } as const;

const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "txt", ""]);

export interface DocSource {
  sourceId: string;
  path: string;
  visible: string;
  hidden: string[];
}

export function splitHiddenMarkup(text: string): { visible: string; hidden: string[] } {
  const hidden: string[] = [];
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  const visible = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (match) => {
    hidden.push(match.replace(/^<!--|-->$/g, "").trim());
    return blank(match);
  });
  return { visible, hidden: hidden.filter((entry) => entry !== "") };
}

function docRank(path: string): number | null {
  const base = baseName(path).toLowerCase();
  if (!DOC_EXTENSIONS.has(extensionOf(path)) || !isSafePath(path)) return null;
  const depth = path.split("/").length - 1;
  if (depth === 0 && base.startsWith("readme")) return 0;
  if (depth === 0 && /^(architecture|design|contributing|development|hacking)\b/.test(base))
    return 1;
  if (/^docs?\//i.test(path) && /\.(md|mdx|rst)$/.test(base)) {
    if (/(index|readme|getting[-_]?started|intro|overview|architecture|quickstart)/.test(base))
      return 2;
    return 4;
  }
  if (depth <= 2 && base.startsWith("readme")) return 3;
  return null;
}

export function docSources(snapshot: RepoSnapshot): DocSource[] {
  const ranked = [...snapshot.files.values()]
    .map((file) => ({ file, rank: docRank(file.path) }))
    .filter((entry): entry is { file: (typeof entry)["file"]; rank: number } => entry.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.file.path.split("/").length - b.file.path.split("/").length ||
        a.file.path.localeCompare(b.file.path),
    );
  const picked: typeof ranked = [];
  let docsFolder = 0;
  for (const entry of ranked) {
    if (picked.length >= DOC_LIMITS.maxSources) break;
    if (entry.rank >= 2 && entry.rank !== 3) {
      if (docsFolder >= DOC_LIMITS.maxDocsFolderFiles) continue;
      docsFolder += 1;
    }
    picked.push(entry);
  }
  return picked.map(({ file }, index) => ({
    sourceId: `S${index + 1}`,
    path: file.path,
    ...splitHiddenMarkup(file.text),
  }));
}

export function locateQuote(
  lines: readonly string[],
  quote: string,
): { startLine: number; endLine: number } | null {
  for (let window = 1; window <= DOC_LIMITS.maxQuoteWindow; window += 1)
    for (let start = 0; start + window <= lines.length; start += 1) {
      const text = lines.slice(start, start + window).join("\n");
      if (quoteAppearsIn(quote, text)) return { startLine: start + 1, endLine: start + window };
    }
  return null;
}
