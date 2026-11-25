import { classifyAddress, type ResolveDns } from "@delegate/runtime/security";
import {
  ConnectorUrlError,
  type ConnectorUrlProblem,
  validateConnectorUrl,
} from "@delegate/runtime/server";

export type WebhookUrlProblem = ConnectorUrlProblem | "unresolvable" | "private_address";

export class WebhookUrlError extends Error {
  override readonly name = "WebhookUrlError";
  constructor(
    readonly problem: WebhookUrlProblem,
    message: string,
  ) {
    super(message);
  }
}

const REASONS: Record<ConnectorUrlProblem, string> = {
  invalid_url: "it is not a valid absolute URL",
  too_long: "it is longer than 2,048 characters",
  https_required: "it must start with https://",
  scheme: "it must start with https://",
  credentials: "it must not contain a user name or password",
  port: "only the default https port is allowed",
  blocked_host: "its host is an IP address or a local, internal or metadata name",
};

export function validateWebhookUrl(raw: string): URL {
  try {
    return validateConnectorUrl(raw, { production: true });
  } catch (error) {
    if (!(error instanceof ConnectorUrlError)) throw error;
    throw new WebhookUrlError(
      error.problem,
      `The webhook URL is not allowed: ${REASONS[error.problem]}.`,
    );
  }
}

export async function assertPublicHost(url: URL, resolveDns: ResolveDns): Promise<void> {
  let addresses: string[];
  try {
    addresses = await resolveDns(url.hostname);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0)
    throw new WebhookUrlError(
      "unresolvable",
      `The webhook host ${url.hostname} could not be resolved.`,
    );
  if (addresses.some((address) => !classifyAddress(address).allowed))
    throw new WebhookUrlError(
      "private_address",
      `The webhook host ${url.hostname} resolves to a private, loopback, link-local or metadata address.`,
    );
}
