import { handleGithubSetup } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export function GET(request: Request): Promise<Response> {
  return handleGithubSetup(request, connectionsDeps());
}
