import type { RunEvent } from "@delegate/runtime";

import { isTerminalEventType, REPLAY_PAGE_SIZE } from "./runs";

export const POLL_INTERVAL_MS = 250;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const CLIENT_RETRY_MS = 2000;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function formatSseEvent(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function controlFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function parseResumeSeq(lastEventId: string | null, after: string | null): number {
  for (const candidate of [lastEventId, after]) {
    if (candidate !== null && /^\d{1,9}$/.test(candidate.trim())) {
      return Number.parseInt(candidate.trim(), 10);
    }
  }
  return 0;
}

export interface RunStreamSource {
  load(afterSeq: number): Promise<RunEvent[]>;
  onIdle?(): Promise<void>;
}

export interface RunStreamOptions {
  source: RunStreamSource;
  afterSeq: number;
  signal: AbortSignal;
  pollMs?: number;
  heartbeatMs?: number;
  idleHookMs?: number;
  replayPageSize?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createRunEventStream(options: RunStreamOptions): ReadableStream<Uint8Array> {
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const idleHookMs = options.idleHookMs ?? HEARTBEAT_INTERVAL_MS;
  const pageSize = options.replayPageSize ?? REPLAY_PAGE_SIZE;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  const { signal, source } = options;
  const lifecycle = { cancelled: false };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastWrite = now();
      let lastIdle = now();
      let seq = options.afterSeq;
      const progress = { terminal: false };
      const write = (text: string) => {
        controller.enqueue(encoder.encode(text));
        lastWrite = now();
      };
      const writeEvents = (events: readonly RunEvent[]) => {
        for (const event of events) {
          if (progress.terminal) break;
          write(formatSseEvent(event));
          seq = event.seq;
          if (isTerminalEventType(event.type)) progress.terminal = true;
        }
      };
      const stopped = () => lifecycle.cancelled || signal.aborted;

      try {
        write(`retry: ${CLIENT_RETRY_MS}\n\n`);
        const replay: RunEvent[] = [];
        for (;;) {
          const page = await source.load(replay.at(-1)?.seq ?? seq);
          replay.push(...page);
          if (page.length < pageSize) break;
        }
        write(controlFrame("stream.replay", { count: replay.length }));
        writeEvents(replay);
        if (!progress.terminal) write(controlFrame("stream.live", {}));

        while (!progress.terminal && !stopped()) {
          await sleep(pollMs, signal);
          if (stopped()) break;
          writeEvents(await source.load(seq));
          if (now() - lastWrite >= heartbeatMs) write(": heartbeat\n\n");
          if (source.onIdle !== undefined && now() - lastIdle >= idleHookMs) {
            lastIdle = now();
            await source.onIdle();
          }
        }
        if (progress.terminal) write(controlFrame("stream.end", { seq }));
      } catch (error: unknown) {
        if (!stopped()) {
          write(
            controlFrame("stream.error", { message: "The event stream failed on the server." }),
          );
          console.error("run event stream failed", error);
        }
      } finally {
        if (!lifecycle.cancelled) controller.close();
      }
    },
    cancel() {
      lifecycle.cancelled = true;
    },
  });
}
