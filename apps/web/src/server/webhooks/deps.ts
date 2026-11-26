import { apiDeps } from "../deps";
import { type WebhookSettingsDeps, webhookTestLimiter } from "./settings-api";

export function webhookSettingsDeps(): WebhookSettingsDeps {
  return { api: apiDeps(), testLimiter: webhookTestLimiter() };
}
