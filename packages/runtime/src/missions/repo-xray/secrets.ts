export type SecretKind =
  | "aws-access-key"
  | "private-key"
  | "github-token"
  | "slack-token"
  | "stripe-key"
  | "google-api-key"
  | "jwt"
  | "generic-assignment";

export interface SecretHit {
  kind: SecretKind;
  line: number;
  placeholder: boolean;
}

export type SecretConfidence = "high" | "low";
export type LowConfidenceReason = "fixture-path" | "placeholder-value";
export type SecretAssessment =
  { confidence: "high" } | { confidence: "low"; reason: LowConfidenceReason };

const TOKEN_PATTERNS: readonly { kind: SecretKind; pattern: RegExp }[] = [
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe-key", pattern: /\b[rs]k_live_[A-Za-z0-9]{16,}/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

const ASSIGNMENT =
  /\b([\w-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_=.~!#%^&*-]{16,})["'`]/gi;
const PLACEHOLDER = /^(?:x+|\*+|changeme|example|placeholder|your[_-].*|test.*|dummy.*|<.*>)$/i;
const REDACTED = "[redacted:secret]";

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksSecret(value: string): boolean {
  return !PLACEHOLDER.test(value) && entropy(value) >= 3.5 && /\d/.test(value);
}

const PLACEHOLDER_WORDS =
  /test|fake|dummy|example|sample|changeme|placeholder|mock|stub|fixture|refresh|demo|redacted|lorem|invalid|expired|secret|passw|token|x{4}|0{6}/i;
const PROVIDER_PLACEHOLDER_WORDS = /example|test|fake|dummy|sample|placeholder|x{4}|0{6}/i;
const PROVIDER_PLACEHOLDER_ENTROPY = 3;
const VOWELS = /[aeiouy]/gi;

function pronounceable(word: string): boolean {
  if (word.length < 2) return false;
  const vowels = word.match(VOWELS)?.length ?? 0;
  const longestConsonantRun = Math.max(
    0,
    ...(word.match(/[^aeiouy]+/gi) ?? []).map((run) => run.length),
  );
  return vowels / word.length >= 0.25 && longestConsonantRun <= 3;
}

function wordsPlusDigits(value: string): boolean {
  const pieces = value.replace(/([a-z])([A-Z])/g, "$1 $2").match(/[A-Za-z]+|\d+/g) ?? [];
  const words = pieces.filter((piece) => /^[A-Za-z]/.test(piece));
  const numbers = pieces.filter((piece) => /^\d/.test(piece));
  return (
    words.length > 0 &&
    words.every(pronounceable) &&
    numbers.length <= 2 &&
    numbers.every((number) => number.length <= 6)
  );
}

function isProviderFormat(value: string): boolean {
  return TOKEN_PATTERNS.some(({ pattern }) => new RegExp(pattern.source).test(value));
}

export function isPlaceholderValue(value: string): boolean {
  if (isProviderFormat(value))
    return PROVIDER_PLACEHOLDER_WORDS.test(value) || entropy(value) < PROVIDER_PLACEHOLDER_ENTROPY;
  return PLACEHOLDER.test(value) || PLACEHOLDER_WORDS.test(value) || wordsPlusDigits(value);
}

const FIXTURE_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "testing",
  "e2e",
  "test-d",
  "testdata",
  "test-data",
  "fixture",
  "fixtures",
  "__fixtures__",
  "mock",
  "mocks",
  "__mocks__",
  "stub",
  "stubs",
  "example",
  "examples",
  "sample",
  "samples",
  "demo",
  "demos",
]);
const FIXTURE_FILE =
  /(^|[._-])(tests?|specs?|mocks?|fixtures?|examples?|samples?|stubs?|fakes?|dummy|demo)([._-]|$)/i;
const JVM_TEST_FILE = /[a-z0-9]Tests?\.(java|kt|scala|cs)$/;

export function isFixturePath(path: string): boolean {
  const segments = path.split("/");
  const base = segments.at(-1) ?? "";
  return (
    segments.slice(0, -1).some((segment) => FIXTURE_DIRECTORIES.has(segment.toLowerCase())) ||
    FIXTURE_FILE.test(base) ||
    JVM_TEST_FILE.test(base)
  );
}

export function assessSecret(path: string, hit: { placeholder: boolean }): SecretAssessment {
  if (isFixturePath(path)) return { confidence: "low", reason: "fixture-path" };
  if (hit.placeholder) return { confidence: "low", reason: "placeholder-value" };
  return { confidence: "high" };
}

export function redactLine(line: string): {
  text: string;
  hits: { kind: SecretKind; placeholder: boolean }[];
} {
  const hits: { kind: SecretKind; placeholder: boolean }[] = [];
  let text = line;
  for (const { kind, pattern } of TOKEN_PATTERNS) {
    text = text.replace(pattern, (value: string) => {
      hits.push({ kind, placeholder: isPlaceholderValue(value) });
      return REDACTED;
    });
  }
  text = text.replace(ASSIGNMENT, (match: string, _name: string, value: string) => {
    if (!looksSecret(value)) return match;
    hits.push({ kind: "generic-assignment", placeholder: isPlaceholderValue(value) });
    return match.replace(value, REDACTED);
  });
  return { text, hits };
}

export function redactSecrets(text: string): { text: string; hits: SecretHit[] } {
  const hits: SecretHit[] = [];
  const lines = text.split("\n").map((line, index) => {
    const redacted = redactLine(line);
    for (const hit of redacted.hits) hits.push({ ...hit, line: index + 1 });
    return redacted.text;
  });
  return { text: lines.join("\n"), hits };
}
