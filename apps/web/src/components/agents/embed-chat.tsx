"use client";

import { X } from "lucide-react";

import { EMBED_CLOSE_MESSAGE } from "@/lib/agents/embed";
import { hostOf } from "@/lib/runs/build-agent";

import { AssistantChat } from "./assistant-chat";

export function EmbedChat({
  assistantId,
  name,
  host,
  starterQuestions,
  maxQuestion,
  widget,
}: {
  assistantId: string;
  name: string;
  host: string;
  starterQuestions: readonly string[];
  maxQuestion: number;
  widget: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-success" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-sm font-medium text-text">{name}</h1>
          <p className="truncate font-mono text-2xs text-text-subtle">
            Answers from {hostOf(host)} · cited
          </p>
        </div>
        {widget ? (
          <button
            type="button"
            aria-label="Close assistant"
            onClick={() => {
              window.parent.postMessage({ type: EMBED_CLOSE_MESSAGE }, "*");
            }}
            className="inline-flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <AssistantChat
        endpoint={`/api/embed/${assistantId}/chat`}
        assistantName={name}
        starterQuestions={starterQuestions}
        maxQuestion={maxQuestion}
        compact
      />
      <p className="border-t border-border px-3 py-1.5 text-center font-mono text-2xs text-text-subtle">
        Powered by Delegate · may be wrong; check the sources
      </p>
    </div>
  );
}
