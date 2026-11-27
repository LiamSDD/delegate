import { handlePlanDecision } from "@/server/api";
import { apiDeps } from "@/server/deps";

export const maxDuration = 300;

export async function POST(request: Request, context: RouteContext<"/api/runs/[id]/plan">) {
  const { id } = await context.params;
  return handlePlanDecision(request, id, apiDeps());
}
