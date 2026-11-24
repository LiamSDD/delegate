import { handleGetRun } from "@/server/api";
import { apiDeps } from "@/server/deps";

export async function GET(request: Request, context: RouteContext<"/api/runs/[id]">) {
  const { id } = await context.params;
  return handleGetRun(request, id, apiDeps());
}
