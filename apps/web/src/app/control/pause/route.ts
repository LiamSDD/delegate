import { handleSetRunsPaused } from "@/server/control/switches";
import { apiDeps } from "@/server/deps";

export function POST(request: Request): Promise<Response> {
  return handleSetRunsPaused(request, apiDeps());
}
