import { z } from "zod";

import { detectInjection } from "../quarantine/reader";

export const CONNECTOR_LIMITS = {
  descriptionChars: 200,
  toolsPerConnector: 50,
  inputSchemaChars: 8_000,
  outputBytes: 64 * 1024,
  callTimeoutMs: 20_000,
  connectTimeoutMs: 10_000,
} as const;

export const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REMOTE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export const RemoteToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.object({ readOnlyHint: z.boolean().optional() }).loose().optional(),
});
export type RemoteTool = z.infer<typeof RemoteToolSchema>;

export const ScreenedToolSchema = z.object({
  name: z.string().regex(REMOTE_TOOL_NAME),
  description: z.string().max(CONNECTOR_LIMITS.descriptionChars),
  readOnly: z.boolean(),
  withheld: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ScreenedTool = z.infer<typeof ScreenedToolSchema>;

export type WithheldReason = "invalid_name" | "injection_in_description" | "schema_too_large";

function cleanText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const value = schema ?? { type: "object" };
  return JSON.stringify(value).length > CONNECTOR_LIMITS.inputSchemaChars ? null : value;
}

export function screenRemoteTool(raw: RemoteTool): ScreenedTool & { reason?: WithheldReason } {
  const description = cleanText(raw.description ?? "").slice(0, CONNECTOR_LIMITS.descriptionChars);
  const readOnly = raw.annotations?.readOnlyHint === true;
  const name = REMOTE_TOOL_NAME.test(raw.name)
    ? raw.name
    : raw.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "tool";
  const withheld = (reason: WithheldReason) => ({
    name,
    description: "",
    readOnly,
    withheld: true,
    inputSchema: { type: "object" },
    reason,
  });
  if (!REMOTE_TOOL_NAME.test(raw.name)) return withheld("invalid_name");
  const fullDescription = cleanText(raw.description ?? "");
  if (detectInjection(`${raw.name} ${fullDescription}`) !== undefined)
    return withheld("injection_in_description");
  const inputSchema = boundedSchema(raw.inputSchema);
  if (inputSchema === null) return withheld("schema_too_large");
  return { name: raw.name, description, readOnly, withheld: false, inputSchema };
}

export function screenRemoteTools(raw: readonly RemoteTool[]): ScreenedTool[] {
  return raw.slice(0, CONNECTOR_LIMITS.toolsPerConnector).map((tool) => {
    const { reason: _reason, ...screened } = screenRemoteTool(tool);
    return screened;
  });
}

export function connectorToolName(connector: string, tool: string): string {
  return `mcp__${connector}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}
