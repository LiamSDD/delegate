import { parseRunEvent, type RunEvent, type RunEventDraft } from "@delegate/runtime";

export interface MemorySink {
  events: RunEvent[];
  emit: (draft: RunEventDraft) => Promise<void>;
}

export function createMemorySink(now: () => Date = () => new Date()): MemorySink {
  const events: RunEvent[] = [];
  return {
    events,
    emit(draft) {
      try {
        events.push(parseRunEvent({ ...draft, seq: events.length + 1, at: now().toISOString() }));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export function serialiseEventLog(events: readonly RunEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export function parseEventLog(text: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(parseRunEvent(JSON.parse(line) as unknown));
    } catch (error) {
      throw new Error(
        `Event log line ${index + 1} is invalid: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}`,
        { cause: error },
      );
    }
  }
  return events;
}
