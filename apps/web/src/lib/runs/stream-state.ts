import type { RunEvent } from "@delegate/runtime";

export type StreamPhase =
  "connecting" | "replaying" | "live" | "ended" | "reconnecting" | "disconnected" | "not_found";

export interface StreamState {
  phase: StreamPhase;
  replayCount: number | null;
  attempt: number;
  retryInMs: number | null;
}

export type StreamAction =
  | { type: "connecting" }
  | { type: "replay"; count: number }
  | { type: "live" }
  | { type: "ended" }
  | { type: "dropped" }
  | { type: "manual_retry" }
  | { type: "not_found" };

export const MAX_AUTO_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export const initialStreamState: StreamState = {
  phase: "connecting",
  replayCount: null,
  attempt: 0,
  retryInMs: null,
};

export function reconnectDelayMs(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  if (state.phase === "ended" || state.phase === "not_found") {
    return action.type === "manual_retry" ? { ...initialStreamState } : state;
  }
  switch (action.type) {
    case "connecting":
      return { ...state, phase: "connecting", retryInMs: null };
    case "replay":
      return { ...state, phase: "replaying", replayCount: action.count, retryInMs: null };
    case "live":
      return { ...state, phase: "live", attempt: 0, retryInMs: null };
    case "ended":
      return { ...state, phase: "ended", retryInMs: null };
    case "not_found":
      return { ...state, phase: "not_found", retryInMs: null };
    case "manual_retry":
      return { ...initialStreamState };
    case "dropped": {
      const attempt = state.attempt + 1;
      if (attempt > MAX_AUTO_RETRIES) {
        return { ...state, phase: "disconnected", attempt, retryInMs: null };
      }
      return { ...state, phase: "reconnecting", attempt, retryInMs: reconnectDelayMs(attempt) };
    }
  }
}

export function appendUnique(
  current: readonly RunEvent[],
  incoming: readonly RunEvent[],
): RunEvent[] {
  const next = [...current];
  let lastSeq = current.at(-1)?.seq ?? 0;
  for (const event of incoming) {
    if (event.seq <= lastSeq) continue;
    next.push(event);
    lastSeq = event.seq;
  }
  return next;
}
