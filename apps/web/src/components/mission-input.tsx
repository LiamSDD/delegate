"use client";

import { CornerDownLeft } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Form from "next/form";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { MISSION_INPUT_ID } from "@/components/command-palette";
import { KindGlyph } from "@/components/kind-glyph";
import { detectMission, MAX_INPUT_LENGTH } from "@/lib/detect-mission";
import { startCompanyXray } from "@/lib/runs/start-run";
import { cn } from "@/lib/utils";

export interface ExampleTarget {
  label: string;
  value: string;
}

export function MissionInput({ examples }: { examples: readonly ExampleTarget[] }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const labelId = useId();
  const detected = detectMission(value);
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("focus") !== "mission") return;
    inputRef.current?.focus();
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Form
        action="/runs/new"
        onSubmit={(event) => {
          if (detected === null) {
            event.preventDefault();
            inputRef.current?.focus();
            return;
          }
          if (detected.kind !== "company") return;
          event.preventDefault();
          if (starting) return;
          setStarting(true);
          setStartError(null);
          void startCompanyXray({ url: detected.url }).then((result) => {
            if (result.ok) {
              router.push(`/runs/${result.runId}`);
              return;
            }
            setStarting(false);
            setStartError(result.message);
            inputRef.current?.focus();
          });
        }}
        className="group rounded-xl border border-border-strong bg-surface shadow-md transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--elevation-md)]"
      >
        <label id={labelId} htmlFor={MISSION_INPUT_ID} className="sr-only">
          Company URL, GitHub repo or goal
        </label>
        <input
          ref={inputRef}
          id={MISSION_INPUT_ID}
          name="q"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setStartError(null);
          }}
          maxLength={MAX_INPUT_LENGTH}
          placeholder="A company URL, a GitHub repo, or a goal"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-describedby={statusId}
          className="h-16 w-full rounded-t-xl bg-transparent px-5 text-lg text-text outline-none placeholder:text-text-subtle focus-visible:outline-none sm:text-xl"
        />
        <div className="flex h-12 items-center gap-3 border-t border-border pr-2 pl-5">
          <div id={statusId} aria-live="polite" className="min-w-0 flex-1 text-sm">
            <AnimatePresence mode="popLayout" initial={false}>
              {startError !== null ? (
                <motion.span
                  key="error"
                  role="alert"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="block truncate text-danger"
                  title={startError}
                >
                  {startError}
                </motion.span>
              ) : detected === null ? (
                <motion.span
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="flex items-center gap-2 truncate text-text-subtle"
                >
                  <span className="hidden sm:inline">Detects</span>
                  <span className="font-mono text-xs">company URL</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-xs">github.com/owner/repo</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-xs">a goal</span>
                </motion.span>
              ) : (
                <motion.span
                  key={detected.kind}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="flex min-w-0 items-center gap-2"
                >
                  <span className="sr-only">Detected mission:</span>
                  <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs font-medium text-text">
                    <KindGlyph kind={detected.kind} />
                    {detected.label}
                  </span>
                  {detected.kind === "goal" ? null : (
                    <span className="truncate font-mono text-xs text-text-muted">
                      {detected.target}
                    </span>
                  )}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <button
            type="submit"
            aria-disabled={detected === null || starting}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
              detected === null || starting
                ? "cursor-not-allowed bg-surface-2 text-text-subtle"
                : "bg-accent text-accent-fg hover:bg-accent/90",
            )}
          >
            {starting ? "Starting…" : detected?.kind === "company" ? "Start run" : "Draft run"}
            <CornerDownLeft className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </Form>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
        <span className="mr-2 font-mono text-2xs tracking-label text-text-subtle uppercase">
          Try
        </span>
        {examples.map((example) => (
          <button
            key={example.value}
            type="button"
            onClick={() => {
              setValue(example.value);
              inputRef.current?.focus();
            }}
            className="inline-flex min-h-7 items-center rounded-md px-2 py-1 text-left font-mono text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            {example.label}
          </button>
        ))}
      </div>
    </div>
  );
}
