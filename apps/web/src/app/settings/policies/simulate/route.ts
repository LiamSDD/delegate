import { handleSimulatePolicy } from "@/server/control/policies";
import { apiDeps } from "@/server/deps";

export function POST(request: Request): Promise<Response> {
  return handleSimulatePolicy(request, apiDeps(), process.env);
}
