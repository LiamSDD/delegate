import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isForbiddenPath, listFiles, scanFiles, scanText } from "./scan-secrets.mjs";

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
  ["cerebras key", fake("csk", "-", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae"), "cerebras"],
  [
    "sk- key after punctuation",
    fake('key:"', "sk-", "Q7m2Lp9Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae", '"'),
    "sk-key",
  ],
  [
    "camelCase apiKey in code",
    fake('const apiKey = "', "Uq3Rk8Zt1Mx6Vb9Lw2Pn5Hc7Jd0Gf4Ys", '";'),
    "generic-assignment",
  ],
  [
    "JSON clientSecret",
    fake('{ "clientSecret": "', "q8Zr4Lm1Tx7Wv2Nb9Ky3Pc6Hd0Gf5Js", '" }'),
    "generic-assignment",
  ],
  [
    "camelCase accessToken in object",
    fake("accessToken: '", "Lw2Pn5Hc7Jd0Gf4YsUq3Rk8Zt1Mx6Vb9", "',"),
    "generic-assignment",
  ],
  [
    "password containing dots",
    fake('dbPassword = "', "hT7.q2Zr.9LmX.4wKp.8Nv3", '"'),
    "generic-assignment",
  ],
  [
    "bare lower-case token in env file",
    fake("token=", "Kq81.zR4mW9.tY2pL6.xN0v"),
    "generic-assignment",
    "deploy/app.env.sample",
  ],
  [
    "postgres URL with a password",
    fake("DATABASE_URL=postgres://app_user:", "Q7m2Lp9Rt4Vw", "@db.example.com/delegate"),
    "url-credentials",
  ],
  [
    "https URL with short userinfo password",
    fake("https://deploy:", "hunter2", "@git.example.com/repo.git"),
    "url-credentials",
  ],
  [
    "JSON web token",
    fake(
      "eyJhbGciOiJIUzI1NiJ9",
      ".",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      ".",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
    "jwt",
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
  [
    "allow pragma naming the rule",
    fake("AKIA", "Q7M2LP9RT4VW8YB1", " // secret-scan: allow aws-access-key-id"),
  ],
  [
    "allow pragma naming several rules",
    fake(
      "AKIA",
      "Q7M2LP9RT4VW8YB1 ",
      "gsk",
      "_Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3K",
      " # secret-scan: allow aws-access-key-id, groq",
    ),
  ],
  ["env var name in models.json", '      "apiKeyEnv": "CLOUDFLARE_API_TOKEN",'],
  ["required env names", '      "requiredEnv": ["CLOUDFLARE_ACCOUNT_ID"],'],
  [
    "OTel attribute name",
    '  usageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",',
  ],
  ["OTel constant name", '  requestMaxTokens: "ATTR_GEN_AI_REQUEST_MAX_TOKENS",'],
  ["token count", "const maxTokens = 4096;"],
  ["dotted env reference in code", "const token = process.env.R2_ACCESS_TOKEN_V2;"],
  ["member access in code", "const apiKey = config.providers.anthropic2.apiKeyEnv;"],
  ["react key prop", "<li key={provider.id}>"],
  ["scan pragma prose", "secret-scan: allow-list per rule"],
  ["URL placeholder password", "postgres://user:password@localhost:5432/delegate"],
  ["URL env placeholder", "postgres://${PGUSER}:${PGPASSWORD}@localhost/delegate"],
  ["URL angle placeholder", "postgres://app:<password>@host/db"],
  ["URL without password", "https://git@github.com/org/repo.git"],
  ["URL with port only", "http://localhost:11434/v1"],
  ["css custom property", "--font-sans: var(--font-instrument-sans);"],
];

describe("scanText", () => {
  it.each(positives)("flags %s", (_label, text, rule, file = "src/config.ts") => {
    const findings = scanText(text, file);
    expect(findings.map((finding) => finding.rule)).toContain(rule);
  });

  it.each(negatives)("does not flag %s", (_label, text) => {
    expect(scanText(text, "src/config.ts")).toEqual([]);
  });

  it("ignores a blanket pragma without a rule id", () => {
    const text = fake("AKIA", "Q7M2LP9RT4VW8YB1", " // secret-scan: allow");
    expect(scanText(text, "a.ts").map((finding) => finding.rule)).toEqual(["aws-access-key-id"]);
  });

  it("only suppresses the rules the pragma names", () => {
    const text = fake("AKIA", "Q7M2LP9RT4VW8YB1", " // secret-scan: allow groq");
    expect(scanText(text, "a.ts").map((finding) => finding.rule)).toEqual(["aws-access-key-id"]);
  });

  it.each(["config/models.json", "packages/runtime/src/telemetry.ts"])(
    "does not flag the repository file %s",
    (file) => {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(scanText(text, file)).toEqual([]);
    },
  );

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

describe("scanFiles", () => {
  let dir = "";
  const secret = fake("gsk", "_", "Zx9Qm2Lp7Rt4Vw8Yb1Nc6Hd3Kf5Gj0Ae");

  function write(name, content) {
    dir ||= mkdtempSync(path.join(tmpdir(), "scan-secrets-"));
    writeFileSync(path.join(dir, name), content);
    return name;
  }

  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("fails an oversized text file instead of skipping it", () => {
    const file = write("big.txt", "a".repeat(2 * 1024 * 1024 + 1));
    expect(scanFiles([file], "paths", dir).map((finding) => finding.rule)).toEqual([
      "oversized-file",
    ]);
  });

  it("skips binary files", () => {
    const file = write("blob.bin", Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01, 0xff, 0x00, 0x7f]));
    expect(scanFiles([file], "paths", dir)).toEqual([]);
  });

  it("skips oversized binary files", () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    big[0] = 0x89;
    const file = write("big.bin", big);
    expect(scanFiles([file], "paths", dir)).toEqual([]);
  });

  it.each([
    [
      "UTF-16LE with BOM",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`GROQ=${secret}\n`, "utf16le")]),
    ],
    ["UTF-16LE without BOM", Buffer.from(`GROQ=${secret}\n`, "utf16le")],
    [
      "UTF-16BE with BOM",
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(`GROQ=${secret}\n`, "utf16le").swap16(),
      ]),
    ],
  ])("decodes %s text", (_label, content) => {
    const file = write("utf16.txt", content);
    expect(scanFiles([file], "paths", dir).map((finding) => finding.rule)).toContain("groq");
  });

  it("still blocks forbidden file names", () => {
    const file = write(".env", "A=b\n");
    expect(scanFiles([file], "paths", dir).map((finding) => finding.rule)).toEqual([
      "forbidden-file",
    ]);
  });
});

describe("listFiles", () => {
  it("--all covers tracked and untracked files but not ignored ones", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "scan-secrets-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
      writeFileSync(path.join(repo, "tracked.txt"), "t\n");
      writeFileSync(path.join(repo, "untracked.txt"), "u\n");
      writeFileSync(path.join(repo, "ignored.txt"), "i\n");
      execFileSync("git", ["add", "tracked.txt", ".gitignore"], { cwd: repo });
      expect(listFiles("all", repo).sort()).toEqual([".gitignore", "tracked.txt", "untracked.txt"]);
      expect(listFiles("staged", repo).sort()).toEqual([".gitignore", "tracked.txt"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
