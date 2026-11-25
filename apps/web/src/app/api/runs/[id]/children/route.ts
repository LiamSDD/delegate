import { handleRunChildren } from "@/server/api";
import { apiDeps } from "@/server/deps";

export const maxDuration = 300;

export async function GET(request: Request, context: RouteContext<"/api/runs/[id]/children">) {
  const { id } = await context.params;
  return handleRunChildren(request, id, apiDeps());
}
