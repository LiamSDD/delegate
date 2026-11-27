import { handleGetRun } from "@/server/api";
import { apiDeps } from "@/server/deps";

export const maxDuration = 300;

export async function GET(request: Request, context: RouteContext<"/api/runs/[id]">) {
  const { id } = await context.params;
  return handleGetRun(request, id, apiDeps());
}
