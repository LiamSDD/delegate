import { apiDeps } from "@/server/deps";
import { handleToolDecision } from "@/server/tool-approval-api";

export async function POST(
  request: Request,
  context: RouteContext<"/api/runs/[id]/tool-approval">,
) {
  const { id } = await context.params;
  return handleToolDecision(request, id, apiDeps());
}
