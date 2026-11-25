import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { CONNECTOR_LIMITS, RemoteToolSchema, type RemoteTool } from "./screen";
import { refuseRedirects } from "./url";

export interface ConnectorEndpoint {
  url: URL;
  headers?: Record<string, string>;
}

export interface ConnectorCallResult {
  text: string;
  bytes: number;
  truncated: boolean;
  isError: boolean;
}

export interface McpConnection {
  listTools(): Promise<RemoteTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<ConnectorCallResult>;
  close(): Promise<void>;
}

export type OpenConnection = () => Promise<McpConnection>;

const CallResultSchema = z.object({
  content: z.array(z.object({ type: z.string() }).loose()).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

const TextContentSchema = z.object({ type: z.literal("text"), text: z.string() });

export const DELEGATE_CLIENT_INFO = { name: "delegate", version: "0.1.0" } as const;

export function flattenToolResult(raw: unknown, maxBytes: number): ConnectorCallResult {
  const parsed = CallResultSchema.parse(raw);
  const parts = parsed.content.map((item) => {
    const text = TextContentSchema.safeParse(item);
    if (text.success) return text.data.text;
    return `[${item.type} content omitted]`;
  });
  if (parts.length === 0 && parsed.structuredContent !== undefined)
    parts.push(JSON.stringify(parsed.structuredContent));
  const joined = parts.join("\n");
  const encoded = new TextEncoder().encode(joined);
  const truncated = encoded.byteLength > maxBytes;
  const text = truncated
    ? new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/�+$/u, "")
    : joined;
  return { text, bytes: encoded.byteLength, truncated, isError: parsed.isError === true };
}

export async function connectWithTransport(
  transport: Transport,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<McpConnection> {
  const client = new Client(DELEGATE_CLIENT_INFO, { capabilities: {} });
  const timeout = options.timeoutMs ?? CONNECTOR_LIMITS.callTimeoutMs;
  const maxBytes = options.maxOutputBytes ?? CONNECTOR_LIMITS.outputBytes;
  await client.connect(transport, { timeout: CONNECTOR_LIMITS.connectTimeoutMs });
  return {
    async listTools() {
      const listed = await client.listTools(undefined, { timeout });
      return listed.tools.flatMap((tool) => {
        const parsed = RemoteToolSchema.safeParse(tool);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async callTool(name, args, signal) {
      const argumentsRecord = z.record(z.string(), z.unknown()).catch({}).parse(args);
      const result = await client.callTool({ name, arguments: argumentsRecord }, undefined, {
        timeout,
        maxTotalTimeout: timeout,
        ...(signal === undefined ? {} : { signal }),
      });
      return flattenToolResult(result, maxBytes);
    },
    close: () => client.close(),
  };
}

export function connectRemoteMcp(
  endpoint: ConnectorEndpoint,
  options: { fetch: typeof fetch; timeoutMs?: number; maxOutputBytes?: number },
): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(endpoint.url, {
    fetch: refuseRedirects(options.fetch),
    redirectPolicy: "same-origin",
    requestInit: { headers: { ...endpoint.headers } },
  });
  return connectWithTransport(transport, options);
}
