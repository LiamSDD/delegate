import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastRatio } from "@/lib/contrast";

const css = readFileSync(path.join(import.meta.dirname, "tokens.css"), "utf8");

function themeBlock(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

const THEMES = {
  light: themeBlock('[data-theme="light"]'),
  dark: themeBlock('[data-theme="dark"]'),
  "system dark": themeBlock(':root:not([data-theme="light"])'),
};

const TEXT_PAIRS = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-2"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["text-muted", "surface-2"],
  ["text-subtle", "bg"],
  ["text-subtle", "surface"],
  ["text-subtle", "surface-2"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accent-fg", "accent"],
  ["accent", "accent-soft"],
  ["success", "bg"],
  ["success", "success-soft"],
  ["warning", "bg"],
  ["warning", "warning-soft"],
  ["danger", "bg"],
  ["danger", "danger-soft"],
] as const;

describe("design tokens", () => {
  it("keeps the explicit and system dark themes identical", () => {
    expect(THEMES["system dark"]).toEqual(THEMES.dark);
  });

  for (const [theme, colours] of Object.entries(THEMES)) {
    it.each(TEXT_PAIRS)(`${theme}: %s on %s meets WCAG AA for text`, (fg, bg) => {
      expect(contrastRatio(colours[fg] ?? "", colours[bg] ?? "")).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: focus ring meets 3:1 against bg and surface`, () => {
      expect(contrastRatio(colours.focus ?? "", colours.bg ?? "")).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(colours.focus ?? "", colours.surface ?? "")).toBeGreaterThanOrEqual(3);
    });
  }
});
