import { randomUUID } from "node:crypto";

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  type ErrorEnvelope,
  REQUEST_ID_HEADER,
} from "@delegate/sdk/contract";
import { z } from "zod";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export class V1Error extends Error {
  override readonly name = "V1Error";
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly extra: { issues?: string[]; headers?: Record<string, string> } = {},
  ) {
    super(message);
  }
}

export function newRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

export function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

export function errorResponse(
  requestId: string,
  error: V1Error,
  headers: Record<string, string> = {},
): Response {
  const body: ErrorEnvelope = {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.extra.issues === undefined ? {} : { issues: error.extra.issues }),
    },
  };
  return Response.json(body, {
    status: API_ERROR_STATUS[error.code],
    headers: { ...NO_STORE, ...headers, ...error.extra.headers, [REQUEST_ID_HEADER]: requestId },
  });
}

const LegacyErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.string()).optional(),
  }),
});

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return status >= 500 ? "internal" : "invalid_request";
}

export async function fromLegacyResponse(response: Response): Promise<V1Error> {
  const parsed = LegacyErrorSchema.safeParse(await response.json().catch(() => null));
  const known = (API_ERROR_CODES as readonly string[]).includes(
    parsed.success ? parsed.data.error.code : "",
  );
  const code =
    parsed.success && known
      ? (parsed.data.error.code as ApiErrorCode)
      : codeForStatus(response.status);
  const retryAfter = response.headers.get("retry-after");
  return new V1Error(
    code,
    parsed.success ? parsed.data.error.message : "The request could not be completed.",
    {
      ...(parsed.success && parsed.data.error.issues !== undefined
        ? { issues: parsed.data.error.issues }
        : {}),
      ...(retryAfter === null ? {} : { headers: { "Retry-After": retryAfter } }),
    },
  );
}
