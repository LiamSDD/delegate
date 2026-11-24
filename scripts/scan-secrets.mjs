#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW_PRAGMA = "secret-scan: allow";
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_GENERIC_LENGTH = 16;
const MIN_GENERIC_ENTROPY = 3.5;

const TOKEN_RULES = [
  { rule: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: "sk-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { rule: "groq", pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
  { rule: "nvidia", pattern: /\bnvapi-[A-Za-z0-9_-]{20,}/g },
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { rule: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { rule: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
];

const GENERIC_ASSIGNMENT =
  /\b[A-Za-z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD)\b["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=-]+)/gi;

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

function redact(value) {
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

export function scanText(text, filePath) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    if (lineText.includes(ALLOW_PRAGMA)) return;
    const seen = new Set();
    const report = (rule, value) => {
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
    for (const match of lineText.matchAll(GENERIC_ASSIGNMENT)) {
      const value = match[1] ?? "";
      if (looksLikeSecretValue(value)) report("generic-assignment", value);
    }
  });
  return findings;
}

function git(args) {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(mode) {
  const output =
    mode === "staged"
      ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
      : git(["ls-files", "-z"]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

function readContent(filePath, mode) {
  return mode === "staged" ? git(["show", `:${filePath}`]) : readFileSync(filePath);
}

export function scanFiles(files, mode) {
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
    const content = readContent(file, mode);
    if (content.length > MAX_BYTES || content.includes(0)) continue;
    findings.push(...scanText(content.toString("utf8"), file));
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
    `Remove the secret (use env vars; see .env.example). For a verified false positive, add "${ALLOW_PRAGMA}" on that line.`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
