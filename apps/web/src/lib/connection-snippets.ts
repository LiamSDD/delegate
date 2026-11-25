export const TOKEN_PLACEHOLDER = "<your-delegate-token>";
export const TOKEN_ENV_VAR = "DELEGATE_TOKEN";

export interface ClientSnippet {
  id: "claude-code" | "codex" | "cursor" | "vscode" | "generic" | "stdio";
  client: string;
  where: string;
  language: "bash" | "toml" | "json" | "text";
  code: string;
  verifiedAgainst: string;
}

export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

export function clientSnippets(origin: string, token: string = TOKEN_PLACEHOLDER): ClientSnippet[] {
  const url = mcpEndpoint(origin);
  return [
    {
      id: "claude-code",
      client: "Claude Code",
      where: "Run in a terminal, then check the connection with /mcp inside Claude Code.",
      language: "bash",
      code: `claude mcp add --transport http delegate ${url} \\\n  --header "Authorization: Bearer ${token}"`,
      verifiedAgainst: "code.claude.com/docs/en/mcp, 2026-11-25",
    },
    {
      id: "codex",
      client: "Codex",
      where: `Add to ~/.codex/config.toml, then export ${TOKEN_ENV_VAR} in the shell that starts Codex.`,
      language: "toml",
      code: `[mcp_servers.delegate]\nurl = "${url}"\nbearer_token_env_var = "${TOKEN_ENV_VAR}"\n\n# export ${TOKEN_ENV_VAR}=${token}`,
      verifiedAgainst: "learn.chatgpt.com/docs/extend/mcp (Codex CLI), 2026-11-25",
    },
    {
      id: "cursor",
      client: "Cursor",
      where: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).",
      language: "json",
      code: JSON.stringify(
        {
          mcpServers: {
            delegate: { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV_VAR}}` } },
          },
        },
        null,
        2,
      ),
      verifiedAgainst: "cursor.com/docs/context/mcp, 2026-11-25",
    },
    {
      id: "vscode",
      client: "VS Code",
      where: "Add to .vscode/mcp.json; VS Code prompts for the token once and stores it securely.",
      language: "json",
      code: JSON.stringify(
        {
          inputs: [
            {
              type: "promptString",
              id: "delegate-token",
              description: "Delegate API token",
              password: true,
            },
          ],
          servers: {
            delegate: {
              type: "http",
              url,
              headers: { Authorization: "Bearer ${input:delegate-token}" },
            },
          },
        },
        null,
        2,
      ),
      verifiedAgainst: "code.visualstudio.com/docs/agents/reference/mcp-configuration, 2026-11-25",
    },
    {
      id: "generic",
      client: "Any MCP client",
      where: "Streamable HTTP, stateless, JSON responses. Send the token on every request.",
      language: "text",
      code: `URL:        ${url}\nTransport:  Streamable HTTP (POST only, no session)\nHeader:     Authorization: Bearer ${token}`,
      verifiedAgainst: "MCP specification, Streamable HTTP transport",
    },
    {
      id: "stdio",
      client: "Local stdio server",
      where:
        "For clients that only speak stdio: a thin client over the REST API with the same token.",
      language: "bash",
      code: `DELEGATE_URL=${origin.replace(/\/+$/, "")} ${TOKEN_ENV_VAR}=${token} \\\n  pnpm --filter @delegate/mcp-server stdio`,
      verifiedAgainst: "packages/mcp-server/src/stdio.ts",
    },
  ];
}
