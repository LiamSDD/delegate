import { handleRunEvents } from "@/server/api";
import { apiDeps } from "@/server/deps";

export const maxDuration = 300;

export async function GET(request: Request, context: RouteContext<"/api/runs/[id]/events">) {
  const { id } = await context.params;
  return handleRunEvents(request, id, apiDeps());
}
