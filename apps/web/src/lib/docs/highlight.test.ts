import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CODE_TOKEN_CLASSES } from "@/components/docs/code-block";
import { contrastRatio } from "@/lib/contrast";

import { codeLanguage, highlight } from "./highlight";

function kinds(code: string, lang: string): [string, string][] {
  return highlight(code, lang)
    .filter((token) => token.kind !== null)
    .map((token) => [token.kind ?? "", token.text]);
}

const SAMPLES: Record<string, string> = {
  bash: "export PATH=~/.local/node/bin:$PATH\nDELEGATE_URL=https://host pnpm --filter @delegate/web dev # start\necho \"a # b\" 'c' ${HOME}\n",
  json: '{\n  "servers": { "delegate": { "type": "http", "n": -1.5e3, "ok": true, "x": null } }\n}\n',
  toml: '[mcp_servers.delegate]\nurl = "https://host/api/mcp"\nretries = 3 # comment\nenabled = true\n',
  sql: "ALTER ROLE delegate_app_login PASSWORD '<secret>'; -- once\nselect 1 from runs where id = 'a''b';\n",
  ts: 'import { z } from "zod";\nexport const limit = 42; // cap\nconst s = `a ${limit}`;\n',
  yaml: "name: delegate # app\nport: 3000\nitems:\n  - enabled: true\n",
  text: "URL:        https://host/api/mcp\n",
  mermaid: "flowchart LR\n  A --> B\n",
};

describe("highlight", () => {
  it.each(Object.entries(SAMPLES))("never changes the text of a %s block", (lang, code) => {
    expect(
      highlight(code, lang)
        .map((token) => token.text)
        .join(""),
    ).toBe(code);
  });

  it("marks shell comments, strings, variables and leading keywords", () => {
    expect(kinds(SAMPLES.bash ?? "", "bash")).toEqual([
      ["keyword", "export"],
      ["variable", "PATH"],
      ["variable", "$PATH"],
      ["variable", "DELEGATE_URL"],
      ["comment", "# start"],
      ["string", '"a # b"'],
      ["string", "'c'"],
      ["variable", "${HOME}"],
    ]);
  });

  it("does not treat a hash inside a word or a flag as a comment or keyword", () => {
    expect(kinds("curl https://x.test/#frag --do-thing\n", "sh")).toEqual([]);
  });

  it("separates JSON keys from string values", () => {
    expect(kinds('{"a": "b", "n": 2, "t": true}', "json")).toEqual([
      ["punctuation", "{"],
      ["property", '"a"'],
      ["punctuation", ":"],
      ["string", '"b"'],
      ["punctuation", ","],
      ["property", '"n"'],
      ["punctuation", ":"],
      ["number", "2"],
      ["punctuation", ","],
      ["property", '"t"'],
      ["punctuation", ":"],
      ["keyword", "true"],
      ["punctuation", "}"],
    ]);
  });

  it("marks TOML tables, keys, strings, scalars and comments", () => {
    expect(kinds(SAMPLES.toml ?? "", "toml")).toEqual([
      ["keyword", "[mcp_servers.delegate]"],
      ["property", "url"],
      ["string", '"https://host/api/mcp"'],
      ["property", "retries"],
      ["number", "3"],
      ["comment", "# comment"],
      ["property", "enabled"],
      ["keyword", "true"],
    ]);
  });

  it("marks SQL keywords in any case and keeps escaped quotes inside a string", () => {
    const tokens = kinds(SAMPLES.sql ?? "", "sql");
    expect(tokens).toContainEqual(["keyword", "ALTER"]);
    expect(tokens).toContainEqual(["keyword", "select"]);
    expect(tokens).toContainEqual(["string", "'a''b'"]);
    expect(tokens).toContainEqual(["comment", "-- once"]);
  });

  it("leaves unknown languages and plain text untouched", () => {
    expect(codeLanguage("mermaid")).toBeNull();
    expect(codeLanguage(undefined)).toBeNull();
    expect(highlight("a < b", "text")).toEqual([{ kind: null, text: "a < b" }]);
    expect(highlight("", "bash")).toEqual([]);
  });

  it("reads only the first word of an info string", () => {
    expect(codeLanguage('ts filename="proxy.ts" switcher')).toBe("script");
    expect(codeLanguage("JSON")).toBe("json");
  });
});

describe("code colours", () => {
  const css = readFileSync(
    path.join(import.meta.dirname, "..", "..", "styles", "tokens.css"),
    "utf8",
  );

  function theme(selector: string): Record<string, string> {
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

  const classes = [...new Set(Object.values(CODE_TOKEN_CLASSES))];

  it.each(['[data-theme="light"]', '[data-theme="dark"]'])(
    "meet WCAG AA on the code block background in %s",
    (selector) => {
      const colours = theme(selector);
      for (const className of classes) {
        const token = /^text-([a-z-]+)$/.exec(className)?.[1] ?? "";
        const colour = colours[token];
        expect(colour, `${className} maps to a token`).toBeDefined();
        expect(contrastRatio(colour ?? "", colours.surface ?? "")).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
