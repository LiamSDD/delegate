import { apiDeps } from "@/server/deps";
import { handleMcp } from "@/server/mcp-endpoint";

export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return handleMcp(request, apiDeps());
}

export function GET(request: Request): Promise<Response> {
  return handleMcp(request, apiDeps());
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcp(request, apiDeps());
}
