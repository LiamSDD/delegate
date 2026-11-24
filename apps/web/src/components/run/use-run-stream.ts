"use client";

import { parseRunEvent, RUN_EVENT_TYPES, type RunEvent } from "@delegate/runtime";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { z } from "zod";

import {
  appendUnique,
  initialStreamState,
  MAX_AUTO_RETRIES,
  reconnectDelayMs,
  type StreamState,
  streamReducer,
} from "@/lib/runs/stream-state";

const replaySchema = z.object({ count: z.int().nonnegative() });
const summarySchema = z.object({ run: z.object({ terminal: z.boolean(), eventCount: z.int() }) });

export interface RunStream {
  events: RunEvent[];
  stream: StreamState;
  liveFromSeq: number | null;
  malformed: number;
  reconnect: () => void;
}

export function useRunStream(runId: string): RunStream {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [stream, dispatch] = useReducer(streamReducer, initialStreamState);
  const [generation, setGeneration] = useState(0);
  const [liveFromSeq, setLiveFromSeq] = useState<number | null>(null);
  const [malformed, setMalformed] = useState(0);
  const lastSeq = useRef(0);
  const attempts = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    let buffer: RunEvent[] = [];
    let disposed = false;

    const flush = () => {
      frame = null;
      const batch = buffer;
      buffer = [];
      if (batch.length > 0) setEvents((current) => appendUnique(current, batch));
    };
    const flushNow = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
    };

    const onRunEvent = (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = parseRunEvent(JSON.parse(message.data));
      } catch {
        setMalformed((count) => count + 1);
        return;
      }
      if (event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      buffer.push(event);
      frame ??= requestAnimationFrame(flush);
    };

    const scheduleReconnect = () => {
      attempts.current += 1;
      dispatch({ type: "dropped" });
      if (attempts.current > MAX_AUTO_RETRIES) return;
      retryTimer = setTimeout(connect, reconnectDelayMs(attempts.current));
    };

    const onClosed = async () => {
      flushNow();
      try {
        const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (disposed) return;
        if (response.status === 404) {
          dispatch({ type: "not_found" });
          return;
        }
        const summary = summarySchema.safeParse(await response.json());
        if (
          summary.success &&
          summary.data.run.terminal &&
          lastSeq.current >= summary.data.run.eventCount
        ) {
          dispatch({ type: "ended" });
          return;
        }
      } catch {
        if (disposed) return;
      }
      scheduleReconnect();
    };

    function connect() {
      if (disposed) return;
      dispatch({ type: "connecting" });
      const query = lastSeq.current > 0 ? `?after=${lastSeq.current}` : "";
      const next = new EventSource(`/api/runs/${runId}/events${query}`);
      source = next;
      for (const type of RUN_EVENT_TYPES) next.addEventListener(type, onRunEvent);
      next.addEventListener("stream.replay", (message: MessageEvent<string>) => {
        const parsed = replaySchema.safeParse(JSON.parse(message.data));
        dispatch({ type: "replay", count: parsed.success ? parsed.data.count : 0 });
      });
      next.addEventListener("stream.live", () => {
        flushNow();
        attempts.current = 0;
        setLiveFromSeq((current) => current ?? lastSeq.current);
        dispatch({ type: "live" });
      });
      next.addEventListener("stream.end", () => {
        flushNow();
        next.close();
        dispatch({ type: "ended" });
      });
      next.addEventListener("stream.error", () => {
        next.close();
        void onClosed();
      });
      next.onerror = () => {
        if (next.readyState === EventSource.CLOSED) {
          void onClosed();
          return;
        }
        attempts.current += 1;
        if (attempts.current > MAX_AUTO_RETRIES) {
          next.close();
        }
        dispatch({ type: "dropped" });
      };
    }

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      source?.close();
    };
  }, [runId, generation]);

  const reconnect = useCallback(() => {
    attempts.current = 0;
    dispatch({ type: "manual_retry" });
    setGeneration((value) => value + 1);
  }, []);

  return { events, stream, liveFromSeq, malformed, reconnect };
}
