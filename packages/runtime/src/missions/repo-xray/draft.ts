import { z } from "zod";

import { detectInjection } from "../../quarantine/reader";
import { isSafePath } from "./analysis";
import { resolveCitations, type Evidence } from "./evidence";
import { IMPROVEMENT_EFFORTS, IMPROVEMENT_KINDS, type RepoImprovement } from "./schema";
import { type RepoSnapshot } from "./snapshot";

const DraftClaimSchema = z.object({
  text: z.string().trim().min(1).max(600),
  cite: z.array(z.string().max(40)).max(8).default([]),
});

export const ArchitectDraftOutputSchema = z.object({
  summary: z.array(z.unknown()).max(12).default([]),
  diagram: z.object({ nodes: z.array(z.unknown()).max(30).default([]) }).default({ nodes: [] }),
  modules: z.array(z.unknown()).max(40).default([]),
  onboarding: z.array(z.unknown()).max(12).default([]),
});

export const ImprovementsDraftOutputSchema = z.object({
  improvements: z.array(z.unknown()).max(16).default([]),
});

const NodeSchema = z.object({
  module: z.string().min(1).max(300),
  role: z.string().max(80).optional(),
});
const ModuleEntrySchema = z.object({
  module: z.string().min(1).max(300),
  responsibility: DraftClaimSchema,
});
const StepSchema = z.object({ title: z.string().trim().min(1).max(120), claim: DraftClaimSchema });
const ImprovementDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(600),
  cite: z.array(z.string().max(40)).max(8).default([]),
  files: z.array(z.string().max(300)).min(1).max(10),
  kind: z.enum(IMPROVEMENT_KINDS),
  effort: z.enum(IMPROVEMENT_EFFORTS),
  acceptance: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
});

export interface DraftClaim {
  text: string;
  evidence: string[];
}

export interface ArchitectDraft {
  summary: DraftClaim[];
  nodes: { module: string; role?: string | undefined }[];
  modules: { module: string; responsibility: DraftClaim }[];
  onboarding: { title: string; claim: DraftClaim }[];
}

export interface ImprovementDraft extends Omit<RepoImprovement, "id"> {
  evidence: string[];
}

export interface DraftIssues {
  malformed: number;
  uncited: string[];
  unresolved: string[];
  instructionLike: string[];
  unknownFiles: string[];
}

export function emptyIssues(): DraftIssues {
  return { malformed: 0, uncited: [], unresolved: [], instructionLike: [], unknownFiles: [] };
}

function parseItems<T>(items: readonly unknown[], schema: z.ZodType<T>, issues: DraftIssues): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) return [parsed.data];
    issues.malformed += 1;
    return [];
  });
}

function claimFrom(
  raw: z.infer<typeof DraftClaimSchema>,
  evidence: ReadonlyMap<string, Evidence>,
  issues: DraftIssues,
): DraftClaim | null {
  const resolved = resolveCitations(raw.cite, evidence);
  issues.unresolved.push(...resolved.unknown);
  if (detectInjection(raw.text) !== undefined) {
    issues.instructionLike.push(raw.text.slice(0, 200));
    return null;
  }
  if (resolved.ids.length === 0) {
    issues.uncited.push(raw.text.slice(0, 200));
    return null;
  }
  return { text: raw.text, evidence: resolved.ids.slice(0, 6) };
}

export function normaliseArchitect(
  output: z.infer<typeof ArchitectDraftOutputSchema>,
  evidence: ReadonlyMap<string, Evidence>,
): { draft: ArchitectDraft; issues: DraftIssues } {
  const issues = emptyIssues();
  const summary = parseItems(output.summary, DraftClaimSchema, issues)
    .flatMap((claim) => claimFrom(claim, evidence, issues) ?? [])
    .slice(0, 6);
  const nodes = parseItems(output.diagram.nodes, NodeSchema, issues);
  const modules = parseItems(output.modules, ModuleEntrySchema, issues).flatMap((entry) => {
    const claim = claimFrom(entry.responsibility, evidence, issues);
    return claim === null ? [] : [{ module: entry.module, responsibility: claim }];
  });
  const onboarding = parseItems(output.onboarding, StepSchema, issues)
    .flatMap((step) => {
      if (detectInjection(step.title) !== undefined) {
        issues.instructionLike.push(step.title);
        return [];
      }
      const claim = claimFrom(step.claim, evidence, issues);
      return claim === null ? [] : [{ title: step.title, claim }];
    })
    .slice(0, 8);
  return { draft: { summary, nodes, modules, onboarding }, issues };
}

function knownDirectory(snapshot: RepoSnapshot, path: string): boolean {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  if (directory === "") return true;
  for (const file of snapshot.files.keys()) if (file.startsWith(directory)) return true;
  return false;
}

function isNewTestFile(snapshot: RepoSnapshot, path: string): boolean {
  return (
    isSafePath(path) &&
    !path.includes("..") &&
    /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[\w-]+\.py$|_test\.(py|go)$/.test(
      path,
    ) &&
    knownDirectory(snapshot, path)
  );
}

export function normaliseImprovements(
  output: z.infer<typeof ImprovementsDraftOutputSchema>,
  evidence: ReadonlyMap<string, Evidence>,
  snapshot: RepoSnapshot,
): { improvements: ImprovementDraft[]; issues: DraftIssues } {
  const issues = emptyIssues();
  const improvements: ImprovementDraft[] = [];
  for (const draft of parseItems(output.improvements, ImprovementDraftSchema, issues)) {
    const texts = [draft.title, draft.rationale, ...draft.acceptance];
    const unsafe = texts.find(
      (text) => detectInjection(text) !== undefined || /https?:\/\/|\bcurl\b|\bwget\b/i.test(text),
    );
    if (unsafe !== undefined) {
      issues.instructionLike.push(unsafe.slice(0, 200));
      continue;
    }
    const resolved = resolveCitations(draft.cite, evidence);
    issues.unresolved.push(...resolved.unknown);
    if (resolved.ids.length === 0) {
      issues.uncited.push(draft.title);
      continue;
    }
    const files = [...new Set(draft.files.map((file) => file.trim().replace(/^\.\//, "")))].filter(
      (file) => {
        const ok =
          (isSafePath(file) && snapshot.files.has(file)) ||
          (draft.kind === "test" && isNewTestFile(snapshot, file));
        if (!ok) issues.unknownFiles.push(file);
        return ok;
      },
    );
    if (files.length === 0) continue;
    improvements.push({
      title: draft.title,
      rationale: draft.rationale,
      files,
      kind: draft.kind,
      effort: draft.effort,
      acceptance: draft.acceptance,
      evidence: resolved.ids.slice(0, 6),
    });
    if (improvements.length >= 8) break;
  }
  return { improvements, issues };
}

export function improvementId(rank: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return `imp-${rank}${slug === "" ? "" : `-${slug}`}`;
}
