import { handleCancelRun } from "@/server/api";
import { apiDeps } from "@/server/deps";

export async function POST(request: Request, context: RouteContext<"/api/runs/[id]/cancel">) {
  const { id } = await context.params;
  return handleCancelRun(request, id, apiDeps());
}
