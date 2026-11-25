import { describe, expect, it } from "vitest";

import { clientSnippets, mcpEndpoint } from "./connection-snippets";

describe("client setup snippets", () => {
  const snippets = clientSnippets("https://delegate.example/", "dlg_abc");
  const byId = Object.fromEntries(snippets.map((snippet) => [snippet.id, snippet.code]));

  it("points every client at the MCP endpoint", () => {
    expect(mcpEndpoint("https://delegate.example/")).toBe("https://delegate.example/api/mcp");
    for (const snippet of snippets.filter((entry) => entry.id !== "stdio"))
      expect(snippet.code).toContain("https://delegate.example/api/mcp");
  });

  it("uses the documented Claude Code and Codex syntax", () => {
    expect(byId["claude-code"]).toBe(
      'claude mcp add --transport http delegate https://delegate.example/api/mcp \\\n  --header "Authorization: Bearer dlg_abc"',
    );
    expect(byId.codex).toContain(
      '[mcp_servers.delegate]\nurl = "https://delegate.example/api/mcp"',
    );
    expect(byId.codex).toContain('bearer_token_env_var = "DELEGATE_TOKEN"');
  });

  it("emits valid JSON for the editor configs", () => {
    expect(JSON.parse(byId.cursor ?? "")).toMatchObject({ mcpServers: { delegate: {} } });
    expect(JSON.parse(byId.vscode ?? "")).toMatchObject({
      servers: { delegate: { type: "http" } },
    });
  });
});
