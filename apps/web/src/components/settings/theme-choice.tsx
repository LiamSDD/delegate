"use client";

import { useSyncExternalStore } from "react";

import type { ThemePreference } from "@/lib/theme";
import { applyPreference, currentPreference } from "@/lib/theme-dom";
import { cn } from "@/lib/utils";

const CHOICES: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-preference"],
  });
  return () => {
    observer.disconnect();
  };
}

function serverSnapshot(): null {
  return null;
}

export function ThemeChoice() {
  const preference = useSyncExternalStore(subscribe, currentPreference, serverSnapshot);
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="sr-only">Colour theme</legend>
      <div className="flex flex-wrap gap-2">
        {CHOICES.map((choice) => {
          const selected = preference === choice.value;
          return (
            <label
              key={choice.value}
              className={cn(
                "inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-focus-visible:ring-2 has-focus-visible:ring-focus",
                selected
                  ? "border-border-strong bg-surface text-text shadow-sm"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text",
              )}
            >
              <input
                type="radio"
                name="theme"
                value={choice.value}
                checked={selected}
                onChange={() => {
                  applyPreference(choice.value);
                }}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full border",
                  selected ? "border-accent bg-accent" : "border-border-strong",
                )}
              />
              {choice.label}
            </label>
          );
        })}
      </div>
      <p className="text-sm text-text-muted">
        Stored in this browser only. It is not part of your workspace data.
      </p>
    </fieldset>
  );
}
