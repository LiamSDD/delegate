import { type Run } from "./contract/schemas";

export interface DelegateApiErrorDetails {
  requestId?: string | null;
  issues?: readonly string[];
  retryAfterMs?: number | null;
}

export class DelegateApiError extends Error {
  override readonly name = "DelegateApiError";
  readonly requestId: string | null;
  readonly issues: readonly string[];
  readonly retryAfterMs: number | null;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    details: DelegateApiErrorDetails = {},
  ) {
    super(message);
    this.requestId = details.requestId ?? null;
    this.issues = details.issues ?? [];
    this.retryAfterMs = details.retryAfterMs ?? null;
  }

  get retryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 503 ||
      this.status === 502 ||
      this.status === 504 ||
      this.code === "idempotency_in_progress"
    );
  }
}

export class DelegateConnectionError extends Error {
  override readonly name = "DelegateConnectionError";
}

export class DelegateResponseError extends Error {
  override readonly name = "DelegateResponseError";
  constructor(
    readonly operation: string,
    readonly issues: readonly string[],
    readonly requestId: string | null,
  ) {
    super(
      `Delegate answered ${operation} with a body that does not match the v1 contract: ${issues.slice(0, 3).join("; ")}`,
    );
  }
}

export class DelegateTimeoutError extends Error {
  override readonly name = "DelegateTimeoutError";
  constructor(
    readonly runId: string,
    readonly timeoutMs: number,
    readonly lastRun: Run | null,
  ) {
    super(
      `Run ${runId} did not reach the awaited state within ${Math.round(timeoutMs / 1000)} s${
        lastRun === null ? "" : ` (last status: ${lastRun.status})`
      }.`,
    );
  }
}

export function isDelegateApiError(error: unknown, code?: string): error is DelegateApiError {
  return error instanceof DelegateApiError && (code === undefined || error.code === code);
}
