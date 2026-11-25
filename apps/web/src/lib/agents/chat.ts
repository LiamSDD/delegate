import type { AnswerEvent, ChatTurn, CitationRef, RefusalReason } from "@/lib/m3-contract";

export type IndexedCitation = CitationRef & { index: number };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  text: string;
  citations: IndexedCitation[];
  refusal: { reason: RefusalReason; message: string; contactUrl?: string } | null;
  status: "streaming" | "done" | "error";
  error: string | null;
  durationMs?: number;
  servedBy?: { provider: string; model: string };
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface SseFrame {
  event: string;
  data: string;
}

export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) frames.push({ event, data: data.join("\n") });
      boundary = buffer.indexOf("\n\n");
    }
    return frames;
  };
}

function withCitation(citations: IndexedCitation[], next: IndexedCitation): IndexedCitation[] {
  if (citations.some((citation) => citation.index === next.index)) return citations;
  return [...citations, next].sort((a, b) => a.index - b.index);
}

export function applyAnswerEvent(message: AssistantMessage, event: AnswerEvent): AssistantMessage {
  switch (event.type) {
    case "delta":
      return { ...message, text: message.text + event.text };
    case "citation": {
      const { type: _type, ...citation } = event;
      return { ...message, citations: withCitation(message.citations, citation) };
    }
    case "refusal":
      return {
        ...message,
        refusal: {
          reason: event.reason,
          message: event.message,
          ...(event.contactUrl === undefined ? {} : { contactUrl: event.contactUrl }),
        },
      };
    case "done": {
      const citations = event.citations.reduce(withCitation, message.citations);
      return {
        ...message,
        text: message.text === "" && !event.refused ? event.answer : message.text,
        citations,
        status: "done",
        durationMs: event.durationMs,
        ...(event.servedBy === undefined ? {} : { servedBy: event.servedBy }),
      };
    }
  }
}

export type AnswerSegment =
  { kind: "text"; text: string } | { kind: "cite"; citation: IndexedCitation };

const MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

export function splitAnswer(text: string, citations: readonly IndexedCitation[]): AnswerSegment[] {
  const byIndex = new Map(citations.map((citation) => [citation.index, citation]));
  const segments: AnswerSegment[] = [];
  const pushText = (value: string) => {
    if (value === "") return;
    const last = segments.at(-1);
    if (last?.kind === "text")
      segments[segments.length - 1] = { kind: "text", text: last.text + value };
    else segments.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(MARKER)) {
    const indexes = (match[1] ?? "").split(",").map((part) => Number(part.trim()));
    const resolved = indexes.map((index) => byIndex.get(index));
    pushText(text.slice(cursor, match.index));
    if (resolved.every((citation) => citation !== undefined)) {
      for (const citation of resolved) segments.push({ kind: "cite", citation });
    } else {
      pushText(match[0]);
    }
    cursor = match.index + match[0].length;
  }
  pushText(text.slice(cursor));
  return segments;
}

export function historyFor(messages: readonly ChatMessage[], maxTurns = 6): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const question = messages[index];
    const answer = messages[index + 1];
    if (question?.role !== "user" || answer?.role !== "assistant") continue;
    if (answer.status !== "done" || answer.refusal !== null || answer.text === "") continue;
    turns.push(
      { role: "user", content: question.text },
      { role: "assistant", content: answer.text },
    );
  }
  const kept = turns.slice(-Math.max(0, maxTurns - (maxTurns % 2)));
  return kept;
}

export const REFUSAL_COPY: Record<RefusalReason, string> = {
  not_in_sources: "Not in the sources",
  no_sources: "No sources indexed",
  ungrounded: "Answer withheld: not supported by sources",
  rate_limited: "Rate limited",
  unavailable: "Free model capacity unavailable",
  invalid_request: "Request not accepted",
};
