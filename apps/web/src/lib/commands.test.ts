import { describe, expect, it } from "vitest";

import { COMMANDS, filterCommands, moveIndex } from "./commands";

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

describe("moveIndex", () => {
  it("wraps in both directions", () => {
    expect(moveIndex(0, -1, 4)).toBe(3);
    expect(moveIndex(3, 1, 4)).toBe(0);
    expect(moveIndex(1, 1, 4)).toBe(2);
    expect(moveIndex(2, 5, 0)).toBe(0);
  });
});
