export const RUNS_PAUSED_SQLSTATE = "DG001";

export const RUNS_PAUSED_MESSAGE =
  "New runs are paused for this workspace. Resume them in Mission Control (/control) to start runs again.";

export function isRunsPausedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if ((current as Error & { code?: unknown }).code === RUNS_PAUSED_SQLSTATE) return true;
    current = current.cause;
  }
  return false;
}

export function pausedBefore(step: string): string {
  return `Stopped before ${step}: new runs are paused for this workspace. Resume them in Mission Control, then start the next step by hand.`;
}
