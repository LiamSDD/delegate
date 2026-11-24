export type CommandId =
  "new-run" | "go-runs" | "go-control" | "go-evals" | "go-settings" | "toggle-theme" | "open-docs";

export interface CommandDefinition {
  id: CommandId;
  group: "Actions" | "Navigate" | "Help";
  label: string;
  keywords: readonly string[];
  href?: string;
}

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
    id: "go-runs",
    group: "Navigate",
    label: "Go to Runs",
    keywords: ["history", "trace"],
    href: "/runs",
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
