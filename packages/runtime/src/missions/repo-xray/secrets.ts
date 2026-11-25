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
}

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

export function redactLine(line: string): { text: string; kinds: SecretKind[] } {
  const kinds: SecretKind[] = [];
  let text = line;
  for (const { kind, pattern } of TOKEN_PATTERNS) {
    text = text.replace(pattern, () => {
      kinds.push(kind);
      return REDACTED;
    });
  }
  text = text.replace(ASSIGNMENT, (match: string, _name: string, value: string) => {
    if (!looksSecret(value)) return match;
    kinds.push("generic-assignment");
    return match.replace(value, REDACTED);
  });
  return { text, kinds };
}

export function redactSecrets(text: string): { text: string; hits: SecretHit[] } {
  const hits: SecretHit[] = [];
  const lines = text.split("\n").map((line, index) => {
    const redacted = redactLine(line);
    for (const kind of redacted.kinds) hits.push({ kind, line: index + 1 });
    return redacted.text;
  });
  return { text: lines.join("\n"), hits };
}
