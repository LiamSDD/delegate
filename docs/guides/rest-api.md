# REST reference

This page renders the OpenAPI document that this deployment serves at `/api/v1/openapi.json`. The reference below is fetched by your browser when the page loads, so it always describes the API of the deployment you are looking at. Nothing in it is written by hand.

## Reference

<!-- live:openapi-reference -->

## Authentication

API requests use the same workspace tokens as the MCP endpoint, sent as a bearer token:

```text
Authorization: Bearer <your-delegate-token>
```

Create and revoke tokens under Settings, Connections, as described in [connect Claude Code, Codex, Cursor and VS Code](connect-mcp-clients.md#1-create-a-token). A request made with a token runs with the same tenant isolation, quotas, policies and approvals as a request from the browser. A token cannot change workspace settings.

## If you are driving Delegate from an agent

The [MCP endpoint](connect-mcp-clients.md) exposes missions and runs as tools, with a long-poll for progress, and is usually the shorter path for a coding agent.
