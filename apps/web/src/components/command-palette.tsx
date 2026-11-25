"use client";

import {
  ArrowRight,
  BookOpen,
  Code,
  Contrast,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  Search,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Kbd } from "@/components/kbd";
import { useModifierLabel } from "@/components/platform";
import {
  AGENT_COMMAND_EVENT,
  COMMANDS,
  commandsFor,
  type CommandDefinition,
  type CommandId,
  filterCommands,
  moveIndex,
} from "@/lib/commands";
import { DOCS_URL } from "@/lib/site";
import { toggleTheme } from "@/lib/theme-dom";
import { cn } from "@/lib/utils";

export const MISSION_INPUT_ID = "mission-input";

interface PaletteContextValue {
  open: () => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function useCommandPalette(): PaletteContextValue {
  const value = useContext(PaletteContext);
  if (value === null)
    throw new Error("useCommandPalette must be used inside CommandPaletteProvider");
  return value;
}

const ICONS: Record<CommandId, typeof Plus> = {
  "new-run": Plus,
  "toggle-theme": Contrast,
  "go-runs": ArrowRight,
  "go-agents": ArrowRight,
  "agent-focus": MessagesSquare,
  "agent-reset": MessageSquarePlus,
  "agent-copy-embed": Code,
  "go-control": ArrowRight,
  "go-evals": ArrowRight,
  "go-settings": ArrowRight,
  "open-docs": BookOpen,
};

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => {
    setIsOpen(true);
  }, []);
  const close = useCallback(() => {
    setIsOpen(false);
  }, []);
  const value = useMemo(() => ({ open }), [open]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <PaletteContext.Provider value={value}>
      {children}
      {isOpen ? <CommandDialog onClose={close} /> : null}
    </PaletteContext.Provider>
  );
}

function CommandDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId();
  const titleId = useId();
  const optionId = (id: CommandId) => `${listId}-${id}`;

  const results = filterCommands(commandsFor(COMMANDS, pathname), query);
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0));
  const activeCommand = results[activeIndex];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    inputRef.current?.focus();
    return () => {
      dialog.close();
      previouslyFocused?.focus();
    };
  }, []);

  const run = (command: CommandDefinition) => {
    onClose();
    switch (command.id) {
      case "new-run":
        if (pathname === "/") {
          requestAnimationFrame(() => document.getElementById(MISSION_INPUT_ID)?.focus());
        } else {
          router.push("/?focus=mission");
        }
        return;
      case "toggle-theme":
        toggleTheme();
        return;
      case "open-docs":
        window.open(DOCS_URL, "_blank", "noopener,noreferrer");
        return;
      case "agent-focus":
      case "agent-reset":
      case "agent-copy-embed":
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent(AGENT_COMMAND_EVENT, { detail: command.id })),
        );
        return;
      default:
        if (command.href !== undefined) router.push(command.href);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(moveIndex(activeIndex, 1, results.length));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive(moveIndex(activeIndex, -1, results.length));
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(Math.max(results.length - 1, 0));
        return;
      case "Enter":
        event.preventDefault();
        if (activeCommand !== undefined) run(activeCommand);
        return;
      case "Tab":
        event.preventDefault();
        return;
    }
  };

  let lastGroup: CommandDefinition["group"] | null = null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-x-0 top-[12vh] bottom-auto m-0 h-fit mx-auto w-[min(36rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-xl border border-border bg-surface p-0 text-text shadow-lg backdrop:bg-overlay"
    >
      <h2 id={titleId} className="sr-only">
        Command palette
      </h2>
      <div className="flex h-12 items-center gap-3 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-text-subtle" strokeWidth={1.5} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeCommand === undefined ? undefined : optionId(activeCommand.id)
          }
          aria-label="Search commands"
          placeholder="Type a command"
          autoComplete="off"
          spellCheck={false}
          className="h-full flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-subtle focus-visible:outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul id={listId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-2">
        {results.length === 0 ? (
          <li role="presentation" className="px-3 py-6 text-center text-sm text-text-muted">
            No commands match <span className="font-mono text-text">{query.trim()}</span>
          </li>
        ) : (
          results.map((command, index) => {
            const Icon = ICONS[command.id];
            const showGroup = command.group !== lastGroup;
            lastGroup = command.group;
            const selected = index === activeIndex;
            return (
              <li key={command.id} role="presentation">
                {showGroup ? (
                  <div
                    role="presentation"
                    className="px-3 pt-2 pb-1 font-mono text-2xs tracking-label text-text-subtle uppercase"
                  >
                    {command.group}
                  </div>
                ) : null}
                <div
                  id={optionId(command.id)}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => {
                    if (!selected) setActive(index);
                  }}
                  onClick={() => {
                    run(command);
                  }}
                  className={cn(
                    "flex h-9 cursor-pointer items-center gap-3 rounded-md px-3 text-sm text-text-muted",
                    selected && "bg-surface-2 text-text",
                  )}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <span className="flex-1">{command.label}</span>
                  {command.id === "open-docs" ? (
                    <span className="font-mono text-2xs text-text-subtle">github.com</span>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>
      <div className="flex h-9 items-center gap-4 border-t border-border bg-surface-2 px-4 text-xs text-text-subtle">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          run
        </span>
      </div>
    </dialog>
  );
}

export function CommandPaletteButton() {
  const { open } = useCommandPalette();
  const modifier = useModifierLabel();
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Open command palette"
      aria-keyshortcuts="Meta+K Control+K"
      className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-surface pr-1.5 pl-2.5 text-sm text-text-muted shadow-sm transition-colors hover:border-border-strong hover:text-text"
    >
      <Search className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      <span className="hidden sm:inline">Jump to</span>
      <span className="hidden items-center gap-0.5 sm:flex" aria-hidden="true">
        <Kbd>{modifier}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}
