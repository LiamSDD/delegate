#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDelegateClient } from "@delegate/sdk";
import { z } from "zod";

import { restBackend, STDIO_MISSIONS } from "./rest-backend";
import { createDelegateMcpServer } from "./server";

const EnvSchema = z.object({
  DELEGATE_URL: z.url().default("http://localhost:3000"),
  DELEGATE_TOKEN: z.string().regex(/^dlg_/, "DELEGATE_TOKEN must be a Delegate API token (dlg_…)"),
});

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `delegate-mcp: ${parsed.error.issues.map((issue) => issue.message).join("; ")}\nSet DELEGATE_URL and DELEGATE_TOKEN (create a token under Settings → Connections).\n`,
    );
    process.exitCode = 1;
    return;
  }
  const client = createDelegateClient({
    baseUrl: parsed.data.DELEGATE_URL,
    token: parsed.data.DELEGATE_TOKEN,
    userAgent: "delegate-mcp-stdio/0.1",
  });
  const server = createDelegateMcpServer(restBackend(client), { missions: STDIO_MISSIONS });
  await server.connect(new StdioServerTransport());
}

await main();
