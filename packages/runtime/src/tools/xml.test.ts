import { describe, expect, it } from "vitest";

import { parseFeed, parseSitemap } from "./xml";

describe("parseSitemap", () => {
  it("reads url sets", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://acme.example/</loc></url>
      <url><loc> https://acme.example/about?x=1&amp;y=2 </loc><lastmod>2026-01-01</lastmod></url>
    </urlset>`;
    expect(parseSitemap(xml)).toEqual({
      urls: ["https://acme.example/", "https://acme.example/about?x=1&y=2"],
      sitemaps: [],
    });
  });

  it("reads sitemap indexes", () => {
    const xml = `<sitemapindex><sitemap><loc>https://acme.example/pages.xml</loc></sitemap>
      <sitemap><loc><![CDATA[https://acme.example/posts.xml]]></loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({
      urls: [],
      sitemaps: ["https://acme.example/pages.xml", "https://acme.example/posts.xml"],
    });
  });

  it("returns nothing for non-sitemap content", () => {
    expect(parseSitemap("<html><body>nope</body></html>")).toEqual({ urls: [], sitemaps: [] });
  });
});

describe("parseFeed", () => {
  it("reads RSS items newest first", () => {
    const xml = `<rss><channel><title>Acme</title>
      <item><title>Old post</title><link>https://acme.example/old</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
      <item><title><![CDATA[New <b>launch</b>]]></title><link>https://acme.example/new</link>
        <pubDate>Tue, 05 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;We launched.&lt;/p&gt;</description></item>
    </channel></rss>`;
    expect(parseFeed(xml)).toEqual([
      {
        title: "New launch",
        link: "https://acme.example/new",
        published: "2026-11-05T10:00:00.000Z",
        summary: "We launched.",
      },
      {
        title: "Old post",
        link: "https://acme.example/old",
        published: "2024-01-01T10:00:00.000Z",
      },
    ]);
  });

  it("reads Atom entries", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title type="html">Funding round</title><link rel="alternate" href="https://acme.example/funding"/>
      <updated>2026-10-01T00:00:00Z</updated><summary>Series B.</summary></entry>
    </feed>`;
    expect(parseFeed(xml)).toEqual([
      {
        title: "Funding round",
        link: "https://acme.example/funding",
        published: "2026-10-01T00:00:00.000Z",
        summary: "Series B.",
      },
    ]);
  });

  it("caps items and skips entries without titles", () => {
    const items = Array.from(
      { length: 30 },
      (_, index) => `<item><title>Post ${index}</title></item>`,
    );
    expect(parseFeed(`<rss>${items.join("")}<item><link>x</link></item></rss>`, 5)).toHaveLength(5);
  });
});
