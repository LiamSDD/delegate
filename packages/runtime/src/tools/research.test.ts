import { describe, expect, it } from "vitest";

import { FIXTURE_ORIGIN, fixtureDns, fixtureFetch } from "../testing/fixture-site";
import { RESEARCH_STEP, scriptedProvider, testRun } from "../testing/fakes";
import { createFetcher } from "./fetch";
import { executeToolCall, type ToolCaller } from "./registry";
import {
  createResearchEnvironment,
  createResearchTools,
  rankCandidates,
  siteScope,
  type ResearchEnvironment,
} from "./research";

const system: ToolCaller = {
  actor: { type: "system", id: "orchestrator" },
  provider: { id: "fake", terms: "public-demo-ok" },
};

function setup(extra?: Parameters<typeof fixtureFetch>[0]) {
  const site = fixtureFetch(extra);
  const fetcher = createFetcher({
    fetchImpl: site.fetchImpl,
    resolveDns: fixtureDns,
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-11-24T10:00:00Z"),
  });
  const env: ResearchEnvironment = createResearchEnvironment({
    fetcher,
    siteUrl: `${FIXTURE_ORIGIN}/`,
    digest: (documents) =>
      Promise.resolve(
        `digested ${documents.map((document) => document.record.sourceId).join(",")}`,
      ),
  });
  const run = testRun({ provider: scriptedProvider("fake", []) });
  const tools = createResearchTools(env);
  const call = (name: string, args: unknown) =>
    executeToolCall(
      run.ctx,
      RESEARCH_STEP,
      tools,
      { name, argumentsJson: JSON.stringify(args) },
      system,
    );
  return { site, env, run, call };
}

describe("siteScope", () => {
  it("treats www and subdomains of the input host as the same site", () => {
    const scope = siteScope("https://www.acme.example/en/");
    expect(scope).toMatchObject({ origin: "https://www.acme.example", root: "acme.example" });
    expect(scope.contains("https://acme.example/about")).toBe(true);
    expect(scope.contains("https://docs.acme.example/")).toBe(true);
    expect(scope.contains("https://acme.example.evil.test/")).toBe(false);
    expect(scope.contains("https://notacme.example/")).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("prefers one page per research category, shallow and unlocalised, and skips assets", () => {
    const ranked = rankCandidates(
      [
        "https://acme.example/de/about",
        "https://acme.example/about",
        "https://acme.example/blog/2020/01/old-post",
        "https://acme.example/pricing",
        "https://acme.example/logo.png",
        "https://acme.example/customers/case-studies",
        "https://acme.example/legal/imprint",
        "https://acme.example/careers",
      ],
      4,
    );
    expect(ranked).toEqual([
      "https://acme.example/about",
      "https://acme.example/pricing",
      "https://acme.example/customers/case-studies",
      "https://acme.example/careers",
    ]);
  });
});

describe("research tools", () => {
  it("crawl_site reads the homepage, sitemap and ranked pages, honouring robots.txt", async () => {
    const { site, env, call } = setup();
    const result = await call("crawl_site", { maxPages: 6 });
    expect(result.ok).toBe(true);
    const urls = env.sources.all().map((document) => document.record.url);
    expect(urls[0]).toBe(`${FIXTURE_ORIGIN}/`);
    expect(urls).toContain(`${FIXTURE_ORIGIN}/about`);
    expect(urls).toContain(`${FIXTURE_ORIGIN}/pricing`);
    expect(urls.length).toBeLessThanOrEqual(6);
    expect(site.requested).not.toContain(`${FIXTURE_ORIGIN}/admin/secret`);
    expect(env.sources.all().every((document) => document.record.kind === "company_site")).toBe(
      true,
    );
    expect(result.content).toMatch(/^digested S1/);
    expect(env.discoveries).toMatchObject({
      names: expect.arrayContaining(["Acme Robotics"]) as unknown,
      githubOrgs: ["acme-robotics"],
      feeds: [`${FIXTURE_ORIGIN}/blog/feed.xml`],
    });
    const about = env.sources.all().find((document) => document.record.url.endsWith("/about"));
    expect(about?.text).not.toContain("Ignore previous instructions");
    expect(about?.hiddenText.join(" ")).toContain("Ignore previous instructions");
  });

  it("emits a raw-output artifact for the trace and keeps raw text out of the model-facing result", async () => {
    const { run, call } = setup();
    const result = await call("crawl_site", { maxPages: 2 });
    const artifact = run.events.find((event) => event.type === "artifact.created");
    expect(artifact).toMatchObject({ payload: { kind: "source-snapshot" } });
    expect(result.content).not.toContain("Robots that pick and pack");
  });

  it("prefers the GitHub org whose name matches the company domain", async () => {
    const { env, call } = setup((url) =>
      url.href === `${FIXTURE_ORIGIN}/`
        ? new Response(
            '<html><head><title>Acme</title></head><body><a href="https://github.com/acme-community">c</a><a href="https://github.com/acme/">o</a></body></html>',
            { headers: { "content-type": "text/html" } },
          )
        : undefined,
    );
    await call("crawl_site", { maxPages: 1 });
    expect(env.discoveries.githubOrgs).toEqual(["acme", "acme-community"]);
  });

  it("fetch_page refuses URLs outside the company site, Wikipedia and GitHub", async () => {
    const { call, site } = setup();
    const result = await call("fetch_page", { url: "https://evil.example/x" });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/outside/);
    expect(site.requested).not.toContain("https://evil.example/x");
  });

  it("fetch_page does not download a page that is already a source", async () => {
    const { call, site } = setup();
    await call("crawl_site", { maxPages: 3 });
    const before = site.requested.length;
    const result = await call("fetch_page", { url: `${FIXTURE_ORIGIN}/` });
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/already/);
    expect(site.requested.length).toBe(before);
  });

  it("wikipedia_lookup only accepts an entity whose official website is the company site", async () => {
    const { env, call } = setup();
    const result = await call("wikipedia_lookup", { names: ["Acme"] });
    expect(result.ok).toBe(true);
    const kinds = env.sources.all().map((document) => document.record.kind);
    expect(kinds).toEqual(["wikidata", "wikipedia"]);
    const wikidata = env.sources.all()[0];
    expect(wikidata?.record.url).toBe("https://www.wikidata.org/wiki/Q1");
    expect(wikidata?.text).toContain("Inception: 2019-03-01");
    expect(wikidata?.text).toContain("Industry: robotics");
    expect(wikidata?.text).toContain("Headquarters: Berlin");
    expect(env.sources.all()[1]?.text).toContain("competes with RoboCorp");
  });

  it("wikipedia_lookup reports no match instead of guessing", async () => {
    const { env, call } = setup((url) =>
      url.searchParams.get("action") === "wbsearchentities"
        ? new Response(JSON.stringify({ search: [{ id: "Q2" }] }), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    const result = await call("wikipedia_lookup", { names: ["Acme"] });
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/No Wikidata entity/);
    expect(env.sources.all()).toEqual([]);
  });

  it("github_org summarises repositories and languages for a verified org", async () => {
    const { env, call } = setup();
    const result = await call("github_org", { org: "acme-robotics" });
    expect(result.ok).toBe(true);
    const [github] = env.sources.all();
    expect(github?.record).toMatchObject({
      kind: "github",
      url: "https://github.com/acme-robotics",
    });
    expect(github?.text).toContain("Top languages: Rust (1), Python (1)");
    expect(github?.text).toContain("fleet-sim");
    expect(github?.text).not.toContain("ros2");
  });

  it("github_org rejects an org that is not linked to the company site", async () => {
    const { call } = setup((url) =>
      url.href === "https://api.github.com/orgs/someone"
        ? new Response(
            JSON.stringify({
              login: "someone",
              blog: "https://other.example",
              html_url: "https://github.com/someone",
            }),
            {
              headers: { "content-type": "application/json" },
            },
          )
        : undefined,
    );
    const result = await call("github_org", { org: "someone" });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/not verifiably/);
  });

  it("read_feed turns RSS items into a dated news source", async () => {
    const { env, call } = setup();
    const result = await call("read_feed", { url: `${FIXTURE_ORIGIN}/blog/feed.xml` });
    expect(result.ok).toBe(true);
    expect(env.sources.all()[0]?.record.kind).toBe("feed");
    expect(env.sources.all()[0]?.text).toContain("2026-11-03: Acme raises Series B");
  });
});
