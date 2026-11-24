import { handleCreateRun } from "@/server/api";
import { apiDeps } from "@/server/deps";

export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return handleCreateRun(request, apiDeps());
}
