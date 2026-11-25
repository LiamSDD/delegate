import { RunEventSchema, type RunEventDraft } from "../events";
import { redactEventDraft } from "../privacy/redact";

export type EmitFn = (event: RunEventDraft) => Promise<void>;

export interface RunEmitter {
  emit(event: RunEventDraft): Promise<void>;
  queue(event: RunEventDraft): void;
  flush(): Promise<void>;
}

const VALIDATION_ENVELOPE = { seq: 0, at: "1970-01-01T00:00:00.000Z" };

function validated(input: RunEventDraft): RunEventDraft {
  const event = redactEventDraft(input);
  RunEventSchema.parse({ ...event, ...VALIDATION_ENVELOPE });
  return event;
}

export function createRunEmitter(deliver: EmitFn): RunEmitter {
  let tail: Promise<void> = Promise.resolve();
  let failure: unknown;
  let failed = false;

  const enqueue = (event: RunEventDraft): Promise<void> => {
    const next = tail.then(() => deliver(event));
    tail = next.catch((error: unknown) => {
      if (!failed) {
        failed = true;
        failure = error;
      }
    });
    return next;
  };

  return {
    emit(event) {
      try {
        return enqueue(validated(event));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    queue(event) {
      try {
        void enqueue(validated(event)).catch(() => undefined);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    },
    async flush() {
      await tail;
      if (failed) throw failure instanceof Error ? failure : new Error(String(failure));
    },
  };
}

export class TextCoalescer {
  private buffer = "";
  private lastFlush: number;

  constructor(
    private readonly sink: (text: string) => void,
    private readonly now: () => number,
    private readonly intervalMs = 250,
  ) {
    this.lastFlush = now();
  }

  push(text: string): void {
    this.buffer += text;
    if (this.now() - this.lastFlush >= this.intervalMs) this.flush();
  }

  flush(): void {
    this.lastFlush = this.now();
    if (this.buffer === "") return;
    const text = this.buffer;
    this.buffer = "";
    this.sink(text);
  }
}
