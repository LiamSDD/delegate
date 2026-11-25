import { webhookSettingsDeps } from "@/server/webhooks/deps";
import { handleRotateWebhookSecret } from "@/server/webhooks/settings-api";

export async function POST(
  request: Request,
  context: RouteContext<"/settings/webhooks/endpoints/[endpointId]/rotate">,
): Promise<Response> {
  const { endpointId } = await context.params;
  return handleRotateWebhookSecret(request, endpointId, webhookSettingsDeps());
}
