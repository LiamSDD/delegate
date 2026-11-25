import { describe, expect, it } from "vitest";

import { parseRobots } from "./robots";

const AGENT = "DelegateBot";

describe("parseRobots", () => {
  it("allows everything for an empty file", () => {
    expect(parseRobots("").isAllowed("/anything", AGENT)).toBe(true);
  });

  it("applies the wildcard group when no specific group matches", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /private\n");
    expect(robots.isAllowed("/private/page", AGENT)).toBe(false);
    expect(robots.isAllowed("/public", AGENT)).toBe(true);
  });

  it("prefers the most specific user-agent group over the wildcard", () => {
    const robots = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: delegatebot\nDisallow: /admin\n",
    );
    expect(robots.isAllowed("/about", AGENT)).toBe(true);
    expect(robots.isAllowed("/admin", AGENT)).toBe(false);
  });

  it("uses longest match, with Allow winning ties", () => {
    const robots = parseRobots(
      "User-agent: *\nDisallow: /blog\nAllow: /blog/public\nAllow: /shop\nDisallow: /shop\n",
    );
    expect(robots.isAllowed("/blog/secret", AGENT)).toBe(false);
    expect(robots.isAllowed("/blog/public/post", AGENT)).toBe(true);
    expect(robots.isAllowed("/shop", AGENT)).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=\n");
    expect(robots.isAllowed("/files/report.pdf", AGENT)).toBe(false);
    expect(robots.isAllowed("/files/report.pdf?x=1", AGENT)).toBe(true);
    expect(robots.isAllowed("/search?q=test", AGENT)).toBe(false);
  });

  it("groups consecutive user-agent lines and ignores comments and empty Disallow", () => {
    const robots = parseRobots(
      "# comment\nUser-agent: GoogleBot\nUser-agent: DelegateBot # us\nDisallow: /x\n\nUser-agent: *\nDisallow:\n",
    );
    expect(robots.isAllowed("/x/y", AGENT)).toBe(false);
    expect(robots.isAllowed("/x/y", "OtherBot")).toBe(true);
  });

  it("collects sitemap directives", () => {
    const robots = parseRobots(
      "Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:\nsitemap: https://example.com/news.xml\n",
    );
    expect(robots.sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/news.xml",
    ]);
  });

  it("matches percent-encoded and query paths", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /a%20b\nDisallow: /*?session=\n");
    expect(robots.isAllowed("/a%20b/c", AGENT)).toBe(false);
    expect(robots.isAllowed("/page?session=1", AGENT)).toBe(false);
  });

  it("reads Crawl-delay for the matching group, falling back to *", () => {
    const robots = parseRobots(
      "User-agent: *\nCrawl-delay: 2\n\nUser-agent: DelegateBot\nCrawl-delay: 5\nDisallow: /x\n",
    );
    expect(robots.crawlDelaySeconds(AGENT)).toBe(5);
    expect(robots.crawlDelaySeconds("OtherBot")).toBe(2);
    expect(parseRobots("User-agent: *\nDisallow:\n").crawlDelaySeconds(AGENT)).toBeUndefined();
  });
});
