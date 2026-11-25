import { z } from "zod";

import { type ApiDeps, apiError, isSameOrigin, readCookie, serializeSessionCookie } from "./api";
import {
  CreateTokenRequestSchema,
  createApiToken,
  hasBearer,
  listApiTokens,
  revokeApiToken,
  TokenLimitError,
} from "./api-tokens";
import {
  AddConnectorRequestSchema,
  addConnector,
  ConnectorError,
  type ConnectorDeps,
  deleteConnector,
  listConnectors,
  refreshConnector,
} from "./connectors";
import type { AppDatabase } from "./db";
import {
  authorizeUrl,
  exchangeCode,
  GITHUB_STATE_COOKIE,
  GITHUB_STATE_MAX_AGE_SECONDS,
  type GithubAppConfig,
  GithubConnectError,
  installUrl,
  issueGithubState,
  listInstallations,
  removeInstallation,
  storeInstallation,
  verifyGithubState,
  verifyInstallation,
} from "./github-connect";
import { SecretStoreError } from "./secrets";
import { type GuestSession, readGuest, resolveGuest, SESSION_COOKIE, signSession } from "./session";
import {
  AutomationError,
  AutomationUpdateSchema,
  readAutomation,
  updateAutomation,
} from "./workspace-settings";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_SETTINGS_BODY_BYTES = 16 * 1024;

export interface ConnectionsDeps {
  api: ApiDeps;
  connectors: () => ConnectorDeps;
  github: () => GithubAppConfig | null;
  fetch: typeof fetch;
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

async function readBody(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return Symbol.for("unsupported");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_BODY_BYTES)
    return Symbol.for("too-large");
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for("invalid");
  }
}

function bodyError(value: unknown): Response | null {
  if (value === Symbol.for("unsupported"))
    return apiError(415, "unsupported_media_type", "Send the request body as application/json.");
  if (value === Symbol.for("too-large"))
    return apiError(413, "payload_too_large", "The request body is too large.");
  if (value === Symbol.for("invalid"))
    return apiError(400, "invalid_json", "The request body is not valid JSON.");
  return null;
}

function guardMutation(request: Request): Response | null {
  if (hasBearer(request))
    return apiError(403, "forbidden", "Settings can only be changed from the Delegate web app.");
  if (!isSameOrigin(request))
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot change settings.");
  return null;
}

async function existingSession(
  request: Request,
  deps: ConnectionsDeps,
): Promise<{ app: AppDatabase; session: GuestSession | null }> {
  const app = await deps.api.app();
  return {
    app,
    session: await readGuest(app, readCookie(request, SESSION_COOKIE), deps.api.secret()),
  };
}

async function ensuredSession(
  request: Request,
  deps: ConnectionsDeps,
): Promise<{ app: AppDatabase; session: GuestSession; headers: Record<string, string> }> {
  const app = await deps.api.app();
  const secret = deps.api.secret();
  const { session, issued } = await resolveGuest(app, readCookie(request, SESSION_COOKIE), secret);
  return {
    app,
    session,
    headers: issued
      ? { "Set-Cookie": serializeSessionCookie(signSession(session, secret), deps.api.production) }
      : {},
  };
}

export interface ConnectionsOverview {
  tokens: Awaited<ReturnType<typeof listApiTokens>>;
  connectors: Awaited<ReturnType<typeof listConnectors>>;
  automation: Awaited<ReturnType<typeof readAutomation>>;
  github: {
    configured: boolean;
    installUrl: string | null;
    installations: Awaited<ReturnType<typeof listInstallations>>;
  };
  encryptionConfigured: boolean;
}

export async function connectionsOverview(
  app: AppDatabase,
  session: GuestSession | null,
  deps: Pick<ConnectionsDeps, "connectors" | "github">,
): Promise<ConnectionsOverview> {
  const github = deps.github();
  let encryptionConfigured = false;
  try {
    encryptionConfigured = deps.connectors().box !== null;
  } catch (error) {
    if (!(error instanceof SecretStoreError)) throw error;
  }
  if (session === null)
    return {
      tokens: [],
      connectors: [],
      automation: { autoApprovePlans: false, preapprovedTools: [], changedTools: [] },
      github: {
        configured: github !== null,
        installUrl: github === null ? null : installUrl(github),
        installations: [],
      },
      encryptionConfigured,
    };
  return {
    tokens: await listApiTokens(app, session),
    connectors: await listConnectors(app, session),
    automation: await readAutomation(app, session),
    github: {
      configured: github !== null,
      installUrl: github === null ? null : installUrl(github),
      installations: await listInstallations(app, session),
    },
    encryptionConfigured,
  };
}

export async function handleConnectionsOverview(
  request: Request,
  deps: ConnectionsDeps,
): Promise<Response> {
  if (hasBearer(request))
    return apiError(403, "forbidden", "Settings are only available in the Delegate web app.");
  const { app, session } = await existingSession(request, deps);
  return Response.json(await connectionsOverview(app, session, deps), { headers: NO_STORE });
}

export async function handleCreateToken(request: Request, deps: ConnectionsDeps) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const body = await readBody(request);
  const error = bodyError(body);
  if (error !== null) return error;
  const parsed = CreateTokenRequestSchema.safeParse(body);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The token request is not valid.", {
      issues: issues(parsed.error),
    });
  const { app, session, headers } = await ensuredSession(request, deps);
  try {
    const created = await createApiToken(app, session, parsed.data.name);
    return Response.json(created, { status: 201, headers: { ...NO_STORE, ...headers } });
  } catch (failure) {
    if (failure instanceof TokenLimitError)
      return apiError(409, "invalid_request", failure.message, { headers });
    throw failure;
  }
}

export async function handleRevokeToken(request: Request, tokenId: string, deps: ConnectionsDeps) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null || !(await revokeApiToken(app, session, tokenId)))
    return apiError(404, "not_found", "No active token with that id.");
  return Response.json({ revoked: true }, { headers: NO_STORE });
}

function connectorErrorResponse(error: ConnectorError): Response {
  switch (error.code) {
    case "invalid_url":
      return apiError(400, "invalid_url", error.message);
    case "encryption_key_missing":
      return apiError(503, "unavailable", error.message);
    case "connect_failed":
      return apiError(502, "unavailable", error.message);
    case "duplicate":
    case "limit":
      return apiError(409, "invalid_request", error.message);
    case "not_found":
      return apiError(404, "not_found", error.message);
  }
}

export async function handleAddConnector(request: Request, deps: ConnectionsDeps) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const body = await readBody(request);
  const error = bodyError(body);
  if (error !== null) return error;
  const parsed = AddConnectorRequestSchema.safeParse(body);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The connector is not valid.", {
      issues: issues(parsed.error),
    });
  const { app, session, headers } = await ensuredSession(request, deps);
  try {
    const connector = await addConnector(app, session, parsed.data, deps.connectors());
    return Response.json({ connector }, { status: 201, headers: { ...NO_STORE, ...headers } });
  } catch (failure) {
    if (failure instanceof ConnectorError) return connectorErrorResponse(failure);
    if (failure instanceof SecretStoreError) return apiError(503, "unavailable", failure.message);
    throw failure;
  }
}

export async function handleDeleteConnector(
  request: Request,
  connectorId: string,
  deps: ConnectionsDeps,
) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null || !(await deleteConnector(app, session, connectorId)))
    return apiError(404, "not_found", "No connector with that id.");
  return Response.json({ deleted: true }, { headers: NO_STORE });
}

export async function handleRefreshConnector(
  request: Request,
  connectorId: string,
  deps: ConnectionsDeps,
) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null) return apiError(404, "not_found", "No connector with that id.");
  try {
    const connector = await refreshConnector(app, session, connectorId, deps.connectors());
    return Response.json({ connector }, { headers: NO_STORE });
  } catch (failure) {
    if (failure instanceof ConnectorError) return connectorErrorResponse(failure);
    if (failure instanceof SecretStoreError) return apiError(503, "unavailable", failure.message);
    throw failure;
  }
}

export async function handleUpdateAutomation(request: Request, deps: ConnectionsDeps) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const body = await readBody(request);
  const error = bodyError(body);
  if (error !== null) return error;
  const parsed = AutomationUpdateSchema.safeParse(body);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The automation settings are not valid.", {
      issues: issues(parsed.error),
    });
  const { app, session, headers } = await ensuredSession(request, deps);
  try {
    const automation = await updateAutomation(app, session, parsed.data);
    return Response.json({ automation }, { headers: { ...NO_STORE, ...headers } });
  } catch (error: unknown) {
    if (error instanceof AutomationError)
      return apiError(400, "invalid_request", error.message, { headers });
    throw error;
  }
}

export async function handleRemoveInstallation(
  request: Request,
  id: string,
  deps: ConnectionsDeps,
) {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null || !(await removeInstallation(app, session, id)))
    return apiError(404, "not_found", "No installation with that id.");
  return Response.json({ removed: true }, { headers: NO_STORE });
}

function origin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost !== undefined && forwardedHost !== "")
    return `${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`;
  return new URL(request.url).origin;
}

export function githubCallbackUrl(request: Request): string {
  return `${origin(request)}/api/github/callback`;
}

function settingsRedirect(request: Request, outcome: string, extraHeaders: string[] = []) {
  const headers = new Headers({
    Location: `${origin(request)}/settings/connections?github=${outcome}`,
    ...NO_STORE,
  });
  headers.append(
    "Set-Cookie",
    `${GITHUB_STATE_COOKIE}=; Path=/api/github; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  for (const cookie of extraHeaders) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function stateCookie(nonce: string, production: boolean): string {
  return [
    `${GITHUB_STATE_COOKIE}=${nonce}`,
    "Path=/api/github",
    `Max-Age=${GITHUB_STATE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(production ? ["Secure"] : []),
  ].join("; ");
}

async function startAuthorization(
  request: Request,
  deps: ConnectionsDeps,
  installationId: number | undefined,
): Promise<Response> {
  const config = deps.github();
  if (config === null) return settingsRedirect(request, "not_configured");
  const { session, headers } = await ensuredSession(request, deps);
  const { state, nonce } = issueGithubState(session, deps.api.secret(), {
    ...(installationId === undefined ? {} : { installationId }),
  });
  const response = new Headers({
    Location: authorizeUrl(config, githubCallbackUrl(request), state),
    ...NO_STORE,
  });
  response.append("Set-Cookie", stateCookie(nonce, deps.api.production));
  if (headers["Set-Cookie"] !== undefined) response.append("Set-Cookie", headers["Set-Cookie"]);
  return new Response(null, { status: 303, headers: response });
}

export function handleGithubConnect(request: Request, deps: ConnectionsDeps): Promise<Response> {
  return startAuthorization(request, deps, undefined);
}

const installationIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export async function handleGithubSetup(request: Request, deps: ConnectionsDeps) {
  const raw = new URL(request.url).searchParams.get("installation_id");
  const installationId = installationIdParam.safeParse(raw ?? undefined);
  if (!installationId.success) return settingsRedirect(request, "missing_installation");
  return startAuthorization(request, deps, installationId.data);
}

export async function handleGithubCallback(request: Request, deps: ConnectionsDeps) {
  const config = deps.github();
  if (config === null) return settingsRedirect(request, "not_configured");
  const url = new URL(request.url);
  const { app, session } = await existingSession(request, deps);
  const verified = verifyGithubState(url.searchParams.get("state"), {
    secret: deps.api.secret(),
    cookieNonce: readCookie(request, GITHUB_STATE_COOKIE),
    session,
  });
  if (!verified.ok || session === null) return settingsRedirect(request, "state_rejected");
  const code = url.searchParams.get("code");
  if (code === null || !/^[A-Za-z0-9_-]{1,200}$/.test(code))
    return settingsRedirect(request, "denied");
  const fromQuery = installationIdParam.safeParse(
    url.searchParams.get("installation_id") ?? undefined,
  );
  const installationId = verified.state.i ?? (fromQuery.success ? fromQuery.data : undefined);
  try {
    const userToken = await exchangeCode(config, code, githubCallbackUrl(request), deps.fetch);
    if (installationId === undefined) return settingsRedirect(request, "authorized");
    const installation = await verifyInstallation(config, userToken, installationId, deps.fetch);
    await storeInstallation(app, session, installation);
    return settingsRedirect(request, "installed");
  } catch (failure) {
    if (failure instanceof GithubConnectError) return settingsRedirect(request, failure.code);
    console.error("github connect failed", failure instanceof Error ? failure.name : "unknown");
    return settingsRedirect(request, "github_unavailable");
  }
}
