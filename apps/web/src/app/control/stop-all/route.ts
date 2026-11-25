import { handleStopAllRuns } from "@/server/control/switches";
import { apiDeps } from "@/server/deps";

export const maxDuration = 120;

export function POST(request: Request): Promise<Response> {
  return handleStopAllRuns(request, apiDeps());
}
