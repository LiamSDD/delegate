import { JS_EXTENSIONS, PY_EXTENSIONS } from "./imports";
import { type Dependency } from "./manifests";
import { baseName, extensionOf, fileLines, type RepoFile } from "./snapshot";

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  pyi: "Python",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  ex: "Elixir",
  exs: "Elixir",
  sh: "Shell",
  bash: "Shell",
  lua: "Lua",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  sql: "SQL",
  md: "Markdown",
  mdx: "Markdown",
  rst: "reStructuredText",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  json: "JSON",
};

const PROSE_OR_DATA = new Set(["Markdown", "reStructuredText", "YAML", "TOML", "JSON"]);

export function languageOf(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

export function isCodeFile(path: string): boolean {
  const language = languageOf(path);
  return (
    language !== null && !PROSE_OR_DATA.has(language) && language !== "HTML" && language !== "CSS"
  );
}

const TEST_DIRECTORY = /(^|\/)(tests?|__tests__|specs?|testing|e2e|test-d)\//;
const TEST_FILE =
  /(\.(test|spec|test-d)\.[cm]?[jt]sx?$)|(^test_.*\.py$)|(_test\.py$)|(_test\.go$)|(Test\.(java|kt)$)|(_spec\.rb$)|(\.test\.py$)/;

export function isTestFile(path: string): boolean {
  return isCodeFile(path) && (TEST_FILE.test(baseName(path)) || TEST_DIRECTORY.test(path));
}

export interface PatternHit {
  kind: RiskyKind;
  path: string;
  line: number;
}

export const RISKY_KINDS = [
  "eval",
  "dynamic-function",
  "shell-exec",
  "sql-string-building",
  "unsafe-deserialisation",
  "html-injection",
] as const;
export type RiskyKind = (typeof RISKY_KINDS)[number];

const RISKY_PATTERNS: readonly {
  kind: RiskyKind;
  languages: "js" | "py" | "any";
  pattern: RegExp;
}[] = [
  { kind: "eval", languages: "any", pattern: /(?<![\w.$])eval\s*\(/ },
  { kind: "dynamic-function", languages: "js", pattern: /\bnew\s+Function\s*\(/ },
  {
    kind: "shell-exec",
    languages: "js",
    pattern:
      /\b(?:child_process\.)?exec(?:Sync)?\s*\(\s*[`"'][^`"']*\$\{|\bexec(?:Sync)?\s*\([^)]*\+/,
  },
  {
    kind: "shell-exec",
    languages: "py",
    pattern: /\bos\.system\s*\(|\bsubprocess\.\w+\([^)]*shell\s*=\s*True|(?<![\w.])exec\s*\(/,
  },
  {
    kind: "sql-string-building",
    languages: "any",
    pattern:
      /["'`](?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'`]*(?:["'`]\s*\+|\$\{)|\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"']*["']\s*(?:%|\.format\()|\bf["'](?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{/,
  },
  {
    kind: "unsafe-deserialisation",
    languages: "py",
    pattern: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader)/,
  },
  {
    kind: "html-injection",
    languages: "js",
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=(?!=)/,
  },
];

const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/;
const TODO = /\b(TODO|FIXME|HACK|XXX)\b/;

export function scanRiskyPatterns(file: RepoFile): PatternHit[] {
  const extension = extensionOf(file.path);
  const family = JS_EXTENSIONS.has(extension) ? "js" : PY_EXTENSIONS.has(extension) ? "py" : null;
  if (family === null || isTestFile(file.path)) return [];
  const hits: PatternHit[] = [];
  fileLines(file).forEach((raw, index) => {
    if (COMMENT_LINE.test(raw) || raw.length > 400) return;
    for (const rule of RISKY_PATTERNS) {
      if (rule.languages !== "any" && rule.languages !== family) continue;
      if (rule.pattern.test(raw)) {
        hits.push({ kind: rule.kind, path: file.path, line: index + 1 });
        break;
      }
    }
  });
  return hits;
}

export interface TodoHit {
  marker: "TODO" | "FIXME" | "HACK" | "XXX";
  path: string;
  line: number;
}

export function scanTodos(file: RepoFile): TodoHit[] {
  if (!isCodeFile(file.path)) return [];
  const hits: TodoHit[] = [];
  fileLines(file).forEach((raw, index) => {
    if (!COMMENT_LINE.test(raw) && !/(\/\/|#|\/\*)/.test(raw)) return;
    const match = TODO.exec(raw);
    if (match !== null)
      hits.push({ marker: match[1] as TodoHit["marker"], path: file.path, line: index + 1 });
  });
  return hits;
}

export interface FrameworkSignal {
  name: string;
  path: string;
  line: number;
}

const NPM_TEST_FRAMEWORKS: Record<string, string> = {
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  ava: "AVA",
  tap: "node-tap",
  tape: "tape",
  jasmine: "Jasmine",
  uvu: "uvu",
  "@playwright/test": "Playwright",
  cypress: "Cypress",
};
const PYPI_TEST_FRAMEWORKS: Record<string, string> = {
  pytest: "pytest",
  nose: "nose",
  nose2: "nose2",
  hypothesis: "Hypothesis",
  tox: "tox",
  nox: "nox",
};

export function frameworkSignals(
  dependencies: readonly Dependency[],
  testFiles: readonly RepoFile[],
): FrameworkSignal[] {
  const found = new Map<string, FrameworkSignal>();
  for (const dependency of dependencies) {
    const name =
      dependency.ecosystem === "npm"
        ? NPM_TEST_FRAMEWORKS[dependency.name]
        : dependency.ecosystem === "pypi"
          ? PYPI_TEST_FRAMEWORKS[dependency.name.toLowerCase()]
          : undefined;
    if (name !== undefined && !found.has(name))
      found.set(name, { name, path: dependency.manifest, line: dependency.line });
  }
  const fileRules: readonly {
    name: string;
    extension: (ext: string) => boolean;
    pattern: RegExp;
  }[] = [
    {
      name: "node:test",
      extension: (ext) => JS_EXTENSIONS.has(ext),
      pattern: /from\s+["']node:test["']|require\(["']node:test["']\)/,
    },
    {
      name: "unittest",
      extension: (ext) => ext === "py",
      pattern: /^\s*import\s+unittest\b|^\s*from\s+unittest\s+import/,
    },
    {
      name: "pytest",
      extension: (ext) => ext === "py",
      pattern: /^\s*import\s+pytest\b|^\s*from\s+pytest\b/,
    },
    {
      name: "go test",
      extension: (ext) => ext === "go",
      pattern: /^\s*"testing"\s*$|^import\s+"testing"/,
    },
    { name: "cargo test", extension: (ext) => ext === "rs", pattern: /#\[(tokio::)?test\]/ },
  ];
  for (const file of testFiles) {
    const extension = extensionOf(file.path);
    for (const rule of fileRules) {
      if (found.has(rule.name) || !rule.extension(extension)) continue;
      const lines = fileLines(file);
      const index = lines.findIndex((line) => rule.pattern.test(line));
      if (index !== -1) found.set(rule.name, { name: rule.name, path: file.path, line: index + 1 });
    }
  }
  return [...found.values()];
}

export interface CiConfig {
  provider: string;
  path: string;
  testLine: number | null;
}

export function detectCi(file: RepoFile): CiConfig | null {
  const path = file.path;
  const provider = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
    ? "GitHub Actions"
    : path === ".gitlab-ci.yml"
      ? "GitLab CI"
      : /^\.circleci\/config\.ya?ml$/.test(path)
        ? "CircleCI"
        : path === ".travis.yml"
          ? "Travis CI"
          : path === "azure-pipelines.yml"
            ? "Azure Pipelines"
            : path === "Jenkinsfile"
              ? "Jenkins"
              : path === "bitbucket-pipelines.yml"
                ? "Bitbucket Pipelines"
                : /^\.buildkite\/.+\.ya?ml$/.test(path)
                  ? "Buildkite"
                  : null;
  if (provider === null) return null;
  const index = fileLines(file).findIndex((line) =>
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\btox\b|\bnox\b|\bgo test\b|\bcargo test\b|\bmake test\b|\brake\b|\b(npx|pnpm exec|yarn) (vitest|jest|ava|mocha|playwright test)\b|\bnode --test\b/.test(
      line,
    ),
  );
  return { provider, path, testLine: index === -1 ? null : index + 1 };
}
