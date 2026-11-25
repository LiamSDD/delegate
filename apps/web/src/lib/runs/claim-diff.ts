export interface ClaimRef {
  section: string;
  text: string;
  label?: string | null;
}

export type ClaimChange =
  | { kind: "unchanged"; section: string; a: ClaimRef; b: ClaimRef }
  | { kind: "changed"; section: string; a: ClaimRef; b: ClaimRef; similarity: number }
  | { kind: "added"; section: string; b: ClaimRef }
  | { kind: "removed"; section: string; a: ClaimRef };

export const CHANGED_CLAIM_THRESHOLD = 0.5;

const CITATION_MARKER = /\[S?\d+(?:\s*,\s*S?\d+)*\]/gi;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

export function normaliseClaim(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(CITATION_MARKER, " ")
    .replace(NON_WORD, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  const normalised = normaliseClaim(text);
  return new Set(normalised === "" ? [] : normalised.split(" "));
}

export function claimSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function sectionOrder(a: readonly ClaimRef[], b: readonly ClaimRef[]): string[] {
  const order: string[] = [];
  for (const claim of [...a, ...b]) if (!order.includes(claim.section)) order.push(claim.section);
  return order;
}

function diffSection(
  section: string,
  a: readonly ClaimRef[],
  b: readonly ClaimRef[],
  threshold: number,
): ClaimChange[] {
  const matchOfB = new Map<number, { aIndex: number; similarity: number }>();
  const usedA = new Set<number>();
  const normalA = a.map((claim) => normaliseClaim(claim.text));
  b.forEach((claim, bIndex) => {
    const text = normaliseClaim(claim.text);
    const aIndex = normalA.findIndex((candidate, index) => !usedA.has(index) && candidate === text);
    if (aIndex === -1) return;
    usedA.add(aIndex);
    matchOfB.set(bIndex, { aIndex, similarity: 1 });
  });
  const pairs: { aIndex: number; bIndex: number; similarity: number }[] = [];
  a.forEach((left, aIndex) => {
    if (usedA.has(aIndex)) return;
    b.forEach((right, bIndex) => {
      if (matchOfB.has(bIndex)) return;
      const similarity = claimSimilarity(left.text, right.text);
      if (similarity >= threshold) pairs.push({ aIndex, bIndex, similarity });
    });
  });
  pairs.sort((x, y) => y.similarity - x.similarity || x.bIndex - y.bIndex || x.aIndex - y.aIndex);
  for (const pair of pairs) {
    if (usedA.has(pair.aIndex) || matchOfB.has(pair.bIndex)) continue;
    usedA.add(pair.aIndex);
    matchOfB.set(pair.bIndex, { aIndex: pair.aIndex, similarity: pair.similarity });
  }
  const changes: ClaimChange[] = b.map((claim, bIndex): ClaimChange => {
    const match = matchOfB.get(bIndex);
    const left = match === undefined ? undefined : a[match.aIndex];
    if (match === undefined || left === undefined) return { kind: "added", section, b: claim };
    return normaliseClaim(left.text) === normaliseClaim(claim.text)
      ? { kind: "unchanged", section, a: left, b: claim }
      : { kind: "changed", section, a: left, b: claim, similarity: match.similarity };
  });
  a.forEach((claim, aIndex) => {
    if (!usedA.has(aIndex)) changes.push({ kind: "removed", section, a: claim });
  });
  return changes;
}

export function diffClaims(
  a: readonly ClaimRef[],
  b: readonly ClaimRef[],
  threshold = CHANGED_CLAIM_THRESHOLD,
): ClaimChange[] {
  return sectionOrder(a, b).flatMap((section) =>
    diffSection(
      section,
      a.filter((claim) => claim.section === section),
      b.filter((claim) => claim.section === section),
      threshold,
    ),
  );
}

export interface ClaimDiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export function summariseClaimDiff(changes: readonly ClaimChange[]): ClaimDiffSummary {
  const summary: ClaimDiffSummary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const change of changes) summary[change.kind] += 1;
  return summary;
}
