import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createDelegateMcpServer, type DelegateBackend, type ServerOptions } from "./server";

export const MCP_MAX_BODY_BYTES = 256 * 1024;

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: { "Cache-Control": "no-store", Allow: "POST" } },
  );
}

export function mcpMethodNotAllowed(): Response {
  return jsonRpcError(405, -32000, "This MCP endpoint is stateless: send JSON-RPC over POST.");
}

export function mcpUnauthorized(resourceMetadataUrl?: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Missing or invalid API token. Create one in Delegate under Settings → Connections and send it as 'Authorization: Bearer <token>'.",
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate":
          resourceMetadataUrl === undefined
            ? 'Bearer realm="delegate"'
            : `Bearer realm="delegate", resource_metadata="${resourceMetadataUrl}"`,
      },
    },
  );
}

export async function handleMcpHttpRequest(
  request: Request,
  backend: DelegateBackend,
  options: ServerOptions,
): Promise<Response> {
  if (request.method !== "POST") return mcpMethodNotAllowed();
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MCP_MAX_BODY_BYTES)
    return jsonRpcError(413, -32600, "Request body too large.");
  const server = createDelegateMcpServer(backend, options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
