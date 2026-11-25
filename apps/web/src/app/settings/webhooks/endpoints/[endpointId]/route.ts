import { webhookSettingsDeps } from "@/server/webhooks/deps";
import { handleDeleteWebhookEndpoint } from "@/server/webhooks/settings-api";

export async function DELETE(
  request: Request,
  context: RouteContext<"/settings/webhooks/endpoints/[endpointId]">,
): Promise<Response> {
  const { endpointId } = await context.params;
  return handleDeleteWebhookEndpoint(request, endpointId, webhookSettingsDeps());
}
