import { z } from "zod";

export const API_ERROR_STATUS = {
  invalid_request: 400,
  invalid_json: 400,
  invalid_url: 400,
  invalid_idempotency_key: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  run_finished: 409,
  no_pending_plan: 409,
  idempotency_in_progress: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as [ApiErrorCode, ...ApiErrorCode[]];

export const API_ERROR_MEANINGS: Record<ApiErrorCode, string> = {
  invalid_request: "The path, query or body does not match the contract; `issues` lists why.",
  invalid_json: "The request body is not valid JSON.",
  invalid_url: "The target URL is not a public company website or GitHub repository.",
  invalid_idempotency_key: "The Idempotency-Key header is empty, too long or not printable ASCII.",
  unauthorized: "The bearer token is missing, malformed, unknown or revoked.",
  forbidden: "The token's user is not allowed to do this.",
  not_found: "Nothing with that id is visible to this token's workspace.",
  run_finished: "The run already reached a terminal state.",
  no_pending_plan: "The run has no plan waiting for a decision.",
  idempotency_in_progress: "A request with this Idempotency-Key is still being processed.",
  payload_too_large: "The request body is larger than this operation accepts.",
  unsupported_media_type: "The request body must be application/json.",
  idempotency_key_reused: "This Idempotency-Key was already used with a different request.",
  rate_limited: "A request or run quota is used up; Retry-After says when to try again.",
  internal: "The server failed; quote the requestId when reporting it.",
  unavailable: "A dependency (model capacity, the knowledge store) is unavailable right now.",
};

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: ApiErrorCodeSchema.describe("Stable machine-readable code."),
      message: z.string().describe("Human-readable explanation; wording may change."),
      requestId: z.string().describe("Also sent as the X-Request-Id response header."),
      issues: z
        .array(z.string())
        .optional()
        .describe("Validation problems, one per entry, as `path: problem`."),
    }),
  })
  .describe("The body of every non-2xx response.");
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const LooseErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    issues: z.array(z.string()).optional(),
  }),
});
