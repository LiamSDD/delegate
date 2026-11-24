import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const RC = fileURLToPath(new URL("./git-hooks.rc.sh", import.meta.url));
const SYSTEM_PATH = "/usr/bin:/bin";

let home = "";

function fakeTool(dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

function sourceRc(env) {
  return spawnSync("/bin/sh", ["-c", `. "${RC}" && command -v node && command -v pnpm`], {
    env,
    encoding: "utf8",
  });
}

afterEach(() => {
  if (home !== "") rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("git-hooks.rc.sh", () => {
  it("adds $HOME/.local/node/bin when node is not on PATH", () => {
    home = mkdtempSync(path.join(tmpdir(), "hooks-rc-"));
    const bin = path.join(home, ".local", "node", "bin");
    fakeTool(bin, "node");
    fakeTool(bin, "pnpm");
    const result = sourceRc({ HOME: home, PATH: SYSTEM_PATH });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      path.join(bin, "node"),
      path.join(bin, "pnpm"),
    ]);
  });

  it("keeps an existing node on PATH", () => {
    home = mkdtempSync(path.join(tmpdir(), "hooks-rc-"));
    const own = path.join(home, "own-bin");
    fakeTool(own, "node");
    fakeTool(own, "pnpm");
    fakeTool(path.join(home, ".local", "node", "bin"), "node");
    const result = sourceRc({ HOME: home, PATH: `${own}:${SYSTEM_PATH}` });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")[0]).toBe(path.join(own, "node"));
  });

  it("fails the hook with a clear message when node cannot be found", () => {
    home = mkdtempSync(path.join(tmpdir(), "hooks-rc-"));
    const result = sourceRc({ HOME: home, PATH: SYSTEM_PATH });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("node was not found");
  });
});
