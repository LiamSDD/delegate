import { webhookSettingsDeps } from "@/server/webhooks/deps";
import { handleAddWebhookEndpoint, handleWebhooksOverview } from "@/server/webhooks/settings-api";

export function GET(request: Request): Promise<Response> {
  return handleWebhooksOverview(request, webhookSettingsDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleAddWebhookEndpoint(request, webhookSettingsDeps());
}
