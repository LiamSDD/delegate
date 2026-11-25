import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

import { z } from "zod";

import { type RepoRef } from "./repo";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "delegate-ship-a-pr";
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;
const MAX_ERROR_CHARS = 200;

export interface GitHubAppEnv {
  GITHUB_APP_ID?: string | undefined;
  GITHUB_APP_PRIVATE_KEY?: string | undefined;
  GITHUB_APP_SLUG?: string | undefined;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: KeyObject;
  slug?: string;
}

export { parseGitHubRepoUrl, repoFullName, type RepoRef } from "./repo";

export class GitHubAppConfigError extends Error {
  override readonly name = "GitHubAppConfigError";
}

export function readGitHubAppConfig(env: GitHubAppEnv): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const pem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (appId === undefined || appId === "" || pem === undefined || pem === "") return null;
  if (!/^\d{1,12}$/.test(appId)) throw new GitHubAppConfigError("GITHUB_APP_ID must be numeric");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem.replace(/\\n/g, "\n"));
  } catch {
    throw new GitHubAppConfigError("GITHUB_APP_PRIVATE_KEY is not a valid PEM private key");
  }
  const slug = env.GITHUB_APP_SLUG?.trim();
  return { appId, privateKey, ...(slug === undefined || slug === "" ? {} : { slug }) };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function createAppJwt(config: GitHubAppConfig, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: config.appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(config.privateKey))}`;
}

export class GitHubApiError extends Error {
  override readonly name = "GitHubApiError";
  constructor(
    readonly status: number,
    readonly operation: string,
    detail: string,
  ) {
    super(`GitHub ${operation} failed (${status})${detail === "" ? "" : `: ${detail}`}`);
  }
}

const ErrorBodySchema = z.object({ message: z.string() }).loose();
const InstallationSchema = z.object({ id: z.number().int().positive() }).loose();
const TokenSchema = z.object({ token: z.string().min(1) }).loose();
const ShaSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).loose();
const CommitSchema = z
  .object({ sha: z.string(), tree: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) })
  .loose();
const RepositorySchema = z.object({ default_branch: z.string().min(1) }).loose();
const CollaboratorPermissionSchema = z
  .object({ permission: z.string().min(1).max(40), role_name: z.string().max(100).optional() })
  .loose();
const PullSchema = z.object({ number: z.number().int().positive(), html_url: z.url() }).loose();

export type FileMode = "100644" | "100755";

export interface FileChange {
  path: string;
  mode: FileMode;
  content: Uint8Array | null;
}

export interface PullRequestChange {
  baseSha: string;
  base: string;
  branch: string;
  title: string;
  body: string;
  message: string;
  files: readonly FileChange[];
}

export interface PullRequestResult {
  url: string;
  number: number;
  commitSha: string;
}

export interface PushAccess {
  allowed: boolean;
  permission: string;
}

export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PUSH_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

export interface RepoSession {
  readonly repo: RepoRef;
  defaultBranch(): Promise<string>;
  pushAccess(login: string): Promise<PushAccess>;
  openPullRequest(change: PullRequestChange): Promise<PullRequestResult>;
}

export interface GitHubAppClient {
  installationFor(repo: RepoRef): Promise<number | null>;
  sessionFor(repo: RepoRef, installationId?: number): Promise<RepoSession | null>;
}

export interface GitHubAppClientOptions {
  config: GitHubAppConfig;
  fetch?: typeof fetch;
  now?: () => number;
  apiBase?: string;
  signal?: AbortSignal;
}

function sanitise(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
    .slice(0, MAX_ERROR_CHARS);
}

export function createGitHubAppClient(options: GitHubAppClientOptions): GitHubAppClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const apiBase = options.apiBase ?? GITHUB_API_BASE;

  const call = async <T>(
    operation: string,
    method: "GET" | "POST",
    path: string,
    bearer: string,
    schema: z.ZodType<T>,
    body?: unknown,
    allowNotFound = false,
  ): Promise<T | null> => {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${bearer}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const text = await response.text();
    if (allowNotFound && response.status === 404) return null;
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      throw new GitHubApiError(
        response.status,
        operation,
        parsed.success ? sanitise(parsed.data.message) : "",
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new GitHubApiError(response.status, operation, "unexpected response shape");
    return parsed.data;
  };

  const repoPath = (repo: RepoRef) =>
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  const installationFor = async (repo: RepoRef): Promise<number | null> => {
    const installation = await call(
      "installation lookup",
      "GET",
      `${repoPath(repo)}/installation`,
      createAppJwt(options.config, now()),
      InstallationSchema,
      undefined,
      true,
    );
    return installation?.id ?? null;
  };

  return {
    installationFor,
    async sessionFor(repo, knownInstallation) {
      const installationId = knownInstallation ?? (await installationFor(repo));
      if (installationId === null) return null;
      const minted = await call(
        "installation token",
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        createAppJwt(options.config, now()),
        TokenSchema,
        {
          repositories: [repo.name],
          permissions: { contents: "write", pull_requests: "write" },
        },
      );
      if (minted === null) return null;
      const token = minted.token;
      const base = repoPath(repo);
      const must = <T>(value: T | null): T => {
        if (value === null) throw new GitHubApiError(404, "request", "not found");
        return value;
      };
      return {
        repo,
        async defaultBranch() {
          const repository = must(await call("repository", "GET", base, token, RepositorySchema));
          return repository.default_branch;
        },
        async pushAccess(login) {
          if (!GITHUB_LOGIN_PATTERN.test(login)) return { allowed: false, permission: "none" };
          const found = await call(
            "collaborator permission",
            "GET",
            `${base}/collaborators/${encodeURIComponent(login)}/permission`,
            token,
            CollaboratorPermissionSchema,
            undefined,
            true,
          );
          if (found === null) return { allowed: false, permission: "none" };
          const role = found.role_name ?? found.permission;
          return {
            allowed: PUSH_PERMISSIONS.has(found.permission) || PUSH_PERMISSIONS.has(role),
            permission: role,
          };
        },
        async openPullRequest(change) {
          const commit = must(
            await call(
              "base commit",
              "GET",
              `${base}/git/commits/${change.baseSha}`,
              token,
              CommitSchema,
            ),
          );
          const tree: { path: string; mode: FileMode; type: "blob"; sha: string | null }[] = [];
          for (const file of change.files) {
            if (file.content === null) {
              tree.push({ path: file.path, mode: file.mode, type: "blob", sha: null });
              continue;
            }
            const blob = must(
              await call("blob", "POST", `${base}/git/blobs`, token, ShaSchema, {
                content: Buffer.from(file.content).toString("base64"),
                encoding: "base64",
              }),
            );
            tree.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
          }
          const createdTree = must(
            await call("tree", "POST", `${base}/git/trees`, token, ShaSchema, {
              base_tree: commit.tree.sha,
              tree,
            }),
          );
          const createdCommit = must(
            await call("commit", "POST", `${base}/git/commits`, token, ShaSchema, {
              message: change.message,
              tree: createdTree.sha,
              parents: [change.baseSha],
            }),
          );
          must(
            await call("branch", "POST", `${base}/git/refs`, token, z.unknown(), {
              ref: `refs/heads/${change.branch}`,
              sha: createdCommit.sha,
            }),
          );
          const pull = must(
            await call("pull request", "POST", `${base}/pulls`, token, PullSchema, {
              title: change.title,
              head: change.branch,
              base: change.base,
              body: change.body,
            }),
          );
          return { url: pull.html_url, number: pull.number, commitSha: createdCommit.sha };
        },
      };
    },
  };
}
