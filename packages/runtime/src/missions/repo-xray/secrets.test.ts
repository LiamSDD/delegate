import { describe, expect, it } from "vitest";

import { assessSecret, isFixturePath, isPlaceholderValue, redactSecrets } from "./secrets";

const FIXTURE_TOKEN = ["refreshed", "token", "123"].join("-");
const AWS_KEY = ["AKIA", "Q7ZBXH2M4KTN6WRE"].join("");
const GITHUB_TOKEN = ["ghp", "_", "Zx81Qm4TfR0bWc6NpL2yKd9HvA3sJ7uE5gYo"].join("");

describe("isPlaceholderValue", () => {
  it.each([
    "refreshed-token-123",
    "supersecretpassword123",
    "test-api-key-0001",
    "fake_secret_value_42",
    "dummyAccessToken2024",
    "example-client-secret",
    "changeme-changeme-1",
    "sample.session.token.9",
    "correct-horse-battery-staple-42",
  ])("treats %s as a placeholder", (value) => {
    expect(isPlaceholderValue(value)).toBe(true);
  });

  it.each([
    "aB3dE5gH7jK9mN1pQ2rS",
    "hJkLmNpQrStVwXyZ12",
    "9f8Kq2LmZx7Rw4Tb1Vn6",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzQ9a8b7c6d",
  ])("treats %s as random enough to be real", (value) => {
    expect(isPlaceholderValue(value)).toBe(false);
  });

  it("treats a provider-format token with placeholder text or low entropy as a placeholder", () => {
    expect(isPlaceholderValue(["AKIA", "IOSFODNN7EXAMPLE"].join(""))).toBe(true);
    expect(isPlaceholderValue(["ghp", "_", "x".repeat(36)].join(""))).toBe(true);
    expect(isPlaceholderValue(AWS_KEY)).toBe(false);
    expect(isPlaceholderValue(GITHUB_TOKEN)).toBe(false);
  });
});

describe("isFixturePath", () => {
  it.each([
    "test/hooks.ts",
    "tests/test_client.py",
    "src/__tests__/auth.ts",
    "spec/models/user_spec.rb",
    "packages/api/fixtures/tokens.json",
    "src/__mocks__/client.ts",
    "examples/basic/index.js",
    "config/settings.example.json",
    ".env.example",
    "src/auth.test.ts",
    "pkg/client_test.go",
    "testdata/keys.txt",
    "src/test/java/AuthTest.java",
  ])("treats %s as a fixture path", (path) => {
    expect(isFixturePath(path)).toBe(true);
  });

  it.each([
    "src/config.ts",
    "source/core/Ky.ts",
    "lib/latest.ts",
    "app/contest/entry.py",
    "server/attestation.go",
  ])("treats %s as a production path", (path) => {
    expect(isFixturePath(path)).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("counts lines within the one file it is given", () => {
    const filler = Array.from({ length: 4060 }, (_, index) => `const line${index} = ${index};`);
    const text = [
      ...filler,
      `      response.json({error: {code: 'TOKEN_REFRESH', newToken: '${FIXTURE_TOKEN}'}});`,
      "",
    ].join("\n");
    const { hits, text: redacted } = redactSecrets(text);
    expect(hits).toEqual([{ kind: "generic-assignment", line: 4061, placeholder: true }]);
    expect(redacted.split("\n")[4060]).toContain("[redacted:secret]");
    expect(redacted).not.toContain(FIXTURE_TOKEN);
  });

  it("reports a real-looking provider token as no placeholder, on its own line", () => {
    const { hits } = redactSecrets(
      `const region = "eu";\r\nconst awsKey = "${AWS_KEY}";\r\nconst gh = "${GITHUB_TOKEN}";\n`,
    );
    expect(hits).toEqual([
      { kind: "aws-access-key", line: 2, placeholder: false },
      { kind: "github-token", line: 3, placeholder: false },
    ]);
  });
});

describe("assessSecret", () => {
  it("keeps a real-looking token in a production path at high confidence", () => {
    expect(assessSecret("src/config.ts", { placeholder: false })).toEqual({ confidence: "high" });
  });

  it("marks fixture paths and placeholder values as low confidence, with the reason", () => {
    expect(assessSecret("test/hooks.ts", { placeholder: false })).toEqual({
      confidence: "low",
      reason: "fixture-path",
    });
    expect(assessSecret("src/config.ts", { placeholder: true })).toEqual({
      confidence: "low",
      reason: "placeholder-value",
    });
  });
});
