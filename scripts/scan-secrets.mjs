#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW_PRAGMA = /secret-scan:\s*allow\s+([a-z0-9-]+(?:[\s,]+[a-z0-9-]+)*)/;
const MAX_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8000;
const MIN_GENERIC_LENGTH = 16;
const MIN_GENERIC_ENTROPY = 3.5;

const KEY_PREFIX_BOUNDARY = "(?<![A-Za-z0-9])";

const TOKEN_RULES = [
  {
    rule: "anthropic",
    pattern: new RegExp(`${KEY_PREFIX_BOUNDARY}sk-ant-[A-Za-z0-9_-]{20,}`, "g"),
  },
  {
    rule: "sk-key",
    pattern: new RegExp(`${KEY_PREFIX_BOUNDARY}sk-(?!ant-)[A-Za-z0-9_-]{20,}`, "g"),
  },
  { rule: "cerebras", pattern: new RegExp(`${KEY_PREFIX_BOUNDARY}csk-[A-Za-z0-9_-]{20,}`, "g") },
  { rule: "groq", pattern: new RegExp(`${KEY_PREFIX_BOUNDARY}gsk_[A-Za-z0-9]{20,}`, "g") },
  { rule: "nvidia", pattern: new RegExp(`${KEY_PREFIX_BOUNDARY}nvapi-[A-Za-z0-9_-]{20,}`, "g") },
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { rule: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
];

const ASSIGNMENT =
  /(?<![\w$.-])(["']?)([A-Za-z_$][\w$.-]*)\1\s*(?::=|[:=])\s*(["'`]?)([A-Za-z0-9+/_=.~!#%^&*-]+)/g;
const SECRET_NAME_WORDS = new Set([
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "credential",
  "credentials",
]);
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
const MEMBER_ACCESS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
]);

const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@'"`]+):([^\s/@'"`]*)@/gi;
const URL_PASSWORD_PLACEHOLDER =
  /^(?:\*+|x+|\.{3}|pass|password|passwd|pwd|secret|changeme|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\[[^\]]*\]|\{[^}]*\})$/i;

export const RULE_IDS = new Set([
  ...TOKEN_RULES.map(({ rule }) => rule),
  "generic-assignment",
  "url-credentials",
]);

const FORBIDDEN_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const FORBIDDEN_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function isForbiddenPath(filePath) {
  const base = path.posix.basename(filePath.replaceAll("\\", "/"));
  if (base === ".env.example") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  return FORBIDDEN_EXTENSIONS.has(path.posix.extname(base));
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikeSecretValue(value) {
  return (
    value.length >= MIN_GENERIC_LENGTH &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value) &&
    shannonEntropy(value) >= MIN_GENERIC_ENTROPY
  );
}

function nameWords(name) {
  return name
    .split(/[_.$-]+/)
    .flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [])
    .map((word) => word.toLowerCase());
}

function isSecretName(name) {
  const words = nameWords(name);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (SECRET_NAME_WORDS.has(last)) return true;
  return last === "key" && words.length >= 2;
}

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.posix.extname(filePath.replaceAll("\\", "/")));
}

function isReferenceNotLiteral(value, quote, filePath) {
  if (ENV_VAR_NAME.test(value)) return true;
  return quote === "" && isCodeFile(filePath) && MEMBER_ACCESS.test(value);
}

function allowedRules(lineText) {
  const match = ALLOW_PRAGMA.exec(lineText);
  if (match === null) return new Set();
  return new Set((match[1] ?? "").split(/[\s,]+/).filter((id) => RULE_IDS.has(id)));
}

function redact(value) {
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

export function scanText(text, filePath) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    const allowed = allowedRules(lineText);
    const seen = new Set();
    const report = (rule, value) => {
      if (allowed.has(rule)) return;
      const key = `${rule}:${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ file: filePath, line: index + 1, rule, preview: redact(value) });
    };
    for (const { rule, pattern } of TOKEN_RULES) {
      for (const match of lineText.matchAll(pattern)) {
        const value = match[0];
        if (rule !== "private-key" && !/[0-9]/.test(value)) continue;
        report(rule, value);
      }
    }
    for (const match of lineText.matchAll(ASSIGNMENT)) {
      const name = match[2] ?? "";
      const quote = match[3] ?? "";
      const value = match[4] ?? "";
      if (!isSecretName(name) || isReferenceNotLiteral(value, quote, filePath)) continue;
      if (looksLikeSecretValue(value)) report("generic-assignment", value);
    }
    for (const match of lineText.matchAll(URL_CREDENTIALS)) {
      const password = match[2] ?? "";
      if (password === "" || URL_PASSWORD_PLACEHOLDER.test(password)) continue;
      report("url-credentials", password);
    }
  });
  return findings;
}

function utf16ByteOrder(content) {
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) return "le-bom";
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) return "be-bom";
  const sample = content.subarray(0, SNIFF_BYTES);
  const pairs = Math.floor(sample.length / 2);
  if (pairs === 0) return null;
  let evenNuls = 0;
  let oddNuls = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i] === 0) evenNuls += 1;
    if (sample[i + 1] === 0) oddNuls += 1;
  }
  if (oddNuls / pairs >= 0.4 && evenNuls / pairs <= 0.05) return "le";
  if (evenNuls / pairs >= 0.4 && oddNuls / pairs <= 0.05) return "be";
  return null;
}

export function decodeText(content) {
  const order = utf16ByteOrder(content);
  if (order === null) {
    return content.subarray(0, SNIFF_BYTES).includes(0) ? null : content.toString("utf8");
  }
  const start = order.endsWith("bom") ? 2 : 0;
  const body = Buffer.from(content.subarray(start, start + ((content.length - start) & ~1)));
  if (order.startsWith("be")) body.swap16();
  return body.toString("utf16le");
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

export function listFiles(mode, cwd = process.cwd()) {
  const output =
    mode === "staged"
      ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], cwd)
      : git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))];
}

function readContent(filePath, mode, cwd) {
  if (mode === "staged") return git(["show", `:${filePath}`], cwd);
  const absolute = path.resolve(cwd, filePath);
  if (mode === "all" && !existsSync(absolute)) return null;
  return readFileSync(absolute);
}

export function scanFiles(files, mode, cwd = process.cwd()) {
  const findings = [];
  for (const file of files) {
    if (isForbiddenPath(file)) {
      findings.push({
        file,
        line: 0,
        rule: "forbidden-file",
        preview: "file type must never be committed",
      });
      continue;
    }
    const content = readContent(file, mode, cwd);
    if (content === null) continue;
    const text = decodeText(content);
    if (text === null) continue;
    if (content.length > MAX_BYTES) {
      findings.push({
        file,
        line: 0,
        rule: "oversized-file",
        preview: `text file over ${MAX_BYTES} bytes cannot be scanned; split it or keep it out of git`,
      });
      continue;
    }
    findings.push(...scanText(text, file));
  }
  return findings;
}

function main(argv) {
  const mode = argv.includes("--staged") ? "staged" : argv.includes("--all") ? "all" : "paths";
  const files = mode === "paths" ? argv.filter((arg) => !arg.startsWith("--")) : listFiles(mode);
  const findings = scanFiles(files, mode);
  if (findings.length === 0) {
    console.log(`secret-scan: ${files.length} file(s) clean`);
    return 0;
  }
  console.error(`secret-scan: ${findings.length} possible secret(s) found:`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]  ${finding.preview}`);
  }
  console.error(
    'Remove the secret (use env vars; see .env.example). For a verified false positive, add "secret-scan: allow <rule-id>" on that line, naming the rule shown in brackets.',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
