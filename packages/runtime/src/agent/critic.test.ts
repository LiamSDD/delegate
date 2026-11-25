import { describe, expect, it } from "vitest";

import { loadPrompt } from "../server";
import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { type ModelRequest } from "../providers/types";
import { claimVerdict, runCritic, type CriticClaim } from "./critic";

const prompts = { critic: loadPrompt("critic.v2.md"), editor: loadPrompt("editor.v2.md") };

const evidence = new Map<string, string[]>([
  ["S1", ["Acme ships 1,200 robots a year to grocery warehouses."]],
  ["S2", ["Acme was founded in 2019 in Rotterdam."]],
]);

function userOf(request: ModelRequest): string {
  const message = request.messages.find((entry) => entry.role === "user");
  return message?.role === "user" ? message.content : "";
}

function idsIn(user: string): string[] {
  return [...user.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("claimVerdict", () => {
  it("takes the worst atom", () => {
    expect(claimVerdict([{ verdict: "supported" }, { verdict: "not_enough_info" }])).toBe(
      "not_enough_info",
    );
    expect(claimVerdict([{ verdict: "not_enough_info" }, { verdict: "contradicted" }])).toBe(
      "contradicted",
    );
    expect(claimVerdict([], "supported")).toBe("supported");
  });
});

describe("selectEvidence", () => {
  it("keeps quotes whole, covers every cited source and prefers quotes that share words with the claim", async () => {
    const { selectEvidence } = await import("./critic");
    const many = new Map<string, string[]>([
      [
        "S1",
        Array.from(
          { length: 12 },
          (_, index) => `Unrelated marketing line number ${index} about nothing.`,
        ),
      ],
      [
        "S2",
        [
          "Acme ships 1,200 robots a year to grocery warehouses, which is a long quote that must stay whole.",
        ],
      ],
    ]);
    many.get("S1")?.push("Acme robots pick 400 orders an hour.");
    const picked = selectEvidence(
      { id: "c", text: "Acme robots pick 400 orders an hour", citations: ["S1", "S2"] },
      many,
    );
    expect(picked.length).toBeLessThanOrEqual(8);
    expect(picked[0]?.quote).toBe("Acme robots pick 400 orders an hour.");
    expect(
      picked.some((entry) => entry.sourceId === "S2" && entry.quote.endsWith("must stay whole.")),
    ).toBe(true);
  });
});

describe("runCritic", () => {
  it("flags unsupported claims, sends them to the editor at most twice, removes what stays unsupported and reports accuracy", async () => {
    let editorCalls = 0;
    const provider = scriptedProvider("fake", (request) => {
      const user = userOf(request);
      if (request.system.includes("You are the editor")) {
        editorCalls += 1;
        const fixes = idsIn(user).map((id) => {
          if (id === "c3") return { id, action: "remove" };
          if (id === "c2")
            return {
              id,
              action: "rewrite",
              text: "Acme ships 1,200 robots a year.",
              citations: ["S1"],
            };
          return {
            id,
            action: "rewrite",
            text: `Acme was founded in Berlin (try ${editorCalls}).`,
            citations: ["S2"],
          };
        });
        return textTurn(JSON.stringify({ fixes }));
      }
      const results = idsIn(user).map((id) => {
        const supported = id === "c1" || (id === "c2" && user.includes('1,200 robots a year."'));
        const verdict = supported ? "supported" : id === "c4" ? "contradicted" : "not_enough_info";
        return { id, atoms: [{ text: id, verdict }] };
      });
      return textTurn(JSON.stringify({ results }));
    });
    const { ctx, events } = testRun({ provider });
    const claims: CriticClaim[] = [
      { id: "c1", text: "Acme was founded in 2019.", citations: ["S2"] },
      { id: "c2", text: "Acme ships 1,200 robots a year to 40 countries.", citations: ["S1"] },
      { id: "c3", text: "Acme is the market leader.", citations: ["S9"] },
      { id: "c4", text: "Acme was founded in Berlin.", citations: ["S2"] },
    ];
    let spawned = 0;
    const said: string[] = [];
    const outcome = await runCritic(ctx, claims, {
      stepId: "critic",
      agent: { agentId: "critic_1", say: (text) => Promise.resolve(void said.push(text)) },
      spawnEditor: () => {
        spawned += 1;
        return Promise.resolve({ agentId: "editor_1", say: () => Promise.resolve() });
      },
      prompts,
      deliverable: "test brief",
      evidence,
      canFix: () => true,
    });
    expect(spawned).toBe(1);
    expect(editorCalls).toBe(2);
    expect([...outcome.kept.keys()].sort()).toEqual(["c1", "c2"]);
    expect(outcome.kept.get("c2")?.text).toBe("Acme ships 1,200 robots a year.");
    expect(outcome.removed.map((claim) => claim.id).sort()).toEqual(["c3", "c4"]);
    expect(outcome.report).toEqual({
      claimsChecked: 4,
      supported: 1,
      fixed: 1,
      weak: 0,
      removed: 2,
      unverified: 0,
      fixLoops: 2,
      citationAccuracy: 0.5,
      draftCitationAccuracy: 0.25,
      publishedAccuracy: 1,
      split: 0,
    });
    const flags = events.filter((event) => event.type === "critic.flagged");
    expect(flags.map((event) => event.payload.category)).toEqual([
      "uncited",
      "claim",
      "claim",
      "uncited",
      "claim",
    ]);
    for (const request of provider.requests) expect(request.tools).toBeUndefined();
  });

  it("removes claims that stay only partly supported after a fix, unless asked to keep them weak", async () => {
    const provider = scriptedProvider("fake", (request) => {
      const user = userOf(request);
      if (request.system.includes("You are the editor"))
        return textTurn(
          JSON.stringify({
            fixes: idsIn(user).map((id) => ({
              id,
              action: "rewrite",
              text: `${id} narrowed`,
              citations: ["S1"],
            })),
          }),
        );
      const results = idsIn(user).map((id) => ({
        id,
        atoms: [{ text: id, verdict: id.startsWith("weak") ? "not_enough_info" : "contradicted" }],
      }));
      return textTurn(JSON.stringify({ results }));
    });
    const claims = [
      { id: "weak1", text: "Acme probably ships robots weekly.", citations: ["S1"] },
      { id: "bad1", text: "Acme ships zero robots.", citations: ["S1"] },
    ];
    const deps = {
      stepId: "critic",
      agent: { agentId: "critic_1", say: () => Promise.resolve() },
      spawnEditor: () => Promise.resolve({ agentId: "editor_1", say: () => Promise.resolve() }),
      prompts,
      deliverable: "test",
      evidence,
      canFix: () => true,
    };
    const strict = await runCritic(testRun({ provider }).ctx, claims, deps);
    expect(strict.kept.size).toBe(0);
    expect(strict.report).toMatchObject({ weak: 0, removed: 2, publishedAccuracy: null });
    const { ctx, events } = testRun({ provider });
    const outcome = await runCritic(ctx, claims, { ...deps, keepPartialAfterFix: true });
    expect(outcome.kept.get("weak1")).toMatchObject({ support: "weak", text: "weak1 narrowed" });
    expect(outcome.kept.has("bad1")).toBe(false);
    expect(outcome.report).toMatchObject({ weak: 1, removed: 1, citationAccuracy: 0 });
    expect(
      events.some(
        (event) => event.type === "critic.flagged" && event.payload.claimId === "weak1:weak",
      ),
    ).toBe(true);
    const checks = provider.requests.filter((request) =>
      request.system.includes("You are the critic"),
    );
    const first = checks[0];
    if (first === undefined) throw new Error("no critic request");
    expect(userOf(first)).toContain(evidence.get("S1")?.[0]);
  });

  it("aligns results by position when the model renames the claim ids", async () => {
    const provider = scriptedProvider("fake", (request) =>
      textTurn(
        JSON.stringify({
          results: idsIn(userOf(request)).map((_, index) => ({
            id: `claim_${index}`,
            verdict: "supported",
          })),
        }),
      ),
    );
    const { ctx } = testRun({ provider });
    const outcome = await runCritic(
      ctx,
      [
        { id: "a", text: "Acme was founded in 2019.", citations: ["S2"] },
        { id: "b", text: "Acme ships robots.", citations: ["S1"] },
      ],
      {
        stepId: "critic",
        agent: { agentId: "critic_1", say: () => Promise.resolve() },
        spawnEditor: () => Promise.reject(new Error("no")),
        prompts,
        deliverable: "test",
        evidence,
        canFix: () => false,
      },
    );
    expect(outcome.report).toMatchObject({ supported: 2, unverified: 0 });
  });

  it("skips the fix loop when time does not allow it and keeps unverifiable claims as unverified", async () => {
    const provider = scriptedProvider("fake", () => textTurn("not json at all"));
    const { ctx } = testRun({ provider });
    const said: string[] = [];
    const outcome = await runCritic(
      ctx,
      [{ id: "c1", text: "Acme ships robots.", citations: ["S1"] }],
      {
        stepId: "critic",
        agent: { agentId: "critic_1", say: (text) => Promise.resolve(void said.push(text)) },
        spawnEditor: () => Promise.reject(new Error("must not spawn")),
        prompts,
        deliverable: "test",
        evidence,
        canFix: () => false,
      },
    );
    expect(outcome.kept.has("c1")).toBe(true);
    expect(outcome.report).toMatchObject({
      unverified: 1,
      claimsChecked: 0,
      citationAccuracy: null,
    });
    expect(said[0]).toMatch(/unverified/);
  });
});
