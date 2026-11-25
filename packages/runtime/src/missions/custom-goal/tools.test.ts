import { describe, expect, it } from "vitest";

import { createFetcher } from "../../tools/fetch";
import { type RegisteredTool } from "../../tools/registry";
import { SourceStore } from "../../tools/sources";
import { fixtureDns } from "../../testing/fixture-site";
import { scriptedProvider, testRun, textTurn } from "../../testing/fakes";
import { createCompanyResolver, createReferenceSearch, labelMatches } from "./tools";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function fakeWeb(routes: (url: URL) => Response | undefined) {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url.href);
    return Promise.resolve(routes(url) ?? new Response("not found", { status: 404 }));
  };
  return {
    requested,
    fetcher: createFetcher({ fetchImpl, resolveDns: fixtureDns, sleep: () => Promise.resolve() }),
  };
}

async function call(tool: RegisteredTool, args: unknown) {
  const { ctx } = testRun({ provider: scriptedProvider("scripted", [textTurn("{}")]) });
  const prepared = tool.prepare(args);
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.call.run({ run: ctx, stepId: "resolve_target", toolCallId: "tc_1" });
}

const entities = {
  Q1: { labels: { en: { value: "Nike" } }, claims: {} },
  Q2: {
    labels: { en: { value: "Nike, Inc." } },
    claims: {
      P856: [
        { mainsnak: { datavalue: { value: "https://github.com/nike" } } },
        { mainsnak: { datavalue: { value: "https://www.nike.com" } } },
      ],
    },
  },
  Q3: {
    labels: { en: { value: "Nikea Foods" } },
    claims: { P856: [{ mainsnak: { datavalue: { value: "https://nikea.example" } } }] },
  },
};

describe("createCompanyResolver", () => {
  it("prefers a matching organisation over a matching place that also lists a website", async () => {
    const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
    const web = fakeWeb((url) => {
      if (url.searchParams.get("action") === "wbsearchentities")
        return json({ search: [{ id: "Q10" }, { id: "Q11" }, { id: "Q12" }] });
      if (url.searchParams.get("action") === "wbgetentities")
        return json({
          entities: {
            Q10: { labels: { en: { value: "Patagonia" } }, claims: { P625: claim({}) } },
            Q11: {
              labels: { en: { value: "Patagonia" } },
              claims: {
                P856: claim("http://townofpatagonia.com/"),
                P625: claim({ latitude: 31.5, longitude: -110.7 }),
                P1082: claim({ amount: "+913" }),
              },
            },
            Q12: {
              labels: { en: { value: "Patagonia" } },
              claims: {
                P856: claim("https://www.patagonia.com/"),
                P452: claim({ id: "Q1" }),
                P159: claim({ id: "Q2" }),
              },
            },
          },
        });
      return undefined;
    });
    const resolver = createCompanyResolver(web.fetcher);
    await call(resolver.tool, { names: ["Patagonia"] });
    expect(resolver.resolved()).toMatchObject({ url: "https://www.patagonia.com/", entity: "Q12" });
  });

  it("accepts the first entity whose label matches and that lists a non-code-host official site", async () => {
    const web = fakeWeb((url) => {
      if (url.searchParams.get("action") === "wbsearchentities")
        return json({ search: [{ id: "Q1" }, { id: "Q3" }, { id: "Q2" }] });
      if (url.searchParams.get("action") === "wbgetentities") return json({ entities });
      return undefined;
    });
    const resolver = createCompanyResolver(web.fetcher);
    const outcome = await call(resolver.tool, { names: ["nike"] });
    expect(resolver.resolved()).toEqual({
      name: "Nike, Inc.",
      url: "https://www.nike.com/",
      resolvedBy: "wikidata",
      entity: "Q2",
    });
    expect(outcome.summary).toMatch(/Q2/);
    expect(web.requested.every((url) => url.startsWith("https://www.wikidata.org/w/api.php"))).toBe(
      true,
    );
  });

  it("assumes nothing when no entity matches", async () => {
    const web = fakeWeb((url) =>
      url.searchParams.get("action") === "wbsearchentities"
        ? json({ search: [{ id: "Q1" }] })
        : json({ entities: { Q1: entities.Q1 } }),
    );
    const resolver = createCompanyResolver(web.fetcher);
    const outcome = await call(resolver.tool, { names: ["nike", "swoosh"] });
    expect(resolver.resolved()).toBeNull();
    expect(outcome.forModel).toMatch(/nothing was guessed/);
  });

  it("matches labels on whole words, ignoring corporate suffixes", () => {
    expect(labelMatches("Nike, Inc.", "nike")).toBe(true);
    expect(labelMatches("Deutsche Bahn AG", "Deutsche Bahn")).toBe(true);
    expect(labelMatches("Nikea Foods", "nike")).toBe(false);
  });
});

describe("createReferenceSearch", () => {
  it("stores Wikipedia introductions as sources and skips stubs", async () => {
    const web = fakeWeb((url) => {
      if (url.searchParams.get("list") === "search")
        return json({ query: { search: [{ title: "Marketing" }, { title: "Stub" }] } });
      if (url.searchParams.get("prop") === "extracts")
        return json({
          query: {
            pages: {
              "1": { title: "Marketing", extract: "Marketing ".repeat(20) },
              "2": { title: "Stub", extract: "Too short." },
              "-1": { title: "Missing", missing: "" },
            },
          },
        });
      return undefined;
    });
    const store = new SourceStore();
    const search = createReferenceSearch(web.fetcher, store);
    await call(search.tool, { queries: ["marketing"] });
    expect(search.created().map((document) => document.record)).toEqual([
      expect.objectContaining({
        sourceId: "S1",
        kind: "wikipedia",
        url: "https://en.wikipedia.org/wiki/Marketing",
      }),
    ]);
    expect(store.all()).toHaveLength(1);
  });
});
