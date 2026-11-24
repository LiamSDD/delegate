"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { currentResolvedTheme, subscribeToTheme, toggleTheme } from "@/lib/theme-dom";

function serverSnapshot(): null {
  return null;
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, currentResolvedTheme, serverSnapshot);
  const label =
    theme === null
      ? "Toggle colour theme"
      : `Switch to ${theme === "dark" ? "light" : "dark"} theme`;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="inline-flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      <Moon className="size-4 dark:hidden" strokeWidth={1.5} aria-hidden="true" />
      <Sun className="hidden size-4 dark:block" strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
