import { handleRemoveInstallation } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export async function DELETE(request: Request, context: RouteContext<"/api/settings/github/[id]">) {
  const { id } = await context.params;
  return handleRemoveInstallation(request, id, connectionsDeps());
}
