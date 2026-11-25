import { handleRevokeToken } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export async function DELETE(request: Request, context: RouteContext<"/api/settings/tokens/[id]">) {
  const { id } = await context.params;
  return handleRevokeToken(request, id, connectionsDeps());
}
