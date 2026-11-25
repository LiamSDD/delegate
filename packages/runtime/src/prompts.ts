import { z } from "zod";

export const PromptHeaderSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/),
  version: z.coerce.number().int().positive(),
  status: z.enum(["draft", "active", "retired"]),
  intent: z.string().min(1),
  inputs: z.array(z.string().min(1)),
  output: z.string().min(1),
  changes: z.string().min(1).optional(),
});

export type PromptHeader = z.infer<typeof PromptHeaderSchema>;

export interface PromptFile extends PromptHeader {
  body: string;
}

const FILE_NAME = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)\.v(\d+)\.md$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseValue(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return value;
}

export function parsePromptFile(fileName: string, source: string): PromptFile {
  const nameMatch = FILE_NAME.exec(fileName);
  if (nameMatch === null) throw new Error(`Prompt file ${fileName} must be named <name>.v<N>.md`);
  const match = FRONT_MATTER.exec(source);
  if (match === null) throw new Error(`Prompt file ${fileName} needs a --- front-matter header`);
  const [, header = "", body = ""] = match;

  const fields: Record<string, string | string[]> = {};
  for (const line of header.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1)
      throw new Error(`Prompt file ${fileName} has a malformed header line: ${line}`);
    fields[line.slice(0, colon).trim()] = parseValue(line.slice(colon + 1));
  }

  const parsed = PromptHeaderSchema.parse(fields);
  if (parsed.name !== nameMatch[1]) {
    throw new Error(`Prompt file ${fileName} declares name ${parsed.name}`);
  }
  if (parsed.version !== Number(nameMatch[2])) {
    throw new Error(`Prompt file ${fileName} declares version ${parsed.version}`);
  }
  return { ...parsed, body };
}
