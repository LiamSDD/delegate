import { apiDeps } from "@/server/deps";
import { handleCreateShipRun } from "@/server/ship-api";

export const maxDuration = 300;

export async function POST(request: Request) {
  return handleCreateShipRun(request, apiDeps());
}
