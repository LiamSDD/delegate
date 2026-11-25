import type { RunEvent } from "@delegate/runtime";

export const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export const MAX_REPLAY_GAP_MS = 2000;
export const MIN_REPLAY_FRAME_MS = 30;

export interface ReplayState {
  active: boolean;
  playing: boolean;
  cursor: number;
  speed: ReplaySpeed;
}

export type ReplayAction =
  | { type: "start"; total: number }
  | { type: "toggle"; total: number }
  | { type: "tick"; total: number }
  | { type: "seek"; cursor: number; total: number }
  | { type: "speed"; speed: ReplaySpeed }
  | { type: "exit" };

export const initialReplayState: ReplayState = {
  active: false,
  playing: false,
  cursor: 0,
  speed: 4,
};

function clampCursor(cursor: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.max(1, Math.round(cursor)));
}

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "start":
      if (action.total === 0) return state;
      return { ...state, active: true, playing: action.total > 1, cursor: 1 };
    case "toggle":
      if (!state.active) return state;
      if (state.playing) return { ...state, playing: false };
      if (state.cursor >= action.total) return { ...state, playing: action.total > 1, cursor: 1 };
      return { ...state, playing: true };
    case "tick": {
      if (!state.active || !state.playing) return state;
      const cursor = clampCursor(state.cursor + 1, action.total);
      return { ...state, cursor, playing: cursor < action.total };
    }
    case "seek":
      if (!state.active) return state;
      return {
        ...state,
        cursor: clampCursor(action.cursor, action.total),
        playing: state.playing && clampCursor(action.cursor, action.total) < action.total,
      };
    case "speed":
      return { ...state, speed: action.speed };
    case "exit":
      return { ...initialReplayState, speed: state.speed };
  }
}

export function replayDelayMs(previous: RunEvent, next: RunEvent, speed: ReplaySpeed): number {
  const gap = Date.parse(next.at) - Date.parse(previous.at);
  const bounded = Number.isFinite(gap) ? Math.min(MAX_REPLAY_GAP_MS, Math.max(0, gap)) : 0;
  return Math.max(MIN_REPLAY_FRAME_MS, Math.round(bounded / speed));
}

export interface ReplayMarker {
  cursor: number;
  label: string;
  kind: "step" | "end";
}

export function replayMarkers(events: readonly RunEvent[]): ReplayMarker[] {
  const seen = new Set<string>();
  const markers: ReplayMarker[] = [];
  events.forEach((event, index) => {
    if (event.type === "step.started" && !seen.has(event.stepId)) {
      seen.add(event.stepId);
      markers.push({ cursor: index + 1, label: event.stepId, kind: "step" });
    }
    if (event.type === "run.completed" || event.type === "run.failed")
      markers.push({
        cursor: index + 1,
        label: event.type === "run.completed" ? "done" : "failed",
        kind: "end",
      });
  });
  return markers;
}

export function replayFrame(events: readonly RunEvent[], state: ReplayState): RunEvent[] {
  if (!state.active) return [...events];
  return events.slice(0, clampCursor(state.cursor, events.length));
}

export function replayClock(events: readonly RunEvent[], state: ReplayState): number | null {
  if (!state.active) return null;
  const last = events[clampCursor(state.cursor, events.length) - 1];
  return last === undefined ? null : Date.parse(last.at);
}
