import { exportLimiter, handleExportData } from "@/server/data/export";
import { apiDeps } from "@/server/deps";

export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return handleExportData(request, { ...apiDeps(), exportLimiter: exportLimiter() });
}
