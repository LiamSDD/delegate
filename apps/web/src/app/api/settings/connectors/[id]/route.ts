import { handleDeleteConnector, handleRefreshConnector } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export const maxDuration = 60;

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/settings/connectors/[id]">,
) {
  const { id } = await context.params;
  return handleDeleteConnector(request, id, connectionsDeps());
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/settings/connectors/[id]">,
) {
  const { id } = await context.params;
  return handleRefreshConnector(request, id, connectionsDeps());
}
