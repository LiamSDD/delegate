export type CommandId =
  | "new-run"
  | "go-runs"
  | "go-agents"
  | "go-control"
  | "go-evals"
  | "go-settings"
  | "toggle-theme"
  | "open-docs"
  | "agent-focus"
  | "agent-reset"
  | "agent-copy-embed";

export interface CommandDefinition {
  id: CommandId;
  group: "Actions" | "Assistant" | "Navigate" | "Help";
  label: string;
  keywords: readonly string[];
  href?: string;
  scope?: RegExp;
}

export const ASSISTANT_PAGE = /^\/agents\/[^/]+\/?$/;
export const AGENT_COMMAND_EVENT = "delegate:agent-command";

export const COMMANDS: readonly CommandDefinition[] = [
  {
    id: "new-run",
    group: "Actions",
    label: "New run",
    keywords: ["start", "mission", "goal", "url"],
  },
  {
    id: "toggle-theme",
    group: "Actions",
    label: "Toggle theme",
    keywords: ["dark", "light", "appearance"],
  },
  {
    id: "agent-focus",
    group: "Assistant",
    label: "Ask the assistant",
    keywords: ["chat", "question", "focus"],
    scope: ASSISTANT_PAGE,
  },
  {
    id: "agent-reset",
    group: "Assistant",
    label: "New conversation",
    keywords: ["reset", "clear", "chat"],
    scope: ASSISTANT_PAGE,
  },
  {
    id: "agent-copy-embed",
    group: "Assistant",
    label: "Copy embed snippet",
    keywords: ["widget", "script", "install"],
    scope: ASSISTANT_PAGE,
  },
  {
    id: "go-runs",
    group: "Navigate",
    label: "Go to Runs",
    keywords: ["history", "trace"],
    href: "/runs",
  },
  {
    id: "go-agents",
    group: "Navigate",
    label: "Go to Agents",
    keywords: ["assistants", "chat", "widget", "build"],
    href: "/agents",
  },
  {
    id: "go-control",
    group: "Navigate",
    label: "Go to Control",
    keywords: ["mission control", "approvals", "spend"],
    href: "/control",
  },
  {
    id: "go-evals",
    group: "Navigate",
    label: "Go to Evals",
    keywords: ["scoreboard", "quality", "pareto"],
    href: "/evals",
  },
  {
    id: "go-settings",
    group: "Navigate",
    label: "Go to Settings",
    keywords: ["policies", "members", "keys", "connectors"],
    href: "/settings",
  },
  {
    id: "open-docs",
    group: "Help",
    label: "Open docs",
    keywords: ["architecture", "security", "adr", "github"],
  },
];

export function commandsFor(
  commands: readonly CommandDefinition[],
  pathname: string,
): readonly CommandDefinition[] {
  return commands.filter((command) => command.scope === undefined || command.scope.test(pathname));
}

export function filterCommands(
  commands: readonly CommandDefinition[],
  query: string,
): readonly CommandDefinition[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) return commands;
  return commands.filter((command) => {
    const haystack = [command.label, command.group, ...command.keywords].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((current + delta) % length) + length) % length;
}
