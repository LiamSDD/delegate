import { handleDeleteData } from "@/server/data/delete";
import { apiDeps } from "@/server/deps";

export const maxDuration = 120;

export function POST(request: Request): Promise<Response> {
  return handleDeleteData(request, apiDeps());
}
