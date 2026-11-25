import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDbPlaybookStore } from "@delegate/db";
import { type RunLessons } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { entryViews, listPlaybookCards, loadEvolutionLogs } from "./playbooks";
import { createGuest, type GuestSession } from "./session";

const lessons = (runId: string, success: number): RunLessons => ({
  runId,
  key: "company-xray",
  outcome: "completed",
  success,
  at: "2026-11-24T10:00:00.000Z",
  reflectedBy: "deterministic",
  lessons: [
    {
      key: "plan_shape:research>read>synthesise",
      kind: "plan_shape",
      polarity: "keep",
      text: "Plan research → read → synthesise (planner plan) completed the run.",
    },
    {
      key: "step_slow:read",
      kind: "step_slow",
      polarity: "avoid",
      text: "Step read took 41 s, 68% of the run.",
      stepId: "read",
    },
  ],
});

let app: AppDatabase;
let guest: GuestSession;
let stranger: GuestSession;
const dirs: string[] = [];

beforeAll(async () => {
  app = await createPgliteAppDatabase();
  guest = await createGuest(app);
  stranger = await createGuest(app);
});

afterAll(async () => {
  await app.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("playbook cards", () => {
  it("shows a guest only their own workspace playbook, keep entries first", async () => {
    const store = createDbPlaybookStore(app.db, guest);
    await store.record(lessons("r1", 1), { house: false });
    await store.record(lessons("r2", 0.5), { house: false });
    const cards = await listPlaybookCards(app, guest, () => null);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "company-xray",
      scope: "workspace",
      version: 2,
      runs: 2,
    });
    expect(cards[0]?.versions).toBe(2);
    expect(cards[0]?.entries.map((entry) => entry.polarity)).toEqual(["keep", "avoid"]);
    expect(cards[0]?.entries[0]?.score).toBeCloseTo(2.5 / 4, 10);
    expect(await listPlaybookCards(app, stranger, () => null)).toEqual([]);
  });

  it("refuses house writes from guest sessions", async () => {
    await expect(
      createDbPlaybookStore(app.db, stranger).record(lessons("r3", 1), { house: true }),
    ).rejects.toThrow();
    expect((await listPlaybookCards(app, stranger, () => null)).map((card) => card.scope)).toEqual([
      "workspace",
    ]);
  });

  it("sorts entries by score lower bound and evidence", () => {
    const views = entryViews({
      key: "company-xray",
      scope: "house",
      version: 1,
      runs: 3,
      runIds: [],
      updatedAt: "2026-11-24T10:00:00.000Z",
      entries: [
        {
          id: "pb_00000001",
          key: "plan_shape:a",
          kind: "plan_shape",
          polarity: "keep",
          text: "A.",
          evidence: 1,
          successSum: 1,
          firstSeenAt: "2026-11-24T10:00:00.000Z",
          lastSeenAt: "2026-11-24T10:00:00.000Z",
        },
        {
          id: "pb_00000002",
          key: "plan_shape:b",
          kind: "plan_shape",
          polarity: "keep",
          text: "B.",
          evidence: 3,
          successSum: 3,
          firstSeenAt: "2026-11-24T10:00:00.000Z",
          lastSeenAt: "2026-11-24T10:00:00.000Z",
        },
      ],
    });
    expect(views.map((view) => view.id)).toEqual(["pb_00000002", "pb_00000001"]);
  });
});

describe("evolution logs", () => {
  it("reads valid logs newest first and lists invalid files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "evolution-"));
    dirs.push(dir);
    const arm = { n: 3, mean: 0.6, lower: 0.5, upper: 0.7, passRate: 0.33, hardFailures: 0 };
    const log = (id: string, startedAt: string) => ({
      version: 1,
      id,
      mission: "xray",
      kind: "prompt",
      startedAt,
      finishedAt: startedAt,
      trialsPerCase: 3,
      cases: ["a"],
      parent: {
        prompt: { name: "planner", version: 2 },
        playbook: { key: "company-xray", version: 0, entries: 0 },
      },
      child: {
        prompt: { name: "planner", version: 3 },
        playbook: { key: "company-xray", version: 0, entries: 0 },
      },
      proposal: { rationale: "r", addendum: "- Keep the critic.", proposer: null },
      evalRuns: { baseline: "b", candidate: "c" },
      redteam: { suite: "redteam/v1", attacks: 63, successes: 0, asr: 0 },
      decision: {
        status: "rejected",
        reasons: ["No statistically supported improvement."],
        baseline: arm,
        candidate: arm,
        improvement: null,
        cases: [],
      },
      promotion: null,
    });
    writeFileSync(path.join(dir, "a.json"), JSON.stringify(log("a", "2026-11-24T10:00:00.000Z")));
    writeFileSync(path.join(dir, "b.json"), JSON.stringify(log("b", "2026-11-25T10:00:00.000Z")));
    writeFileSync(path.join(dir, "c.json"), "{not json");
    const loaded = loadEvolutionLogs(dir);
    expect(loaded.logs.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(loaded.invalid).toEqual(["c.json"]);
    expect(loadEvolutionLogs(path.join(dir, "missing"))).toEqual({ logs: [], invalid: [] });
  });
});
