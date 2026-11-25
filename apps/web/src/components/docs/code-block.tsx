import { ArrowUpRight } from "lucide-react";

import { highlight, type CodeTokenKind } from "@/lib/docs/highlight";

import { CopyButton } from "./copy-button";

export const CODE_TOKEN_CLASSES: Readonly<Record<CodeTokenKind, string>> = {
  comment: "text-text-subtle",
  string: "text-success",
  number: "text-warning",
  keyword: "text-accent",
  property: "text-accent",
  variable: "text-warning",
  punctuation: "text-text-muted",
};

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  json: "JSON",
  toml: "TOML",
  sql: "SQL",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  yaml: "YAML",
  yml: "YAML",
  env: "Environment",
  dotenv: "Environment",
  text: "Text",
  html: "HTML source",
  mermaid: "Mermaid diagram source",
};

function languageName(lang: string | undefined): string | undefined {
  return (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase();
}

export function CodeBlock({
  code,
  lang,
  renderedUrl,
}: {
  code: string;
  lang?: string | undefined;
  renderedUrl?: string | undefined;
}) {
  const name = languageName(lang) ?? "";
  const label = LANGUAGE_LABELS[name] ?? (name === "" ? "Code" : name);
  const tokens = highlight(code, lang);
  return (
    <figure className="mt-5 overflow-hidden rounded-lg border border-border bg-surface">
      <figcaption className="flex h-9 items-center justify-between gap-3 border-b border-border pr-1 pl-4">
        <span className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          {label}
        </span>
        <span className="flex items-center gap-1">
          {renderedUrl === undefined ? null : (
            <a
              href={renderedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-mono text-2xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              Rendered on GitHub
              <ArrowUpRight className="size-3" strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          <CopyButton text={code} label={`${label} to the clipboard`} />
        </span>
      </figcaption>
      <pre
        tabIndex={0}
        className="overflow-x-auto p-4 font-mono text-xs leading-[1.7] text-text [tab-size:2]"
      >
        <code>
          {tokens.map((token, index) =>
            token.kind === null ? (
              token.text
            ) : (
              <span key={index} className={CODE_TOKEN_CLASSES[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}
