import { handleGetArtifact } from "@/server/api";
import { apiDeps } from "@/server/deps";

export async function GET(
  request: Request,
  context: RouteContext<"/api/runs/[id]/artifacts/[artifactId]">,
) {
  const { id, artifactId } = await context.params;
  return handleGetArtifact(request, id, artifactId, apiDeps());
}
