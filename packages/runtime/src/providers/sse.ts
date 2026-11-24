export interface SseMessage {
  event: string | undefined;
  data: string;
}

export const SSE_DEFAULT_LIMITS = {
  maxLineChars: 1_048_576,
  maxEventChars: 1_048_576,
  maxBodyBytes: 16 * 1_048_576,
} as const;

export interface SseOptions {
  maxLineChars?: number;
  maxEventChars?: number;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export class SseLimitError extends Error {
  override readonly name = "SseLimitError";
  constructor(
    readonly limit: "line" | "event" | "body",
    readonly max: number,
  ) {
    super(`SSE ${limit} exceeded ${max}`);
  }
}

export class SseTimeoutError extends Error {
  override readonly name = "SseTimeoutError";
  constructor(
    readonly kind: "idle" | "total",
    readonly timeoutMs: number,
  ) {
    super(`SSE ${kind} timeout after ${timeoutMs} ms`);
  }
}

const LF = 10;
const CR = 13;

export class SseLineSplitter {
  private pieces: string[] = [];
  private pendingChars = 0;
  private skipLineFeed = false;
  scannedChars = 0;

  constructor(private readonly maxLineChars: number = SSE_DEFAULT_LIMITS.maxLineChars) {}

  push(text: string, final = false): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      this.scannedChars += 1;
      const code = text.charCodeAt(index);
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (code === LF) {
          start = index + 1;
          continue;
        }
      }
      if (code !== LF && code !== CR) continue;
      this.append(text.slice(start, index));
      lines.push(this.take());
      start = index + 1;
      this.skipLineFeed = code === CR;
    }
    this.append(text.slice(start));
    if (final && this.pendingChars > 0) lines.push(this.take());
    return lines;
  }

  private append(segment: string): void {
    if (segment === "") return;
    this.pendingChars += segment.length;
    if (this.pendingChars > this.maxLineChars) throw new SseLimitError("line", this.maxLineChars);
    this.pieces.push(segment);
  }

  private take(): string {
    const line = this.pieces.join("");
    this.pieces = [];
    this.pendingChars = 0;
    return line;
  }
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

export interface TimedReader {
  read(): ReturnType<Reader["read"]>;
}

export function timedReader(
  reader: Reader,
  timeouts: { idleTimeoutMs?: number | undefined; totalTimeoutMs?: number | undefined },
): TimedReader {
  const deadline =
    timeouts.totalTimeoutMs === undefined ? undefined : Date.now() + timeouts.totalTimeoutMs;
  return {
    async read() {
      const idle = timeouts.idleTimeoutMs;
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      let kind: "idle" | "total" | undefined;
      let waitMs = Number.POSITIVE_INFINITY;
      if (idle !== undefined) {
        kind = "idle";
        waitMs = idle;
      }
      if (remaining !== undefined && remaining < waitMs) {
        kind = "total";
        waitMs = remaining;
      }
      if (kind === undefined) return reader.read();
      const error =
        kind === "idle"
          ? new SseTimeoutError("idle", idle ?? 0)
          : new SseTimeoutError("total", timeouts.totalTimeoutMs ?? 0);
      if (waitMs <= 0) throw error;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(error);
        }, waitMs);
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  idleTimeoutMs?: number,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const timed = timedReader(reader, { idleTimeoutMs });
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (received < maxBytes) {
      const chunk = await timed.read();
      if (chunk.done) break;
      const slice = chunk.value.subarray(0, maxBytes - received);
      received += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
    }
  } catch {
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): AsyncGenerator<SseMessage> {
  const maxEventChars = options.maxEventChars ?? SSE_DEFAULT_LIMITS.maxEventChars;
  const maxBodyBytes = options.maxBodyBytes ?? SSE_DEFAULT_LIMITS.maxBodyBytes;
  const reader = body.getReader();
  const timed = timedReader(reader, options);
  const decoder = new TextDecoder();
  const splitter = new SseLineSplitter(options.maxLineChars ?? SSE_DEFAULT_LIMITS.maxLineChars);
  let event: string | undefined;
  let data: string[] = [];
  let eventChars = 0;
  let bodyBytes = 0;

  const handleLine = (line: string): SseMessage | undefined => {
    if (line === "") {
      const message = data.length > 0 ? { event, data: data.join("\n") } : undefined;
      event = undefined;
      data = [];
      eventChars = 0;
      return message;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") {
      eventChars += content.length + 1;
      if (eventChars > maxEventChars) throw new SseLimitError("event", maxEventChars);
      data.push(content);
    } else if (field === "event") event = content;
    return undefined;
  };

  let done = false;
  try {
    while (!done) {
      const chunk = await timed.read();
      done = chunk.done;
      if (!chunk.done) {
        bodyBytes += chunk.value.byteLength;
        if (bodyBytes > maxBodyBytes) throw new SseLimitError("body", maxBodyBytes);
      }
      const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (const line of splitter.push(text, done)) {
        const message = handleLine(line);
        if (message !== undefined) yield message;
      }
    }
    const last = handleLine("");
    if (last !== undefined) yield last;
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
