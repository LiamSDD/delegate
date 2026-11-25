import { handleCreateToken } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export function POST(request: Request): Promise<Response> {
  return handleCreateToken(request, connectionsDeps());
}
