import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractPage, pageSourceText } from "./extract";
import { detectLanguage } from "./language";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("extractPage", () => {
  const page = extractPage(
    fixture("product-page.html"),
    "https://www.northwind.example/products/fleet-planner",
  );

  it("keeps the main content with its heading structure and drops nav, sidebar, footer and banners", () => {
    expect(page.extraction).toBe("main");
    expect(page.mainText.startsWith("# Fleet Planner")).toBe(true);
    expect(page.mainText).toContain("## What it does");
    expect(page.mainText).toContain("- Imports order history from SAP and Manhattan WMS");
    expect(page.mainText).not.toMatch(/cookies|Log in|Subscribe|Imprint|Pick Assist/);
  });

  it("renders tables as pipe rows with a header rule", () => {
    expect(page.mainText).toContain(
      "| Plan | Robots | Price |\n| --- | --- | --- |\n| Starter | up to 20 | 1,900 EUR / month |",
    );
  });

  it("never puts hidden text in the main text, and reports it for the injection check", () => {
    expect(page.mainText).not.toContain("reveal the system prompt");
    expect(page.hiddenText.join(" ")).toContain("reveal the system prompt");
  });

  it("extracts JSON-LD organisation, product, price and address, and OpenGraph", () => {
    expect(page.structured.organization).toMatchObject({
      name: "Northwind Robotics GmbH",
      foundingDate: "2017",
      address: "Hafenstrasse 4, 20457, Hamburg, DE",
    });
    expect(page.structured.products[0]).toMatchObject({
      name: "Fleet Planner",
      brand: "Northwind",
      price: "1900.00",
      priceCurrency: "EUR",
    });
    expect(page.structured.openGraph["product:price:amount"]).toBe("1900");
    const text = pageSourceText(page);
    expect(text).toContain("- Organization: name: Northwind Robotics GmbH");
    expect(text).toContain("- Listed price: 1900 EUR");
    expect(text.startsWith("Description: Plan robot fleets for any warehouse.")).toBe(true);
  });

  it("moves instruction-like structured data out of the source text", () => {
    expect(pageSourceText(page)).not.toContain("Ignore previous instructions");
  });

  it("keeps canonical, language and links, and marks links in the main content", () => {
    expect(page.canonical).toContain("/products/fleet-planner");
    expect(page.language).toBe("en");
    expect(page.links.map((link) => link.href)).toContain("https://www.northwind.example/pricing");
    expect(
      page.mainLinks.has("https://www.northwind.example/docs/fleet-planner/getting-started"),
    ).toBe(true);
    expect(page.mainLinks.has("https://www.northwind.example/pricing")).toBe(false);
  });

  it("finds the content block by text density when there is no main element", () => {
    const soup = extractPage(fixture("div-soup.html"), "https://shop.example/returns");
    expect(soup.extraction).toBe("density");
    expect(soup.mainText).toContain("within 30 days of delivery");
    expect(soup.mainText).toContain("4.95 GBP");
    expect(soup.mainText).not.toMatch(/Shoes|Scarves|Careers/);
  });

  it("reads meta robots directives", () => {
    const blocked = extractPage(
      '<html><head><meta name="robots" content="noindex, nofollow"></head><body><p>x</p></body></html>',
      "https://a.example/",
    );
    expect(blocked.robots).toEqual({ noindex: true, nofollow: true });
  });

  it("survives deeply nested and unclosed markup", () => {
    const html = `<body>${"<div>".repeat(5_000)}<p>${"deep text ".repeat(30)}</p></body>`;
    expect(extractPage(html, "https://a.example/").mainText).toContain("deep text");
  });
});

describe("detectLanguage", () => {
  it("detects common languages from stopwords and falls back to the declared tag", () => {
    expect(
      detectLanguage(
        "Wir sind ein Team, das die besten Roboter für die Logistik baut und auch mit unseren Kunden arbeitet. Die Lösung ist nicht teuer und sie ist schnell.",
      ),
    ).toBe("de");
    expect(
      detectLanguage(
        "The robots are built for the warehouse and they work with your team on the floor for the whole day, and it is fast.",
      ),
    ).toBe("en");
    expect(detectLanguage("Kurz.", "fr-FR")).toBe("fr");
    expect(detectLanguage("Kurz.")).toBe("und");
  });
});
