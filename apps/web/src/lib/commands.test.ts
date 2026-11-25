import { describe, expect, it } from "vitest";

import { COMMANDS, commandsFor, filterCommands, moveIndex } from "./commands";

describe("filterCommands", () => {
  it("returns every command for an empty query", () => {
    expect(filterCommands(COMMANDS, "  ")).toBe(COMMANDS);
  });

  it("matches labels and keywords, all terms required", () => {
    expect(filterCommands(COMMANDS, "dark").map((command) => command.id)).toEqual(["toggle-theme"]);
    expect(filterCommands(COMMANDS, "go approvals").map((command) => command.id)).toEqual([
      "go-control",
    ]);
    expect(filterCommands(COMMANDS, "go nowhere")).toEqual([]);
  });

  it("offers every command the shell promises", () => {
    expect(COMMANDS.map((command) => command.id).sort()).toEqual(
      [
        "agent-copy-embed",
        "agent-focus",
        "agent-reset",
        "go-agents",
        "go-control",
        "go-evals",
        "go-runs",
        "go-settings",
        "new-run",
        "open-docs",
        "toggle-theme",
      ].sort(),
    );
  });
});

describe("commandsFor", () => {
  it("offers assistant commands only on an assistant page", () => {
    const ids = (path: string) => commandsFor(COMMANDS, path).map((command) => command.id);
    expect(ids("/runs")).not.toContain("agent-reset");
    expect(ids("/agents")).not.toContain("agent-reset");
    expect(ids("/agents/6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10")).toEqual(
      expect.arrayContaining(["agent-reset", "agent-focus", "agent-copy-embed", "go-agents"]),
    );
  });
});

describe("moveIndex", () => {
  it("wraps in both directions", () => {
    expect(moveIndex(0, -1, 4)).toBe(3);
    expect(moveIndex(3, 1, 4)).toBe(0);
    expect(moveIndex(1, 1, 4)).toBe(2);
    expect(moveIndex(2, 5, 0)).toBe(0);
  });
});
