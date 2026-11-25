"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const CONFIRMATION_MS = 1600;

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setCopied(false);
            }, CONFIRMATION_MS);
          },
          () => undefined,
        );
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-2xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {copied ? (
        <Check className="size-3.5 text-success" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
