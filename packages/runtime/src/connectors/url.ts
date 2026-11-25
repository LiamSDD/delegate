import { FetchBlockedError, validateFetchUrl } from "../tools/fetch";

export const CONNECTOR_URL_MAX_CHARS = 2048;

export type ConnectorUrlProblem =
  | "invalid_url"
  | "too_long"
  | "https_required"
  | "blocked_host"
  | "credentials"
  | "port"
  | "scheme";

export class ConnectorUrlError extends Error {
  override readonly name = "ConnectorUrlError";
  constructor(
    readonly problem: ConnectorUrlProblem,
    message: string,
  ) {
    super(message);
  }
}

const PROBLEM_FOR_FETCH_CODE: Partial<Record<FetchBlockedError["code"], ConnectorUrlProblem>> = {
  invalid_url: "invalid_url",
  scheme: "scheme",
  credentials: "credentials",
  port: "port",
};

export function validateConnectorUrl(raw: string, options: { production: boolean }): URL {
  const trimmed = raw.trim();
  if (trimmed.length > CONNECTOR_URL_MAX_CHARS)
    throw new ConnectorUrlError("too_long", "The connector URL is too long.");
  let url: URL;
  try {
    url = validateFetchUrl(trimmed);
  } catch (error) {
    if (!(error instanceof FetchBlockedError)) throw error;
    throw new ConnectorUrlError(
      PROBLEM_FOR_FETCH_CODE[error.code] ?? "blocked_host",
      `The connector URL is not allowed: ${error.message}.`,
    );
  }
  if (options.production && url.protocol !== "https:")
    throw new ConnectorUrlError("https_required", "Connector URLs must use https.");
  url.hash = "";
  return url;
}

export function refuseRedirects(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ConnectorUrlError(
        "blocked_host",
        "The connector answered with a redirect, which is not followed.",
      );
    }
    return response;
  };
}
