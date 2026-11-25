import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { humanLabelsPath } from "../datasets/jsonl";
import { parseEventLog } from "../event-log";
import {
  missionAgreement,
  readJudgeRecord,
  storedRuns,
  trialFile,
  writeCalibration,
} from "../judge/agreement-store";
import {
  appendHumanLabel,
  loadHumanLabels,
  renderAgreement,
  type AgreementReport,
} from "../judge/calibration";
import { loadEvalPrompt } from "../judge/rubric-judge";
import { type BaseCase, type MissionAdapter } from "../missions/adapter";

export interface LabelIO {
  ask(question: string): Promise<string>;
  print(text: string): void;
}

export interface LabelTarget {
  run: string;
  dir: string;
  caseId: string;
  trial: number;
}

export interface LabelSessionOptions {
  resultsDir: string;
  labeller: string;
  run?: string;
  limit?: number;
  now: () => Date;
  labelsFile?: string;
}

export interface LabelSessionResult {
  saved: number;
  skipped: number;
  agreement: AgreementReport;
}

export function rubricLines(body: string, criteria: readonly string[]): string[] {
  return criteria.map((criterion) => {
    const line = body.split("\n").find((entry) => entry.includes(`**${criterion}**`));
    return line === undefined ? `- ${criterion}` : line.trim();
  });
}

export function labelTargets(
  resultsDir: string,
  adapter: MissionAdapter,
  labelled: ReadonlySet<string>,
  run?: string,
): LabelTarget[] {
  const runs = storedRuns(resultsDir, adapter.mission).filter(
    (entry) => run === undefined || entry.id === run,
  );
  if (run !== undefined && runs.length === 0)
    throw new Error(`No stored ${adapter.mission} run named ${run}`);
  const targets: LabelTarget[] = [];
  for (const entry of [...runs].reverse()) {
    for (const caseId of readdirSync(entry.dir).sort()) {
      const caseDir = join(entry.dir, caseId);
      if (!existsSync(caseDir) || caseId.endsWith(".json") || caseId.endsWith(".md")) continue;
      const trials = readdirSync(caseDir)
        .map((name) => /^(\d+)\.judge\.json$/.exec(name)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
      for (const trial of trials)
        if (!labelled.has(`${entry.id}/${caseId}/${trial}`))
          targets.push({ run: entry.id, dir: entry.dir, caseId, trial });
    }
  }
  return targets;
}

function scoreAnswer(raw: string): number | "skip" | "quit" | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "s") return "skip";
  if (value === "q") return "quit";
  return /^[1-5]$/.test(value) ? Number(value) : undefined;
}

export function trialView(
  adapter: MissionAdapter,
  evalCase: BaseCase,
  target: LabelTarget,
): string | undefined {
  const eventsPath = trialFile(target.dir, target.caseId, target.trial, "events.jsonl");
  if (!existsSync(eventsPath)) return undefined;
  const events = parseEventLog(readFileSync(eventsPath, "utf8"));
  let extras: unknown;
  if (adapter.extras !== undefined) {
    const path = trialFile(target.dir, target.caseId, target.trial, adapter.extras.file);
    if (existsSync(path))
      extras = adapter.extras.schema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  }
  const grade = adapter.grade({
    evalCase,
    events,
    targets: adapter.defaultTargets,
    ...(extras === undefined ? {} : { extras }),
  });
  try {
    return adapter.judge.render(evalCase, grade.deliverable, extras);
  } catch {
    return undefined;
  }
}

export async function runLabelSession(
  adapter: MissionAdapter,
  options: LabelSessionOptions,
  io: LabelIO,
): Promise<LabelSessionResult> {
  const labelsFile = options.labelsFile ?? humanLabelsPath(adapter.dataset);
  const criteria = adapter.judge.criteria;
  const existing = loadHumanLabels(labelsFile, criteria).filter(
    (label) => label.labeller === options.labeller,
  );
  const labelled = new Set(existing.map((label) => `${label.run}/${label.caseId}/${label.trial}`));
  const cases = new Map(adapter.loadCases().map((evalCase) => [evalCase.id, evalCase]));
  const prompt = loadEvalPrompt(adapter.judge.promptFile);
  const rubric = rubricLines(prompt.body, criteria);
  const targets = labelTargets(options.resultsDir, adapter, labelled, options.run).slice(
    0,
    options.limit ?? Number.POSITIVE_INFINITY,
  );
  io.print(
    targets.length === 0
      ? `Nothing to label for ${adapter.title}: no judged trials under ${options.resultsDir}/runs/${adapter.mission} that ${options.labeller} has not labelled. Run pnpm eval --mission ${adapter.mission} first.`
      : `${targets.length} judged ${adapter.title} trial(s) to label. Scores are 1 to 5; s skips a trial, q stops. The judge's scores are not shown.`,
  );
  let saved = 0;
  let skipped = 0;
  outer: for (const [index, target] of targets.entries()) {
    const evalCase = cases.get(target.caseId);
    const view = evalCase === undefined ? undefined : trialView(adapter, evalCase, target);
    if (evalCase === undefined || view === undefined) {
      io.print(
        `Skipping ${target.run}/${target.caseId}#${target.trial}: case or deliverable missing.`,
      );
      skipped += 1;
      continue;
    }
    if (
      readJudgeRecord(trialFile(target.dir, target.caseId, target.trial, "judge.json")) ===
      undefined
    ) {
      skipped += 1;
      continue;
    }
    const caseRubric =
      "rubric" in evalCase && Array.isArray(evalCase.rubric) ? evalCase.rubric : [];
    io.print(
      [
        "",
        `=== ${index + 1}/${targets.length} · ${adapter.title} · run ${target.run} · case ${target.caseId} · trial ${target.trial} ===`,
        "",
        "Rubric (scored 1 poor to 5 excellent):",
        ...rubric,
        ...(caseRubric.length === 0
          ? []
          : ["", "Case notes:", ...caseRubric.map((item) => `- ${String(item)}`)]),
        "",
        view,
        "",
      ].join("\n"),
    );
    const scores: Record<string, number> = {};
    for (const criterion of criteria) {
      for (;;) {
        const answer = scoreAnswer(await io.ask(`${criterion} [1-5, s, q]: `));
        if (answer === "quit") break outer;
        if (answer === "skip") {
          skipped += 1;
          continue outer;
        }
        if (answer !== undefined) {
          scores[criterion] = answer;
          break;
        }
        io.print("Type a whole number from 1 to 5, s to skip or q to stop.");
      }
    }
    const notes = (await io.ask("notes (optional): ")).trim();
    appendHumanLabel(
      labelsFile,
      {
        caseId: target.caseId,
        run: target.run,
        trial: target.trial,
        labeller: options.labeller,
        labelledAt: options.now().toISOString().slice(0, 10),
        scores,
        ...(notes === "" ? {} : { notes: notes.slice(0, 1_000) }),
      },
      criteria,
    );
    saved += 1;
  }
  const agreement = missionAgreement(options.resultsDir, adapter, [], labelsFile);
  if (agreement.status !== "no_human_labels")
    writeCalibration(options.resultsDir, adapter, agreement, options.now());
  io.print(
    `\nSaved ${saved} label(s), skipped ${skipped}.\n\n${renderAgreement(agreement, `datasets/${adapter.dataset.name}/human-labels.v1.jsonl`)}`,
  );
  return { saved, skipped, agreement };
}
