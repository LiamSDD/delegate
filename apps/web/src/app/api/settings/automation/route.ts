import { handleUpdateAutomation } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export function PUT(request: Request): Promise<Response> {
  return handleUpdateAutomation(request, connectionsDeps());
}
