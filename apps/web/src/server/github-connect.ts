import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { githubInstallations, withTenant } from "@delegate/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export const GITHUB_STATE_COOKIE = "delegate_github_state";
export const GITHUB_STATE_MAX_AGE_SECONDS = 10 * 60;
const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const MAX_REPOSITORY_PAGES = 10;

export interface GithubAppConfig {
  clientId: string;
  clientSecret: string;
  slug: string;
}

const githubEnvSchema = z.object({
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
});

export function githubAppConfig(env: Record<string, string | undefined>): GithubAppConfig | null {
  const parsed = githubEnvSchema.parse(env);
  const clientId = parsed.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  const clientSecret = parsed.GITHUB_APP_CLIENT_SECRET?.trim() ?? "";
  const slug = parsed.GITHUB_APP_SLUG?.trim() ?? "";
  if (clientId === "" || clientSecret === "" || !/^[a-z0-9-]{1,100}$/i.test(slug)) return null;
  return { clientId, clientSecret, slug };
}

const statePayloadSchema = z.strictObject({
  v: z.literal(1),
  w: z.uuid(),
  u: z.uuid(),
  n: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
  iat: z.int().nonnegative(),
  i: z.int().positive().optional(),
});
export type GithubState = z.infer<typeof statePayloadSchema>;

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", `github-state:${secret}`).update(payload, "utf8").digest();
}

export function issueGithubState(
  session: GuestSession,
  secret: string,
  options: { installationId?: number; now?: Date } = {},
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      w: session.workspaceId,
      u: session.userId,
      n: nonce,
      iat: Math.floor((options.now ?? new Date()).getTime() / 1000),
      ...(options.installationId === undefined ? {} : { i: options.installationId }),
    }),
    "utf8",
  ).toString("base64url");
  return { state: `${payload}.${mac(payload, secret).toString("base64url")}`, nonce };
}

export type StateRejection = "malformed" | "signature" | "expired" | "nonce" | "session";

export function verifyGithubState(
  state: string | null,
  options: {
    secret: string;
    cookieNonce: string | undefined;
    session: GuestSession | null;
    now?: Date;
  },
): { ok: true; state: GithubState } | { ok: false; reason: StateRejection } {
  if (state === null) return { ok: false, reason: "malformed" };
  const [payload, signature, ...rest] = state.split(".");
  if (payload === undefined || signature === undefined || rest.length > 0 || payload === "")
    return { ok: false, reason: "malformed" };
  const expected = mac(payload, options.secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "signature" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = statePayloadSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const age = Math.floor((options.now ?? new Date()).getTime() / 1000) - parsed.data.iat;
  if (age < 0 || age > GITHUB_STATE_MAX_AGE_SECONDS) return { ok: false, reason: "expired" };
  const cookie = Buffer.from(options.cookieNonce ?? "", "utf8");
  const nonce = Buffer.from(parsed.data.n, "utf8");
  if (cookie.length !== nonce.length || !timingSafeEqual(cookie, nonce))
    return { ok: false, reason: "nonce" };
  if (options.session?.userId !== parsed.data.u || options.session.workspaceId !== parsed.data.w)
    return { ok: false, reason: "session" };
  return { ok: true, state: parsed.data };
}

export function authorizeUrl(config: GithubAppConfig, redirectUri: string, state: string): string {
  const url = new URL("/login/oauth/authorize", GITHUB_WEB);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.href;
}

export function installUrl(config: GithubAppConfig): string {
  return `${GITHUB_WEB}/apps/${encodeURIComponent(config.slug)}/installations/new`;
}

export class GithubConnectError extends Error {
  override readonly name = "GithubConnectError";
  constructor(
    readonly code: "exchange_failed" | "not_your_installation" | "github_unavailable",
    message: string,
  ) {
    super(message);
  }
}

const tokenResponseSchema = z.union([
  z.object({ access_token: z.string().min(1), token_type: z.string() }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

const installationSchema = z.object({
  id: z.int().positive(),
  app_slug: z.string().optional(),
  account: z.object({ login: z.string(), type: z.string() }).nullable(),
  repository_selection: z.enum(["all", "selected"]),
});
export type UserInstallation = z.infer<typeof installationSchema>;

const installationsResponseSchema = z.object({
  total_count: z.int().nonnegative(),
  installations: z.array(installationSchema),
});

const repositoriesResponseSchema = z.object({
  total_count: z.int().nonnegative(),
  repositories: z.array(z.object({ full_name: z.string() })),
});

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "delegate-github-connect",
  };
}

export async function exchangeCode(
  config: GithubAppConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    redirect: "error",
  });
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success || !("access_token" in parsed.data))
    throw new GithubConnectError("exchange_failed", "GitHub did not accept the authorization.");
  return parsed.data.access_token;
}

export async function listUserInstallations(
  userToken: string,
  fetchImpl: typeof fetch,
): Promise<UserInstallation[]> {
  const response = await fetchImpl(`${GITHUB_API}/user/installations?per_page=100`, {
    headers: githubHeaders(userToken),
    redirect: "error",
  });
  const parsed = installationsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success)
    throw new GithubConnectError("github_unavailable", "GitHub did not list your installations.");
  return parsed.data.installations;
}

export async function listInstallationRepositories(
  userToken: string,
  installationId: number,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
    const response = await fetchImpl(
      `${GITHUB_API}/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      { headers: githubHeaders(userToken), redirect: "error" },
    );
    const parsed = repositoriesResponseSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success)
      throw new GithubConnectError("github_unavailable", "GitHub did not list the repositories.");
    names.push(...parsed.data.repositories.map((repo) => repo.full_name));
    if (names.length >= parsed.data.total_count || parsed.data.repositories.length < 100) break;
  }
  return names;
}

export interface VerifiedInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
}

export async function verifyInstallation(
  config: GithubAppConfig,
  userToken: string,
  installationId: number,
  fetchImpl: typeof fetch,
): Promise<VerifiedInstallation> {
  const installations = await listUserInstallations(userToken, fetchImpl);
  const match = installations.find(
    (installation) =>
      installation.id === installationId &&
      (installation.app_slug === undefined || installation.app_slug === config.slug),
  );
  const account = match?.account ?? null;
  if (match === undefined || account === null)
    throw new GithubConnectError(
      "not_your_installation",
      "That installation is not accessible to the GitHub account that authorized Delegate.",
    );
  return {
    installationId: match.id,
    accountLogin: account.login,
    accountType: account.type,
    repositorySelection: match.repository_selection,
    repositories:
      match.repository_selection === "selected"
        ? await listInstallationRepositories(userToken, match.id, fetchImpl)
        : [],
  };
}

export async function storeInstallation(
  app: AppDatabase,
  session: GuestSession,
  installation: VerifiedInstallation,
): Promise<void> {
  const values = {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
    repositories: installation.repositories,
  };
  await withTenant(app.db, session.userId, (tx) =>
    tx
      .insert(githubInstallations)
      .values({
        workspaceId: session.workspaceId,
        installationId: installation.installationId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [githubInstallations.workspaceId, githubInstallations.installationId],
        set: { ...values, updatedAt: sql`now()` },
      }),
  );
}

export interface InstallationListing {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  repositories: string[];
  updatedAt: string;
}

const repoList = z.array(z.string()).catch([]);

export async function listInstallations(
  app: AppDatabase,
  session: GuestSession,
): Promise<InstallationListing[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.workspaceId, session.workspaceId))
      .orderBy(asc(githubInstallations.createdAt)),
  );
  return rows.map((row) => ({
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    repositories: repoList.parse(row.repositories),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function removeInstallation(
  app: AppDatabase,
  session: GuestSession,
  id: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .delete(githubInstallations)
      .where(
        and(
          eq(githubInstallations.id, id),
          eq(githubInstallations.workspaceId, session.workspaceId),
        ),
      )
      .returning({ id: githubInstallations.id }),
  );
  return rows.length === 1;
}

export interface RepoInstallation {
  installationId: number;
  accountLogin: string;
  repositorySelection: "all" | "selected";
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export async function findInstallationForRepo(
  workspaceId: string,
  owner: string,
  repo: string,
  scope: { app: AppDatabase; userId: string },
): Promise<RepoInstallation | null> {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  if (!z.uuid().safeParse(workspaceId).success) return null;
  const rows = await withTenant(scope.app.db, scope.userId, (tx) =>
    tx
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspaceId, workspaceId),
          sql`lower(${githubInstallations.accountLogin}) = lower(${owner})`,
        ),
      )
      .orderBy(asc(githubInstallations.createdAt)),
  );
  const fullName = `${owner}/${repo}`.toLowerCase();
  for (const row of rows) {
    const covers =
      row.repositorySelection === "all" ||
      repoList.parse(row.repositories).some((name) => name.toLowerCase() === fullName);
    if (covers)
      return {
        installationId: row.installationId,
        accountLogin: row.accountLogin,
        repositorySelection: row.repositorySelection === "all" ? "all" : "selected",
      };
  }
  return null;
}
