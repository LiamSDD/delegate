import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { EVAL_MISSIONS } from "@delegate/evals/results";
import type { LearnedRouting } from "@delegate/evals/routing";
import {
  MISSION_TARGETS,
  TrainingRecordSchema,
  type TrainingRecord,
} from "@delegate/evals/training";
import { RUNTIME_PROMPT_FILES } from "@delegate/runtime/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadEvalResults,
  loadEvalsLearning,
  loadHousePlaybooks,
  loadLearnedRouting,
  loadPromptCatalog,
  loadTraining,
  livePromptVersions,
  trainingLineage,
  trainingRows,
} from "@/server/eval-results";

import { LearnedRoutingTable } from "./learned-routing";
import { PromptVersions } from "./prompt-versions";
import { Training, deltaDomain } from "./training";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "evals-learning-"));
  dirs.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const arm = (mean: number, source: "run" | "cache" | "result" = "run") => ({
  fingerprint: "0123456789abcdef",
  source,
  evalRun: "run-1",
  trials: 16,
  graded: 16,
  errored: 0,
  score: { mean, lower: mean - 0.02, upper: mean + 0.02, n: 16 },
  passRate: { rate: 0.5, lower: 0.3, upper: 0.7, n: 16 },
  hardFailures: 0,
  tokens: 16_000,
  wallMs: 600_000,
  models: [{ role: "worker" as const, provider: "nvidia", model: "alpha", calls: 48 }],
});

function record(patch: Partial<TrainingRecord> & Pick<TrainingRecord, "id">): TrainingRecord {
  return TrainingRecordSchema.parse({
    version: 1,
    mission: "xray",
    round: 1,
    kind: "prompt",
    startedAt: "2026-11-26T09:00:00.000Z",
    finishedAt: "2026-11-26T09:20:00.000Z",
    wallMs: 1_200_000,
    dataset: { name: "company-xray", version: 1 },
    cases: ["a", "b"],
    trialsPerCase: 2,
    parent: { prompts: { "company-xray-synthesis": 2 }, playbooks: { "company-xray": 0 } },
    child: { prompts: { "company-xray-synthesis": 3 }, playbooks: { "company-xray": 0 } },
    change: {
      prompt: { key: "synthesis", name: "company-xray.synthesis", from: 2, to: 3 },
      playbook: null,
    },
    proposal: {
      rationale: "Citations fail most often.",
      addendum: "- Cite every claim.",
      proposer: { provider: "nvidia", model: "alpha" },
    },
    arms: { baseline: arm(0.6, "result"), candidate: arm(0.75) },
    comparison: {
      alpha: 0.05,
      comparisons: 1,
      welch: { delta: 0.15, pValue: 0.001, significant: true },
      paired: {
        cases: 8,
        delta: 0.15,
        lower: 0.12,
        upper: 0.18,
        pValue: 0.0004,
        significant: true,
      },
      cases: [],
    },
    redteam: { suite: "redteam/v2", attacks: 110, successes: 0, asr: 0 },
    decision: { status: "promoted", reasons: ["Candidate beats baseline by 0.150 (p = 0.001)."] },
    promotion: {
      file: "packages/runtime/prompts/company-xray.synthesis.v3.md",
      apply:
        "Point RUNTIME_PROMPT_FILES.synthesis at company-xray.synthesis.v3.md in a reviewed commit.",
    },
    tokens: 16_000,
    models: [{ role: "worker", provider: "nvidia", model: "alpha", calls: 96 }],
    ...patch,
  });
}

const promoted = record({ id: "2026-11-26T09-00-00-000Z-xray-r1-prompt" });
const rejected = record({
  id: "2026-11-26T09-30-00-000Z-xray-r1-playbook",
  kind: "playbook",
  finishedAt: "2026-11-26T09:50:00.000Z",
  change: { prompt: null, playbook: { key: "company-xray", from: 0, to: 1, entries: 4 } },
  arms: { baseline: arm(0.75, "cache"), candidate: arm(0.74) },
  comparison: {
    alpha: 0.025,
    comparisons: 2,
    welch: { delta: -0.01, pValue: 0.7, significant: false },
    paired: { cases: 8, delta: -0.01, lower: -0.05, upper: 0.03, pValue: 0.68, significant: false },
    cases: [],
  },
  decision: { status: "rejected", reasons: ["No statistically supported improvement."] },
  promotion: null,
});
const inconclusive = record({
  id: "2026-11-26T10-00-00-000Z-goal-r1-prompt",
  mission: "goal",
  finishedAt: "2026-11-26T10:10:00.000Z",
  change: { prompt: null, playbook: null },
  arms: { baseline: arm(0.5), candidate: null },
  comparison: { alpha: 0.05, comparisons: 1, welch: null, paired: null, cases: [] },
  redteam: null,
  decision: { status: "inconclusive", reasons: ["Baseline arm: 6 of 16 trials errored."] },
  promotion: null,
});

const prompt = (name: string, version: number) =>
  `---\nname: ${name}\nversion: ${version}\nstatus: active\nintent: test\ninputs: [x]\noutput: y\n---\nbody\n`;

const routing: LearnedRouting = {
  version: 1,
  generatedAt: "2026-11-26T11:00:00.000Z",
  source: { resultFiles: ["packages/evals/results/xray/a.json"], trials: 70 },
  minTrials: 20,
  entries: [
    {
      mission: "company-xray",
      role: "worker",
      order: [
        {
          provider: "nvidia",
          model: "alpha",
          trials: 40,
          passRate: 0.95,
          ci: [0.83, 0.99],
          p50LatencyMs: 10_000,
        },
        {
          provider: "nvidia",
          model: "beta",
          trials: 30,
          passRate: 0.4,
          ci: [0.25, 0.58],
          p50LatencyMs: null,
        },
      ],
      decision: "learned",
      reason: "alpha is above beta.",
    },
    {
      mission: "company-xray",
      role: "planner",
      order: [],
      decision: "insufficient-evidence",
      reason: "The planner role made no model call in 70 trials.",
    },
  ],
};

function seeded(): string {
  const root = repo();
  const training = "packages/evals/results/training";
  for (const entry of [promoted, rejected, inconclusive])
    write(root, `${training}/${entry.id}.json`, JSON.stringify(entry));
  write(root, `${training}/broken.json`, "{");
  write(root, `${training}/renamed.json`, JSON.stringify(promoted));
  write(root, `${training}/arms/xray/0123456789abcdef.json`, "{}");
  write(root, `${training}/pending/session-abc.json`, "{}");
  for (const [name, version] of [
    ["company-xray.synthesis", 1],
    ["company-xray.synthesis", 2],
    ["company-xray.synthesis", 3],
    ["company-xray.researcher", 1],
    ["quarantine-reader", 1],
  ] as const)
    write(root, `packages/runtime/prompts/${name}.v${version}.md`, prompt(name, version));
  write(root, "packages/runtime/prompts/README.md", "notes");
  write(root, "packages/runtime/prompts/bad.v1.md", "no header");
  write(
    root,
    "packages/runtime/playbooks/custom-goal.growth.house.json",
    JSON.stringify({
      key: "custom-goal:growth",
      scope: "house",
      version: 2,
      runs: 6,
      runIds: [],
      entries: [],
      updatedAt: "2026-11-26T09:00:00.000Z",
    }),
  );
  write(root, "packages/runtime/playbooks/company-xray.house.json", "{not json");
  write(root, "config/routing.learned.json", JSON.stringify(routing));
  return root;
}

const xrayFiles = {
  reader: "quarantine-reader.v1.md",
  researcher: "company-xray.researcher.v1.md",
  synthesis: "company-xray.synthesis.v2.md",
};

describe("training loaders", () => {
  it("reads step records newest first, skips sub-folders and reports files that do not match", () => {
    const root = seeded();
    const loaded = loadTraining(path.join(root, "packages/evals/results/training"));
    expect(loaded.records.map((entry) => entry.id)).toEqual([
      inconclusive.id,
      rejected.id,
      promoted.id,
    ]);
    expect(loaded.invalid).toEqual(["training/broken.json", "training/renamed.json"]);
    expect(loadTraining(path.join(root, "missing"))).toEqual({ records: [], invalid: [] });
    expect(loadEvalResults(path.join(root, "packages/evals/results"))).toMatchObject({
      files: [],
      invalid: [],
    });
  });

  it("turns records into rows with arms, the paired difference and its interval", () => {
    const [third, second, first] = trainingRows([promoted, rejected, inconclusive]);
    expect(first).toMatchObject({
      title: "Company X-ray",
      round: 1,
      kind: "prompt",
      status: "promoted",
      change: "company-xray.synthesis v2 → v3",
      baseline: { source: "result", mean: 0.6, n: 16 },
      candidate: { source: "run", mean: 0.75 },
      delta: { kind: "paired", value: 0.15, lower: 0.12, upper: 0.18, units: "8 cases" },
      alpha: 0.05,
      promotedFile: "packages/runtime/prompts/company-xray.synthesis.v3.md",
      redteam: "0/110 attacks succeeded",
      models: ["worker nvidia/alpha ×96"],
    });
    expect(second).toMatchObject({
      status: "rejected",
      change: "house playbook company-xray v0 → v1 (4 entries)",
      comparisons: 2,
      alpha: 0.025,
      promotedFile: null,
    });
    expect(third).toMatchObject({
      title: "Custom goal",
      status: "inconclusive",
      change: "no prompt candidate",
      candidate: null,
      delta: null,
      redteam: null,
    });
  });

  it("builds the lineage of promoted versions per mission and nothing for rejected steps", () => {
    const second = record({
      id: "2026-11-27T09-00-00-000Z-xray-r2-prompt",
      round: 2,
      finishedAt: "2026-11-27T09:20:00.000Z",
      change: {
        prompt: { key: "synthesis", name: "company-xray.synthesis", from: 3, to: 4 },
        playbook: null,
      },
    });
    const lineage = trainingLineage([second, rejected, promoted, inconclusive]);
    expect(lineage.map((entry) => entry.mission)).toEqual([...EVAL_MISSIONS]);
    expect(lineage[0]).toMatchObject({ steps: 3, promoted: 2, playbooks: [] });
    expect(lineage[0]?.prompts).toEqual([
      {
        name: "company-xray.synthesis",
        steps: [
          { from: 2, to: 3, recordId: promoted.id, finishedAt: promoted.finishedAt },
          { from: 3, to: 4, recordId: second.id, finishedAt: second.finishedAt },
        ],
      },
    ]);
    expect(lineage.at(-1)).toMatchObject({ mission: "goal", steps: 1, promoted: 0, prompts: [] });
    expect(lineage[1]).toMatchObject({ steps: 0, promoted: 0 });
  });
});

describe("live prompt versions", () => {
  it("reads versioned prompt files and shipped house playbooks, ignoring anything else", () => {
    const root = seeded();
    const catalog = loadPromptCatalog(path.join(root, "packages/runtime/prompts"));
    expect(catalog.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "company-xray.researcher@1",
      "company-xray.synthesis@1",
      "company-xray.synthesis@2",
      "company-xray.synthesis@3",
      "quarantine-reader@1",
    ]);
    expect(loadHousePlaybooks(path.join(root, "packages/runtime/playbooks"))).toEqual([
      { key: "custom-goal:growth", version: 2, entries: 0, runs: 6 },
    ]);
    expect(loadPromptCatalog(path.join(root, "nope"))).toEqual([]);
    expect(loadHousePlaybooks(path.join(root, "nope"))).toEqual([]);
  });

  it("shows the pointer's version, what else is on disk and a promotion awaiting its pointer", () => {
    const root = seeded();
    const missions = livePromptVersions({
      catalog: loadPromptCatalog(path.join(root, "packages/runtime/prompts")),
      records: [promoted, rejected],
      playbooks: loadHousePlaybooks(path.join(root, "packages/runtime/playbooks")),
      promptFiles: xrayFiles,
    });
    const xray = missions[0];
    expect(xray?.prompts.map((entry) => entry.key)).toEqual(["reader", "researcher", "synthesis"]);
    expect(xray?.prompts[2]).toEqual({
      key: "synthesis",
      name: "company-xray.synthesis",
      file: "company-xray.synthesis.v2.md",
      liveVersion: 2,
      onDisk: [1, 2, 3],
      trainable: true,
      awaitingPointer: 3,
    });
    expect(xray?.prompts[0]).toMatchObject({ trainable: false, awaitingPointer: null });
    expect(missions.at(-1)?.playbooks.map((entry) => entry.key)).toEqual(["custom-goal:growth"]);
    const moved = livePromptVersions({
      catalog: loadPromptCatalog(path.join(root, "packages/runtime/prompts")),
      records: [promoted],
      playbooks: [],
      promptFiles: { ...xrayFiles, synthesis: "company-xray.synthesis.v3.md" },
    });
    expect(moved[0]?.prompts[2]).toMatchObject({ liveVersion: 3, awaitingPointer: null });
    const missing = livePromptVersions({
      catalog: [],
      records: [],
      playbooks: [],
      promptFiles: xrayFiles,
    });
    expect(missing[0]?.prompts[2]).toMatchObject({ liveVersion: null, onDisk: [] });
  });

  it("resolves every mission prompt of the repository through the live pointer", () => {
    const learning = loadEvalsLearning();
    expect(learning.prompts.map((entry) => entry.mission)).toEqual([...EVAL_MISSIONS]);
    for (const entry of learning.prompts) {
      const targets = MISSION_TARGETS[entry.mission];
      expect(entry.prompts.map((row) => row.key)).toEqual([...targets.runtimePrompts]);
      for (const row of entry.prompts) {
        expect(row.file).toBe(RUNTIME_PROMPT_FILES[row.key as keyof typeof RUNTIME_PROMPT_FILES]);
        expect(row.liveVersion).not.toBeNull();
        expect(row.trainable).toBe((targets.prompts as readonly string[]).includes(row.key));
      }
    }
  });
});

describe("learned routing loader", () => {
  it("is absent, invalid or parsed", () => {
    const root = seeded();
    expect(loadLearnedRouting(path.join(root, "config", "none.json"))).toEqual({
      status: "absent",
    });
    expect(loadLearnedRouting(path.join(root, "config", "routing.learned.json"))).toEqual({
      status: "ok",
      routing,
    });
    write(root, "config/bad.json", JSON.stringify({ ...routing, version: 2 }));
    write(root, "config/broken.json", "{");
    expect(loadLearnedRouting(path.join(root, "config", "bad.json")).status).toBe("invalid");
    expect(loadLearnedRouting(path.join(root, "config", "broken.json")).status).toBe("invalid");
  });

  it("loads everything the page needs from one repository root", () => {
    const learning = loadEvalsLearning(seeded());
    expect(learning.training.rows).toHaveLength(3);
    expect(learning.training.invalid).toHaveLength(2);
    expect(learning.routing.status).toBe("ok");
    const empty = loadEvalsLearning(repo());
    expect(empty.training).toMatchObject({ rows: [], invalid: [] });
    expect(empty.routing).toEqual({ status: "absent" });
    expect(empty.prompts.every((entry) => entry.playbooks.length === 0)).toBe(true);
  });
});

describe("sections", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("shows the exact command in every empty state", () => {
    const empty = loadEvalsLearning(repo());
    const training = text(
      renderToStaticMarkup(createElement(Training, { rows: [], lineage: empty.training.lineage })),
    );
    expect(training).toContain("No training round recorded");
    expect(training).toContain("pnpm train --mission all --rounds 1 --budget-minutes 60");
    expect(training).toContain("packages/evals/results/training/");
    const routingText = text(
      renderToStaticMarkup(createElement(LearnedRoutingTable, { state: { status: "absent" } })),
    );
    expect(routingText).toContain("No learned routing yet");
    expect(routingText).toContain("pnpm route:learn");
    expect(routingText).toContain("config/routing.learned.json");
    expect(
      text(
        renderToStaticMarkup(createElement(LearnedRoutingTable, { state: { status: "invalid" } })),
      ),
    ).toContain("Learned routing unreadable");
    expect(
      text(renderToStaticMarkup(createElement(PromptVersions, { missions: empty.prompts }))),
    ).toContain("Prompt files not found");
  });

  it("renders training steps, lineage, live prompts and the routing evidence", () => {
    const learning = loadEvalsLearning(seeded());
    const training = text(
      renderToStaticMarkup(
        createElement(Training, {
          rows: learning.training.rows,
          lineage: learning.training.lineage,
        }),
      ),
    );
    expect(training).toContain("Promoted");
    expect(training).toContain("Rejected");
    expect(training).toContain("Inconclusive");
    expect(training).toContain("company-xray.synthesis v2 → to v3");
    expect(training).toContain("Δ +0.150");
    expect(training).toContain("[+0.120, +0.180] paired over 8 cases");
    expect(training).toContain("Δ −0.010");
    expect(training).toContain("try 2 against this baseline");
    expect(training).toContain("1 of 2 promoted");
    expect(training).toContain("baseline reused result file");
    const routingText = text(
      renderToStaticMarkup(createElement(LearnedRoutingTable, { state: learning.routing })),
    );
    expect(routingText).toContain("1 of 2 mission and role pairs learned");
    expect(routingText).toContain("nvidia/alpha");
    expect(routingText).toContain("n=40 · 95% [83%, 99%] · trial p50 10.0 s");
    expect(routingText).toContain("Insufficient evidence");
    const prompts = text(
      renderToStaticMarkup(
        createElement(PromptVersions, {
          missions: livePromptVersions({
            catalog: loadPromptCatalog(path.join(seeded(), "packages/runtime/prompts")),
            records: [promoted],
            playbooks: [],
            promptFiles: xrayFiles,
          }),
        }),
      ),
    );
    expect(prompts).toContain("v3 promoted");
    expect(prompts).toContain("RUNTIME_PROMPT_FILES.synthesis");
    expect(prompts).toContain("also on disk: v1, v3");
  });

  it("keeps the difference mark's scale symmetric, floored and capped", () => {
    expect(deltaDomain({ value: 0.01, lower: 0, upper: 0.02 })).toBe(0.05);
    expect(deltaDomain({ value: 0.2, lower: -0.1, upper: 0.5 })).toBeCloseTo(0.575);
    expect(deltaDomain({ value: -2, lower: null, upper: null })).toBe(1);
  });
});
