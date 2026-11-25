import { webhookSettingsDeps } from "@/server/webhooks/deps";
import { handleTestWebhookEndpoint } from "@/server/webhooks/settings-api";

export const maxDuration = 30;

export async function POST(
  request: Request,
  context: RouteContext<"/settings/webhooks/endpoints/[endpointId]/test">,
): Promise<Response> {
  const { endpointId } = await context.params;
  return handleTestWebhookEndpoint(request, endpointId, webhookSettingsDeps());
}
