"use client";

import { ArrowUp, CircleSlash, MessageSquarePlus, Square, TriangleAlert } from "lucide-react";
import {
  type SyntheticEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import {
  applyAnswerEvent,
  type AssistantMessage,
  type ChatMessage,
  createSseParser,
  historyFor,
  REFUSAL_COPY,
  splitAnswer,
} from "@/lib/agents/chat";
import { AGENT_COMMAND_EVENT } from "@/lib/commands";
import type { AnswerEvent } from "@/lib/m3-contract";
import { hostOf } from "@/lib/runs/build-agent";
import { cn } from "@/lib/utils";

import { CitationPopover } from "./citation-popover";

const errorBody = z.object({ error: z.object({ message: z.string() }) });

function newId(): string {
  return crypto.randomUUID();
}

function parseAnswerEvent(data: string): AnswerEvent | null {
  try {
    const value = JSON.parse(data) as { type?: unknown };
    if (
      value.type === "delta" ||
      value.type === "citation" ||
      value.type === "refusal" ||
      value.type === "done"
    )
      return value as AnswerEvent;
    return null;
  } catch {
    return null;
  }
}

export function useAssistantChat(endpoint: string, maxQuestion: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const patch = useCallback(
    (id: string, update: (message: AssistantMessage) => AssistantMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.role === "assistant" && message.id === id ? update(message) : message,
        ),
      );
    },
    [],
  );

  const send = useCallback(
    async (raw: string) => {
      const question = raw.trim().slice(0, maxQuestion);
      if (question === "" || controller.current !== null) return;
      const history = historyFor(messages);
      const answerId = newId();
      setMessages((current) => [
        ...current,
        { id: newId(), role: "user", text: question },
        {
          id: answerId,
          role: "assistant",
          text: "",
          citations: [],
          refusal: null,
          status: "streaming",
          error: null,
        },
      ]);
      const abort = new AbortController();
      controller.current = abort;
      setStreaming(true);
      const fail = (error: string) => {
        patch(answerId, (message) => ({ ...message, status: "error", error }));
      };
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, history }),
          signal: abort.signal,
        });
        if (!response.ok || response.body === null) {
          const body = errorBody.safeParse(await response.json().catch(() => null));
          const retry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
          fail(
            (body.success ? body.data.error.message : `HTTP ${String(response.status)}`) +
              (Number.isFinite(retry) ? ` Retry in ${String(Math.ceil(retry / 60))} min.` : ""),
          );
          return;
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        const parse = createSseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of parse(value)) {
            if (frame.event === "error") {
              fail("The answer stream failed. Try again.");
              continue;
            }
            const event = parseAnswerEvent(frame.data);
            if (event !== null) patch(answerId, (message) => applyAnswerEvent(message, event));
          }
        }
        patch(answerId, (message) =>
          message.status === "streaming" ? { ...message, status: "done" } : message,
        );
      } catch (error: unknown) {
        if (abort.signal.aborted) {
          patch(answerId, (message) => ({ ...message, status: "done", error: "Stopped." }));
        } else {
          fail(error instanceof Error ? "Could not reach Delegate." : "Unknown error.");
        }
      } finally {
        controller.current = null;
        setStreaming(false);
      }
    },
    [endpoint, maxQuestion, messages, patch],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    setMessages([]);
  }, []);

  return { messages, streaming, send, stop, reset };
}

function AnswerBody({ message }: { message: AssistantMessage }) {
  const segments = splitAnswer(message.text, message.citations);
  return (
    <p className="text-sm leading-7 whitespace-pre-wrap text-text">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <CitationPopover key={index} citation={segment.citation} />
        ),
      )}
      {message.status === "streaming" ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-accent motion-safe:animate-pulse"
        />
      ) : null}
    </p>
  );
}

function Answer({ message }: { message: AssistantMessage }) {
  const waiting = message.status === "streaming" && message.text === "" && message.refusal === null;
  return (
    <div className="flex flex-col gap-2.5">
      {waiting ? (
        <p className="flex items-center gap-2 font-mono text-2xs text-text-subtle">
          <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
          Searching the site’s pages…
        </p>
      ) : null}
      {message.refusal === null ? null : (
        <div className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning-soft/50 px-3 py-2.5">
          <CircleSlash className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-text">{REFUSAL_COPY[message.refusal.reason]}</p>
            <p className="text-sm leading-6 text-text-muted">{message.refusal.message}</p>
            {message.refusal.contactUrl === undefined ? null : (
              <a
                href={message.refusal.contactUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="w-fit text-xs text-accent underline underline-offset-4"
              >
                Contact {hostOf(message.refusal.contactUrl)}
              </a>
            )}
          </div>
        </div>
      )}
      {message.text === "" ? null : <AnswerBody message={message} />}
      {message.citations.length === 0 || message.status !== "done" ? null : (
        <ol className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2">
          {message.citations.map((citation) => (
            <li key={citation.index} className="flex min-w-0 items-center gap-1 text-2xs">
              <span className="font-mono text-text-subtle tabular">{citation.index}</span>
              <a
                href={citation.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="max-w-56 truncate text-text-muted underline decoration-border-strong underline-offset-4 hover:text-accent"
              >
                {citation.title ?? hostOf(citation.url)}
              </a>
            </li>
          ))}
        </ol>
      )}
      {message.error === null ? null : (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
          <TriangleAlert className="size-3.5" aria-hidden="true" />
          {message.error}
        </p>
      )}
      {message.status === "done" && message.servedBy !== undefined ? (
        <p className="font-mono text-2xs text-text-subtle">
          {message.servedBy.model} · {message.servedBy.provider}
          {message.durationMs === undefined ? "" : ` · ${(message.durationMs / 1000).toFixed(1)}s`}
        </p>
      ) : null}
    </div>
  );
}

export function AssistantChat({
  endpoint,
  assistantName,
  starterQuestions,
  maxQuestion,
  compact = false,
  listenForCommands = false,
}: {
  endpoint: string;
  assistantName: string;
  starterQuestions: readonly string[];
  maxQuestion: number;
  compact?: boolean;
  listenForCommands?: boolean;
}) {
  const { messages, streaming, send, stop, reset } = useAssistantChat(endpoint, maxQuestion);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!listenForCommands) return;
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === "agent-reset") {
        reset();
        setDraft("");
        inputRef.current?.focus();
      } else if (detail === "agent-focus") {
        inputRef.current?.focus();
      }
    };
    window.addEventListener(AGENT_COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener(AGENT_COMMAND_EVENT, onCommand);
    };
  }, [listenForCommands, reset]);

  const submit = (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (streaming) return;
    const question = draft;
    setDraft("");
    void send(question);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", compact ? "gap-2" : "gap-3")}>
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-busy={streaming}
        aria-label={`Conversation with ${assistantName}`}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto",
          compact ? "px-3 pt-3" : "px-1",
        )}
      >
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-text-muted">
              Answers come only from the company’s own pages, with numbered sources. If the answer
              is not there, the assistant says so.
            </p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Starter questions">
              {starterQuestions.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    onClick={() => {
                      void send(question);
                    }}
                    className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:border-accent/60 hover:bg-accent-soft/40"
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-lg rounded-br-sm bg-surface-2 px-3 py-2 text-sm leading-6 whitespace-pre-wrap text-text">
                  {message.text}
                </p>
              </div>
            ) : (
              <Answer key={message.id} message={message} />
            ),
          )
        )}
      </div>

      <form
        onSubmit={submit}
        className={cn(
          "flex flex-col gap-1.5 rounded-xl border border-border bg-surface shadow-sm focus-within:border-accent/60",
          compact ? "mx-3 mb-3" : "",
        )}
      >
        <label htmlFor={inputId} className="sr-only">
          Ask {assistantName}
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          value={draft}
          rows={compact ? 1 : 2}
          maxLength={maxQuestion}
          placeholder={`Ask ${assistantName}…`}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="resize-none bg-transparent px-3 pt-2.5 text-sm leading-6 text-text outline-none placeholder:text-text-subtle"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="font-mono text-2xs text-text-subtle">
            {compact ? "Enter to send" : "Enter to send · Shift+Enter for a new line"}
          </span>
          <div className="flex items-center gap-1.5">
            {messages.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  reset();
                  inputRef.current?.focus();
                }}
                aria-label="New conversation"
                title="New conversation"
                className="inline-flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <MessageSquarePlus className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            {streaming ? (
              <button
                type="button"
                onClick={stop}
                aria-label="Stop answering"
                className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-text hover:border-border-strong"
              >
                <Square className="size-3.5" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={draft.trim() === ""}
                aria-label="Send question"
                className="inline-flex size-8 items-center justify-center rounded-md bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-40"
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
