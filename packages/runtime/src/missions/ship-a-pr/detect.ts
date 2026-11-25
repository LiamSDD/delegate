import { z } from "zod";

export const PROJECT_MARKER_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Makefile",
] as const;

export const COMMAND_IDS = ["install", "test", "lint", "typecheck"] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export const ProjectCommandSchema = z.object({
  argv: z.array(z.string().min(1).max(200)).min(1).max(12),
  source: z.string().max(200),
});
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;

export const ProjectProfileSchema = z.object({
  ecosystem: z.enum(["node", "python", "make", "unknown"]),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "pip", "uv", "poetry"]).nullable(),
  commands: z.object({
    install: ProjectCommandSchema.nullable(),
    test: ProjectCommandSchema.nullable(),
    lint: ProjectCommandSchema.nullable(),
    typecheck: ProjectCommandSchema.nullable(),
  }),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export interface ProjectFiles {
  present: ReadonlySet<string>;
  packageJson?: string;
  pyproject?: string;
  makefile?: string;
}

const PackageJsonSchema = z
  .object({
    scripts: z.record(z.string(), z.string()).optional(),
    packageManager: z.string().optional(),
  })
  .loose();

const NPM_DEFAULT_TEST = /no test specified/i;

type NodeManager = "npm" | "pnpm" | "yarn" | "bun";

function nodeManager(files: ProjectFiles, declared: string | undefined): NodeManager {
  if (files.present.has("pnpm-lock.yaml")) return "pnpm";
  if (files.present.has("yarn.lock")) return "yarn";
  if (files.present.has("bun.lock") || files.present.has("bun.lockb")) return "bun";
  if (files.present.has("package-lock.json") || files.present.has("npm-shrinkwrap.json"))
    return "npm";
  const name = declared?.split("@")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

function nodeInstall(manager: NodeManager, files: ProjectFiles): ProjectCommand {
  switch (manager) {
    case "pnpm":
      return {
        argv: files.present.has("pnpm-lock.yaml")
          ? ["pnpm", "install", "--frozen-lockfile"]
          : ["pnpm", "install"],
        source: "pnpm-lock.yaml",
      };
    case "yarn":
      return { argv: ["yarn", "install", "--frozen-lockfile"], source: "yarn.lock" };
    case "bun":
      return { argv: ["bun", "install"], source: "bun.lock" };
    case "npm":
      return files.present.has("package-lock.json") || files.present.has("npm-shrinkwrap.json")
        ? { argv: ["npm", "ci"], source: "package-lock.json" }
        : { argv: ["npm", "install"], source: "package.json" };
  }
}

function nodeScript(
  manager: NodeManager,
  scripts: Record<string, string>,
  names: readonly string[],
): ProjectCommand | null {
  const name = names.find((candidate) => {
    const body = scripts[candidate];
    return body !== undefined && body.trim() !== "" && !NPM_DEFAULT_TEST.test(body);
  });
  if (name === undefined) return null;
  const argv = manager === "npm" ? ["npm", "run", name] : [manager, "run", name];
  return { argv, source: `package.json scripts.${name}` };
}

function makeTargets(makefile: string | undefined): Set<string> {
  const targets = new Set<string>();
  for (const line of (makefile ?? "").split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(?!=)/.exec(line);
    if (match?.[1] !== undefined) targets.add(match[1]);
  }
  return targets;
}

function makeCommand(targets: Set<string>, names: readonly string[]): ProjectCommand | null {
  const name = names.find((candidate) => targets.has(candidate));
  return name === undefined ? null : { argv: ["make", name], source: `Makefile target ${name}` };
}

function pythonProfile(files: ProjectFiles): ProjectProfile | null {
  const pyproject = files.pyproject ?? "";
  const hasPython = files.pyproject !== undefined || files.present.has("requirements.txt");
  if (!hasPython) return null;
  const manager = files.present.has("uv.lock")
    ? ("uv" as const)
    : files.present.has("poetry.lock")
      ? ("poetry" as const)
      : ("pip" as const);
  const run = (args: string[]): string[] =>
    manager === "uv"
      ? ["uv", "run", ...args]
      : manager === "poetry"
        ? ["poetry", "run", ...args]
        : ["python", "-m", ...args];
  const install: ProjectCommand =
    manager === "uv"
      ? { argv: ["uv", "sync"], source: "uv.lock" }
      : manager === "poetry"
        ? { argv: ["poetry", "install"], source: "poetry.lock" }
        : files.present.has("requirements.txt")
          ? {
              argv: ["python", "-m", "pip", "install", "-r", "requirements.txt"],
              source: "requirements.txt",
            }
          : { argv: ["python", "-m", "pip", "install", "-e", "."], source: "pyproject.toml" };
  const usesPytest = /pytest/i.test(pyproject) || files.present.has("requirements.txt");
  const targets = makeTargets(files.makefile);
  return {
    ecosystem: "python",
    packageManager: manager,
    commands: {
      install,
      test: usesPytest
        ? { argv: run(["pytest", "-q"]), source: "pyproject.toml pytest" }
        : makeCommand(targets, ["test", "tests", "check"]),
      lint: /\bruff\b/.test(pyproject)
        ? { argv: run(["ruff", "check", "."]), source: "pyproject.toml ruff" }
        : makeCommand(targets, ["lint"]),
      typecheck: /\bmypy\b/.test(pyproject)
        ? { argv: run(["mypy", "."]), source: "pyproject.toml mypy" }
        : makeCommand(targets, ["typecheck", "type-check"]),
    },
  };
}

export function detectProject(files: ProjectFiles): ProjectProfile {
  const targets = makeTargets(files.makefile);
  if (files.packageJson !== undefined) {
    const parsed = PackageJsonSchema.safeParse(
      ((): unknown => {
        try {
          return JSON.parse(files.packageJson ?? "");
        } catch {
          return {};
        }
      })(),
    );
    const scripts = parsed.success ? (parsed.data.scripts ?? {}) : {};
    const manager = nodeManager(files, parsed.success ? parsed.data.packageManager : undefined);
    return {
      ecosystem: "node",
      packageManager: manager,
      commands: {
        install: nodeInstall(manager, files),
        test:
          nodeScript(manager, scripts, ["test", "test:unit", "tests"]) ??
          makeCommand(targets, ["test"]),
        lint: nodeScript(manager, scripts, ["lint"]) ?? makeCommand(targets, ["lint"]),
        typecheck:
          nodeScript(manager, scripts, ["typecheck", "type-check", "tsc", "check-types"]) ??
          makeCommand(targets, ["typecheck"]),
      },
    };
  }
  const python = pythonProfile(files);
  if (python !== null) return python;
  if (files.makefile !== undefined)
    return {
      ecosystem: "make",
      packageManager: null,
      commands: {
        install: null,
        test: makeCommand(targets, ["test", "tests", "check"]),
        lint: makeCommand(targets, ["lint"]),
        typecheck: makeCommand(targets, ["typecheck", "type-check"]),
      },
    };
  return {
    ecosystem: "unknown",
    packageManager: null,
    commands: { install: null, test: null, lint: null, typecheck: null },
  };
}

export function commandLabel(command: ProjectCommand): string {
  return command.argv.join(" ");
}
