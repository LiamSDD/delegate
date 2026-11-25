import { apiDeps } from "@/server/deps";
import { handleShipDecision } from "@/server/ship-api";

export async function POST(request: Request, context: RouteContext<"/api/runs/[id]/ship">) {
  const { id } = await context.params;
  return handleShipDecision(request, id, apiDeps());
}
