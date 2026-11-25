import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GitHubApiError,
  GitHubAppConfigError,
  createAppJwt,
  createGitHubAppClient,
  parseGitHubRepoUrl,
  readGitHubAppConfig,
  type GitHubAppConfig,
} from "./app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
const NOW = Date.parse("2026-11-25T10:00:00Z");
const TOKEN = ["ghs", "fakeinstallation1234567890"].join("_");
const sha = (char: string) => char.repeat(40);

function config(): GitHubAppConfig {
  const parsed = readGitHubAppConfig({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: pem });
  if (parsed === null) throw new Error("config expected");
  return parsed;
}

interface Recorded {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

function fakeGitHub(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const requests: Recorded[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {
    "GET /repos/acme/widgets/installation": { status: 200, body: { id: 99 } },
    "POST /app/installations/99/access_tokens": { status: 201, body: { token: TOKEN } },
    "GET /repos/acme/widgets": { status: 200, body: { default_branch: "main" } },
    [`GET /repos/acme/widgets/git/commits/${sha("b")}`]: {
      status: 200,
      body: { sha: sha("b"), tree: { sha: sha("c") } },
    },
    "POST /repos/acme/widgets/git/blobs": { status: 201, body: { sha: sha("d") } },
    "POST /repos/acme/widgets/git/trees": { status: 201, body: { sha: sha("e") } },
    "POST /repos/acme/widgets/git/commits": { status: 201, body: { sha: sha("f") } },
    "POST /repos/acme/widgets/git/refs": { status: 201, body: { ref: "refs/heads/x" } },
    "POST /repos/acme/widgets/pulls": {
      status: 201,
      body: { number: 12, html_url: "https://github.com/acme/widgets/pull/12" },
    },
    ...overrides,
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({
      method,
      path: url.pathname,
      authorization: headers.get("authorization") ?? "",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const route = routes[`${method} ${url.pathname}`] ?? {
      status: 404,
      body: { message: "Not Found" },
    };
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status }));
  };
  return { requests, fetchImpl };
}

describe("parseGitHubRepoUrl", () => {
  it("accepts https GitHub repository URLs only", () => {
    expect(parseGitHubRepoUrl("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(parseGitHubRepoUrl("https://github.com/acme/widgets.git/")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    for (const bad of [
      "http://github.com/acme/widgets",
      "https://gitlab.com/acme/widgets",
      "https://user:pass@github.com/acme/widgets",
      "https://github.com/acme",
      "https://github.com/acme/widgets/tree/main",
      "https://github.com/acme/..",
      "file:///tmp/repo",
    ])
      expect(parseGitHubRepoUrl(bad), bad).toBeNull();
  });
});

describe("GitHub App JWT", () => {
  it("signs an RS256 JWT that the public key verifies, backdated and short-lived", () => {
    const jwt = createAppJwt(config(), NOW);
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<
      string,
      number | string
    >;
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(Number(claims.exp) - NOW / 1000).toBeLessThanOrEqual(600);
  });

  it("reads a private key with literal \\n escapes and rejects a bad one without echoing it", () => {
    const escaped = pem.replace(/\n/g, "\\n");
    expect(
      readGitHubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: escaped }),
    ).not.toBeNull();
    expect(readGitHubAppConfig({})).toBeNull();
    let caught: unknown;
    try {
      readGitHubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not-a-key-secretvalue" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubAppConfigError);
    expect((caught as Error).message).not.toContain("secretvalue");
  });
});

describe("GitHub App client", () => {
  it("returns no session when the App is not installed on the repository", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/widgets/installation": { status: 404, body: { message: "Not Found" } },
    });
    const client = createGitHubAppClient({
      config: config(),
      fetch: github.fetchImpl,
      now: () => NOW,
    });
    expect(await client.sessionFor({ owner: "acme", name: "widgets" })).toBeNull();
    expect(github.requests.map((request) => request.path)).toEqual([
      "/repos/acme/widgets/installation",
    ]);
  });

  it("mints a token for that one repository and creates blobs, tree, commit, ref and PR in order", async () => {
    const github = fakeGitHub();
    const client = createGitHubAppClient({
      config: config(),
      fetch: github.fetchImpl,
      now: () => NOW,
    });
    const session = await client.sessionFor({ owner: "acme", name: "widgets" });
    if (session === null) throw new Error("session expected");
    expect(await session.defaultBranch()).toBe("main");
    const result = await session.openPullRequest({
      baseSha: sha("b"),
      base: "main",
      branch: "delegate/imp-1-tests",
      title: "Add parser tests",
      body: "Body",
      message: "test: add parser tests",
      files: [
        { path: "src/a.test.ts", mode: "100644", content: new TextEncoder().encode("test") },
        { path: "old.txt", mode: "100644", content: null },
      ],
    });
    expect(result).toEqual({
      url: "https://github.com/acme/widgets/pull/12",
      number: 12,
      commitSha: sha("f"),
    });
    expect(github.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /repos/acme/widgets/installation",
      "POST /app/installations/99/access_tokens",
      "GET /repos/acme/widgets",
      `GET /repos/acme/widgets/git/commits/${sha("b")}`,
      "POST /repos/acme/widgets/git/blobs",
      "POST /repos/acme/widgets/git/trees",
      "POST /repos/acme/widgets/git/commits",
      "POST /repos/acme/widgets/git/refs",
      "POST /repos/acme/widgets/pulls",
    ]);
    expect(github.requests[1]?.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(github.requests[0]?.authorization).toMatch(/^Bearer eyJ/);
    expect(
      github.requests.slice(2).every((request) => request.authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(github.requests[5]?.body).toEqual({
      base_tree: sha("c"),
      tree: [
        { path: "src/a.test.ts", mode: "100644", type: "blob", sha: sha("d") },
        { path: "old.txt", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(github.requests[6]?.body).toMatchObject({ parents: [sha("b")], tree: sha("e") });
    expect(github.requests[7]?.body).toEqual({
      ref: "refs/heads/delegate/imp-1-tests",
      sha: sha("f"),
    });
  });

  it("never puts the token in an error", async () => {
    const github = fakeGitHub({
      "POST /repos/acme/widgets/git/refs": {
        status: 422,
        body: { message: `Reference already exists for ${TOKEN}` },
      },
    });
    const client = createGitHubAppClient({
      config: config(),
      fetch: github.fetchImpl,
      now: () => NOW,
    });
    const session = await client.sessionFor({ owner: "acme", name: "widgets" });
    const error: unknown = await session
      ?.openPullRequest({
        baseSha: sha("b"),
        base: "main",
        branch: "delegate/x",
        title: "t",
        body: "b",
        message: "m",
        files: [{ path: "a", mode: "100644", content: new Uint8Array([1]) }],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(422);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});
