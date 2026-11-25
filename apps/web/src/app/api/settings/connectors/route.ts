import { handleAddConnector } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleAddConnector(request, connectionsDeps());
}
