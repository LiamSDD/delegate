import { mcpConnectors, type StoredConnectorTool, withTenant } from "@delegate/db";
import {
  CONNECTOR_NAME_PATTERN,
  ConnectorUrlError,
  connectRemoteMcp,
  type ConnectorEndpoint,
  type ConnectorToolSource,
  createConnectorTools,
  createPinnedFetch,
  createPreapprovalGate,
  type McpConnection,
  type MissionConnections,
  ScreenedToolSchema,
  screenRemoteTools,
  systemResolveDns,
  type ToolApprovalGate,
  validateConnectorUrl,
} from "@delegate/runtime/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import { ENCRYPTION_KEY_MISSING_MESSAGE, type SecretBox } from "./secrets";
import type { GuestSession } from "./session";
import { readAutomation } from "./workspace-settings";

export const MAX_CONNECTORS = 10;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "cookie",
  "connection",
  "transfer-encoding",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

export const AddConnectorRequestSchema = z.strictObject({
  name: z.string().trim().toLowerCase().regex(CONNECTOR_NAME_PATTERN, {
    error: "Use 1–32 lowercase letters, digits or dashes",
  }),
  url: z.string().trim().min(1).max(2048),
  auth: z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("bearer"), token: z.string().trim().min(1).max(4096) }),
      z.strictObject({
        type: z.literal("header"),
        name: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9-]{1,64}$/)
          .refine((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()), {
            error: "That header cannot carry a secret",
          }),
        value: z.string().trim().min(1).max(4096),
      }),
    ])
    .optional(),
});
export type AddConnectorRequest = z.infer<typeof AddConnectorRequestSchema>;

export type OpenEndpoint = (endpoint: ConnectorEndpoint) => Promise<McpConnection>;

export interface ConnectorDeps {
  production: boolean;
  box: SecretBox | null;
  open: OpenEndpoint;
}

export function defaultOpenEndpoint(): OpenEndpoint {
  const pinned = createPinnedFetch(systemResolveDns);
  return (endpoint) => connectRemoteMcp(endpoint, { fetch: pinned });
}

export interface ConnectorListing {
  id: string;
  name: string;
  url: string;
  host: string;
  authHeaderName: string | null;
  hasSecret: boolean;
  tools: StoredConnectorTool[];
  toolsRefreshedAt: string | null;
}

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  constructor(
    readonly code:
      | "invalid_url"
      | "encryption_key_missing"
      | "connect_failed"
      | "duplicate"
      | "limit"
      | "not_found",
    message: string,
  ) {
    super(message);
  }
}

const storedTools = z.array(ScreenedToolSchema).catch([]);

function authHeader(auth: AddConnectorRequest["auth"]): { name: string; value: string } | null {
  if (auth === undefined) return null;
  if (auth.type === "bearer")
    return {
      name: "Authorization",
      value: /^bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`,
    };
  return { name: auth.name, value: auth.value };
}

async function discoverTools(open: OpenEndpoint, endpoint: ConnectorEndpoint) {
  let connection: McpConnection | undefined;
  try {
    connection = await open(endpoint);
    return screenRemoteTools(await connection.listTools());
  } catch (error) {
    if (error instanceof ConnectorUrlError) throw new ConnectorError("invalid_url", error.message);
    throw new ConnectorError(
      "connect_failed",
      "Delegate could not connect to that MCP server or list its tools. Check the URL (Streamable HTTP endpoint) and the credentials.",
    );
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

function checkedUrl(raw: string, production: boolean): URL {
  try {
    return validateConnectorUrl(raw, { production });
  } catch (error) {
    if (error instanceof ConnectorUrlError) throw new ConnectorError("invalid_url", error.message);
    throw error;
  }
}

export async function addConnector(
  app: AppDatabase,
  session: GuestSession,
  request: AddConnectorRequest,
  deps: ConnectorDeps,
): Promise<ConnectorListing> {
  const url = checkedUrl(request.url, deps.production);
  const header = authHeader(request.auth);
  if (header !== null && deps.box === null)
    throw new ConnectorError("encryption_key_missing", ENCRYPTION_KEY_MISSING_MESSAGE);
  const existing = await listConnectors(app, session);
  if (existing.length >= MAX_CONNECTORS)
    throw new ConnectorError("limit", `A workspace can have at most ${MAX_CONNECTORS} connectors.`);
  if (existing.some((connector) => connector.name === request.name))
    throw new ConnectorError("duplicate", `A connector named ${request.name} already exists.`);
  const tools = await discoverTools(deps.open, {
    url,
    ...(header === null ? {} : { headers: { [header.name]: header.value } }),
  });
  const id = crypto.randomUUID();
  const sealed = header === null || deps.box === null ? null : deps.box.seal(header.value, id);
  await withTenant(app.db, session.userId, (tx) =>
    tx.insert(mcpConnectors).values({
      id,
      workspaceId: session.workspaceId,
      name: request.name,
      url: url.href,
      authHeaderName: header?.name ?? null,
      secretCiphertext: sealed,
      tools,
      toolsRefreshedAt: new Date(),
    }),
  );
  return {
    id,
    name: request.name,
    url: url.href,
    host: url.hostname,
    authHeaderName: header?.name ?? null,
    hasSecret: sealed !== null,
    tools,
    toolsRefreshedAt: new Date().toISOString(),
  };
}

interface ConnectorRow {
  id: string;
  name: string;
  url: string;
  authHeaderName: string | null;
  secretCiphertext: string | null;
  tools: unknown;
  toolsRefreshedAt: Date | null;
}

async function connectorRows(app: AppDatabase, session: GuestSession): Promise<ConnectorRow[]> {
  return withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        id: mcpConnectors.id,
        name: mcpConnectors.name,
        url: mcpConnectors.url,
        authHeaderName: mcpConnectors.authHeaderName,
        secretCiphertext: mcpConnectors.secretCiphertext,
        tools: mcpConnectors.tools,
        toolsRefreshedAt: mcpConnectors.toolsRefreshedAt,
      })
      .from(mcpConnectors)
      .where(eq(mcpConnectors.workspaceId, session.workspaceId))
      .orderBy(asc(mcpConnectors.createdAt)),
  );
}

function listing(row: ConnectorRow): ConnectorListing {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    host: new URL(row.url).hostname,
    authHeaderName: row.authHeaderName,
    hasSecret: row.secretCiphertext !== null,
    tools: storedTools.parse(row.tools),
    toolsRefreshedAt: row.toolsRefreshedAt?.toISOString() ?? null,
  };
}

export async function listConnectors(
  app: AppDatabase,
  session: GuestSession,
): Promise<ConnectorListing[]> {
  return (await connectorRows(app, session)).map(listing);
}

export async function deleteConnector(
  app: AppDatabase,
  session: GuestSession,
  connectorId: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(connectorId).success) return false;
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .delete(mcpConnectors)
      .where(
        and(eq(mcpConnectors.id, connectorId), eq(mcpConnectors.workspaceId, session.workspaceId)),
      )
      .returning({ id: mcpConnectors.id }),
  );
  return rows.length === 1;
}

function endpointFor(row: ConnectorRow, deps: ConnectorDeps): ConnectorEndpoint {
  const url = checkedUrl(row.url, deps.production);
  if (row.secretCiphertext === null || row.authHeaderName === null) return { url };
  if (deps.box === null)
    throw new ConnectorError("encryption_key_missing", ENCRYPTION_KEY_MISSING_MESSAGE);
  return { url, headers: { [row.authHeaderName]: deps.box.open(row.secretCiphertext, row.id) } };
}

export async function refreshConnector(
  app: AppDatabase,
  session: GuestSession,
  connectorId: string,
  deps: ConnectorDeps,
): Promise<ConnectorListing> {
  const row = (await connectorRows(app, session)).find((entry) => entry.id === connectorId);
  if (row === undefined) throw new ConnectorError("not_found", "No such connector.");
  const tools = await discoverTools(deps.open, endpointFor(row, deps));
  await withTenant(app.db, session.userId, (tx) =>
    tx
      .update(mcpConnectors)
      .set({ tools, toolsRefreshedAt: sql`now()` })
      .where(eq(mcpConnectors.id, connectorId)),
  );
  return listing({ ...row, tools, toolsRefreshedAt: new Date() });
}

export async function loadConnectorSources(
  app: AppDatabase,
  session: GuestSession,
  deps: ConnectorDeps,
): Promise<ConnectorToolSource[]> {
  const rows = await connectorRows(app, session);
  return rows.flatMap((row) => {
    let endpoint: ConnectorEndpoint;
    try {
      endpoint = endpointFor(row, deps);
    } catch {
      return [];
    }
    return [
      {
        connectorId: row.id,
        name: row.name,
        host: endpoint.url.hostname,
        tools: storedTools.parse(row.tools),
        open: () => deps.open(endpoint),
      },
    ];
  });
}

export async function loadMissionConnections(
  app: AppDatabase,
  session: GuestSession,
  deps: ConnectorDeps & { readerPrompt: string; fallback?: ToolApprovalGate },
): Promise<MissionConnections | undefined> {
  const sources = await loadConnectorSources(app, session, deps);
  if (sources.length === 0) return undefined;
  const automation = await readAutomation(app, session);
  return {
    tools: createConnectorTools({ connectors: sources, readerPrompt: deps.readerPrompt }),
    hosts: [...new Set(sources.map((source) => source.host))],
    approvals: createPreapprovalGate(automation.preapprovedTools, deps.fallback),
  };
}
