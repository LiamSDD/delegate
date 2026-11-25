import { type ToolCall } from "../providers/types";
import { type RegisteredTool } from "../tools/registry";
import { readJson } from "./json-repair";
import { fitToSchema } from "./schema-repair";

export function repairToolCall(tools: readonly RegisteredTool[], call: ToolCall): ToolCall {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined || call.argumentsJson.trim() === "") return call;
  const reading = readJson(call.argumentsJson);
  if (!reading.ok || reading.truncated) return call;
  const fitted = fitToSchema(tool.definition.inputSchema, reading.value);
  const args = fitted.ok ? fitted.input : reading.value;
  const changed = reading.repaired || (fitted.ok && fitted.repairs.length > 0);
  return changed ? { ...call, argumentsJson: JSON.stringify(args) } : call;
}
