export const packageName = "@delegate/mcp-server" as const;

export {
  BackendError,
  createDelegateMcpServer,
  SERVER_INFO,
  WAIT_DEFAULT_SECONDS,
  WAIT_MAX_SECONDS,
  type DelegateBackend,
  type ServerOptions,
} from "./server";
export {
  handleMcpHttpRequest,
  MCP_MAX_BODY_BYTES,
  mcpMethodNotAllowed,
  mcpUnauthorized,
} from "./http";
export { restBackend, STDIO_MISSIONS } from "./rest-backend";
