import { describe, expect, it } from "vitest";

import { isForbiddenPath, scanText } from "./scan-secrets.mjs";

const fake = (...parts) => parts.join("");

const positives = [
  ["anthropic key", fake("sk-", "ant-", "api03-", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae"), "anthropic"],
  ["openai-style key", fake("sk-", "proj-", "Q7m2Lp9Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae"), "sk-key"],
  ["openrouter key", fake("sk-", "or-v1-", "a8f3c1e9b2d47a6c5e0f9b8d7c6a5e4f"), "sk-key"],
  ["groq key", fake("gsk", "_", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae"), "groq"],
  ["nvidia key", fake("nvapi", "-", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae"), "nvidia"],
  ["aws access key id", fake("AKIA", "Q7M2LP9RT4VW8YB1"), "aws-access-key-id"],
  [
    "github classic token",
    fake("ghp", "_", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae1234"),
    "github-token",
  ],
  [
    "github fine-grained token",
    fake("github_pat", "_", "11ABCDEFG0Zx9Qm2Lp7Rt4_Vw8Yb1Nc6Hd3Kf5Gj0Ae"),
    "github-token",
  ],
  ["private key block", fake("-----BEGIN ", "RSA PRIVATE KEY", "-----"), "private-key"],
  ["openssh private key block", fake("-----BEGIN ", "OPENSSH PRIVATE KEY", "-----"), "private-key"],
  [
    "generic secret assignment",
    fake("DELEGATE_SESSION_SECRET", "=", "q8Zr4Lm1Tx7Wv2Nb9Ky3Pc6Hd0Gf5Js"),
    "generic-assignment",
  ],
  [
    "generic quoted token in code",
    fake('const CLOUDFLARE_API_TOKEN = "', "Uq3Rk8Zt1Mx6Vb9Lw2Pn5Hc7Jd0Gf4Ys", '";'),
    "generic-assignment",
  ],
  [
    "generic key in yaml",
    fake("my_service_key: ", "a9F2kL7qZ3xP8mW1rT6vB4nC0hJ5sD"),
    "generic-assignment",
  ],
];

const negatives = [
  ["env example names-only line", "GROQ_API_KEY="],
  [
    "env example with comment",
    "# Optional: Groq free-tier key (gpt-oss-120b, qwen).\nGROQ_API_KEY=",
  ],
  ["reading the key from env", 'const key = process.env["ANTHROPIC_API_KEY"];'],
  ["dotted env access", "const token = process.env.CLOUDFLARE_API_TOKEN;"],
  ["placeholder value", "OPENROUTER_API_KEY=your-openrouter-key-here"],
  ["template placeholder", "NVIDIA_API_KEY=${NVIDIA_API_KEY}"],
  ["angle placeholder", "ANTHROPIC_API_KEY=<paste-your-key>"],
  ["low entropy value", "DELEGATE_SESSION_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["prose mentioning prefixes", "Groq keys start with gsk_ and NVIDIA keys with nvapi-."],
  ["short sk- word", "the task-sk-ip flag"],
  ["key name in docs", "Set `CEREBRAS_API_KEY` in your .env to enable Cerebras."],
  ["explicit allow pragma", fake("AKIA", "Q7M2LP9RT4VW8YB1", " // secret-scan: allow")],
  ["css custom property", "--font-sans: var(--font-instrument-sans);"],
];

describe("scanText", () => {
  it.each(positives)("flags %s", (_label, text, rule) => {
    const findings = scanText(text, "src/config.ts");
    expect(findings.map((finding) => finding.rule)).toContain(rule);
  });

  it.each(negatives)("does not flag %s", (_label, text) => {
    expect(scanText(text, "src/config.ts")).toEqual([]);
  });

  it("does not flag the repository .env.example", async () => {
    const { readFile } = await import("node:fs/promises");
    const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
    expect(scanText(envExample, ".env.example")).toEqual([]);
  });

  it("reports the line number and never echoes the full secret", () => {
    const secret = fake("gsk", "_", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae");
    const [finding] = scanText(`first line\nGROQ=${secret}\n`, "a.txt");
    expect(finding?.line).toBe(2);
    expect(finding?.preview).not.toContain(secret);
  });
});

describe("isForbiddenPath", () => {
  it.each([
    ".env",
    ".env.local",
    "apps/web/.env.production",
    "deploy/id_rsa",
    "certs/server.pem",
    "keys/signing.key",
  ])("blocks %s", (path) => {
    expect(isForbiddenPath(path)).toBe(true);
  });

  it.each([
    ".env.example",
    "apps/web/.env.example",
    "src/env.ts",
    "docs/SECURITY.md",
    "src/keyboard.tsx",
  ])("allows %s", (path) => {
    expect(isForbiddenPath(path)).toBe(false);
  });
});
