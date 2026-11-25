import { handleGithubConnect } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";

export function GET(request: Request): Promise<Response> {
  return handleGithubConnect(request, connectionsDeps());
}
