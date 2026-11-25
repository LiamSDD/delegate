import { baseName, fileLines, type RepoFile } from "./snapshot";

export const ECOSYSTEMS = ["npm", "pypi", "go", "cargo", "rubygems", "composer"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export const DEPENDENCY_SCOPES = ["runtime", "dev", "optional", "peer", "build"] as const;
export type DependencyScope = (typeof DEPENDENCY_SCOPES)[number];

export interface Dependency {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  scope: DependencyScope;
  manifest: string;
  line: number;
}

export interface ManifestScript {
  name: string;
  command: string;
  line: number;
}

export interface ManifestEntry {
  kind: "main" | "bin" | "exports" | "module" | "script";
  target: string;
  line: number;
}

export interface Manifest {
  path: string;
  ecosystem: Ecosystem;
  name: string | null;
  nameLine: number;
  dependencies: Dependency[];
  scripts: ManifestScript[];
  entries: ManifestEntry[];
  workspaces: string[];
}

const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]{0,213}$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}/;
const GO_MODULE = /^[\w.~-]+(?:\/[\w.~-]+)*$/;

export function isSafeName(name: string): boolean {
  return PACKAGE_NAME.test(name) || GO_MODULE.test(name);
}

function lineOf(lines: readonly string[], needle: RegExp, from = 0): number {
  for (let index = Math.max(0, from); index < lines.length; index += 1)
    if (needle.test(lines[index] ?? "")) return index + 1;
  return 0;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function jsonKeyLine(lines: readonly string[], key: string, from = 0): number {
  return lineOf(lines, new RegExp(`"${escape(key)}"\\s*:`), from);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringEntries(value: unknown): [string, string][] {
  return Object.entries(asRecord(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

function parsePackageJson(file: RepoFile): Manifest | null {
  let data: Record<string, unknown>;
  try {
    data = asRecord(JSON.parse(file.text) as unknown);
  } catch {
    return null;
  }
  const lines = fileLines(file);
  const dependencies: Dependency[] = [];
  const blocks: [string, DependencyScope][] = [
    ["dependencies", "runtime"],
    ["devDependencies", "dev"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ];
  for (const [block, scope] of blocks) {
    const start = jsonKeyLine(lines, block);
    for (const [name, version] of stringEntries(data[block])) {
      if (!PACKAGE_NAME.test(name)) continue;
      dependencies.push({
        name,
        version: version.slice(0, 80),
        ecosystem: "npm",
        scope,
        manifest: file.path,
        line: jsonKeyLine(lines, name, start) || start,
      });
    }
  }
  const scriptsStart = jsonKeyLine(lines, "scripts");
  const scripts = stringEntries(data.scripts).map(([name, command]) => ({
    name,
    command,
    line: jsonKeyLine(lines, name, scriptsStart) || scriptsStart,
  }));
  const entries: ManifestEntry[] = [];
  for (const kind of ["main", "module"] as const) {
    const target = data[kind];
    if (typeof target === "string") entries.push({ kind, target, line: jsonKeyLine(lines, kind) });
  }
  const bin = data.bin;
  if (typeof bin === "string")
    entries.push({ kind: "bin", target: bin, line: jsonKeyLine(lines, "bin") });
  for (const [, target] of stringEntries(bin))
    entries.push({ kind: "bin", target, line: jsonKeyLine(lines, "bin") });
  const exportsValue = data.exports;
  const exportTargets = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") exportTargets.add(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
  };
  collect(exportsValue);
  for (const target of [...exportTargets].slice(0, 6))
    entries.push({ kind: "exports", target, line: jsonKeyLine(lines, "exports") });
  const workspacesValue = data.workspaces;
  const workspaces = Array.isArray(workspacesValue)
    ? workspacesValue.filter((item): item is string => typeof item === "string")
    : Array.isArray(asRecord(workspacesValue).packages)
      ? (asRecord(workspacesValue).packages as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [];
  const name = typeof data.name === "string" && PACKAGE_NAME.test(data.name) ? data.name : null;
  return {
    path: file.path,
    ecosystem: "npm",
    name,
    nameLine: jsonKeyLine(lines, "name"),
    dependencies,
    scripts,
    entries,
    workspaces,
  };
}

function splitRequirement(raw: string): { name: string; version: string } | null {
  const text = raw.split(";")[0]?.trim() ?? "";
  const match = PYPI_NAME.exec(text);
  if (match === null) return null;
  const name = match[0].replace(/\[.*$/, "");
  const rest = text
    .slice(match[0].length)
    .replace(/^\[[^\]]*\]/, "")
    .trim();
  return { name, version: rest.slice(0, 80) };
}

interface TomlTable {
  header: string;
  line: number;
}

function tomlTables(lines: readonly string[]): (TomlTable | undefined)[] {
  let current: TomlTable | undefined;
  return lines.map((raw, index) => {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(raw);
    if (header !== null) current = { header: (header[1] ?? "").trim(), line: index + 1 };
    return current;
  });
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^["']|["'],?$/g, "")
    .replace(/["']$/, "");
}

function parsePyproject(file: RepoFile): Manifest {
  const lines = fileLines(file);
  const tables = tomlTables(lines);
  const dependencies: Dependency[] = [];
  const scripts: ManifestScript[] = [];
  const entries: ManifestEntry[] = [];
  let name: string | null = null;
  let nameLine = 0;
  let arrayScope: DependencyScope | null = null;
  const pushRequirement = (raw: string, scope: DependencyScope, line: number) => {
    const requirement = splitRequirement(unquote(raw));
    if (requirement === null || requirement.name.toLowerCase() === "python") return;
    dependencies.push({ ...requirement, ecosystem: "pypi", scope, manifest: file.path, line });
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    const table = tables[index]?.header ?? "";
    const text = raw.replace(/\s+#.*$/, "");
    if (/^\s*\[/.test(text)) {
      arrayScope = null;
      return;
    }
    if (arrayScope !== null) {
      for (const item of text.matchAll(/["']([^"']+)["']/g))
        pushRequirement(item[1] ?? "", arrayScope, line);
      if (text.includes("]")) arrayScope = null;
      return;
    }
    const pair = /^\s*([\w.-]+|"[^"]+")\s*=\s*(.*)$/.exec(text);
    if (pair === null) return;
    const key = unquote(pair[1] ?? "");
    const value = (pair[2] ?? "").trim();
    if ((table === "project" || table === "tool.poetry") && key === "name") {
      const candidate = unquote(value);
      if (PYPI_NAME.test(candidate)) {
        name = candidate;
        nameLine = line;
      }
      return;
    }
    const arrayKey =
      (table === "project" && key === "dependencies") ||
      table === "project.optional-dependencies" ||
      table === "dependency-groups";
    if (arrayKey && value.startsWith("[")) {
      const scope: DependencyScope =
        table === "project" ? "runtime" : table === "dependency-groups" ? "dev" : "optional";
      for (const item of value.matchAll(/["']([^"']+)["']/g))
        pushRequirement(item[1] ?? "", scope, line);
      if (!value.includes("]")) arrayScope = scope;
      return;
    }
    const poetry = /^tool\.poetry\.(?:group\.[\w-]+\.)?(dev-)?dependencies$/.exec(table);
    if (poetry !== null && key.toLowerCase() !== "python") {
      const version = value.startsWith("{")
        ? (/version\s*=\s*["']([^"']+)["']/.exec(value)?.[1] ?? "")
        : unquote(value);
      if (PYPI_NAME.test(key))
        dependencies.push({
          name: key,
          version: version.slice(0, 80),
          ecosystem: "pypi",
          scope: poetry[1] !== undefined || table.includes(".group.") ? "dev" : "runtime",
          manifest: file.path,
          line,
        });
      return;
    }
    if (table === "project.scripts" || table === "tool.poetry.scripts") {
      const target = unquote(value);
      scripts.push({ name: key, command: target, line });
      entries.push({ kind: "script", target, line });
    }
  });
  return {
    path: file.path,
    ecosystem: "pypi",
    name,
    nameLine,
    dependencies,
    scripts,
    entries,
    workspaces: [],
  };
}

function parseRequirements(file: RepoFile): Manifest {
  const dependencies: Dependency[] = [];
  const scope: DependencyScope = /dev|test|lint|doc/i.test(baseName(file.path)) ? "dev" : "runtime";
  fileLines(file).forEach((raw, index) => {
    const text = raw.replace(/\s+#.*$/, "").trim();
    if (text === "" || text.startsWith("#") || text.startsWith("-")) return;
    const requirement = splitRequirement(text);
    if (requirement !== null)
      dependencies.push({
        ...requirement,
        ecosystem: "pypi",
        scope,
        manifest: file.path,
        line: index + 1,
      });
  });
  return {
    path: file.path,
    ecosystem: "pypi",
    name: null,
    nameLine: 0,
    dependencies,
    scripts: [],
    entries: [],
    workspaces: [],
  };
}

function parseGoMod(file: RepoFile): Manifest {
  const dependencies: Dependency[] = [];
  let name: string | null = null;
  let nameLine = 0;
  let inRequire = false;
  fileLines(file).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.replace(/\/\/.*$/, "").trim();
    const module = /^module\s+(\S+)/.exec(text);
    if (module !== null && GO_MODULE.test(module[1] ?? "")) {
      name = module[1] ?? null;
      nameLine = line;
      return;
    }
    if (/^require\s*\($/.test(text)) {
      inRequire = true;
      return;
    }
    if (inRequire && text === ")") {
      inRequire = false;
      return;
    }
    const requirement = inRequire
      ? /^(\S+)\s+(\S+)/.exec(text)
      : /^require\s+(\S+)\s+(\S+)/.exec(text);
    if (requirement !== null && GO_MODULE.test(requirement[1] ?? ""))
      dependencies.push({
        name: requirement[1] ?? "",
        version: (requirement[2] ?? "").slice(0, 80),
        ecosystem: "go",
        scope: /\/\/\s*indirect/.test(raw) ? "optional" : "runtime",
        manifest: file.path,
        line,
      });
  });
  return {
    path: file.path,
    ecosystem: "go",
    name,
    nameLine,
    dependencies,
    scripts: [],
    entries: [],
    workspaces: [],
  };
}

function parseCargo(file: RepoFile): Manifest {
  const lines = fileLines(file);
  const tables = tomlTables(lines);
  const dependencies: Dependency[] = [];
  const entries: ManifestEntry[] = [];
  let name: string | null = null;
  let nameLine = 0;
  lines.forEach((raw, index) => {
    const line = index + 1;
    const table = tables[index]?.header ?? "";
    const pair = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(raw.replace(/\s+#.*$/, ""));
    if (pair === null) return;
    const key = pair[1] ?? "";
    const value = (pair[2] ?? "").trim();
    if (table === "package" && key === "name") {
      const candidate = unquote(value);
      if (PACKAGE_NAME.test(candidate)) {
        name = candidate;
        nameLine = line;
      }
      return;
    }
    if (table === "bin" && key === "path")
      entries.push({ kind: "bin", target: unquote(value), line });
    const scope: DependencyScope | null =
      table === "dependencies" || /^target\..*\.dependencies$/.test(table)
        ? "runtime"
        : table === "dev-dependencies"
          ? "dev"
          : table === "build-dependencies"
            ? "build"
            : null;
    if (scope === null || !PACKAGE_NAME.test(key)) return;
    const version = value.startsWith("{")
      ? (/version\s*=\s*"([^"]+)"/.exec(value)?.[1] ??
        /(git|path)\s*=/.exec(value)?.[0].replace(/\s*=$/, ":") ??
        "")
      : unquote(value);
    dependencies.push({
      name: key,
      version: version.slice(0, 80),
      ecosystem: "cargo",
      scope,
      manifest: file.path,
      line,
    });
  });
  return {
    path: file.path,
    ecosystem: "cargo",
    name,
    nameLine,
    dependencies,
    scripts: [],
    entries,
    workspaces: [],
  };
}

function parseGemfile(file: RepoFile): Manifest {
  const dependencies: Dependency[] = [];
  let group: DependencyScope = "runtime";
  fileLines(file).forEach((raw, index) => {
    const text = raw.trim();
    if (/^group\b.*\b(development|test)\b/.test(text)) group = "dev";
    if (text === "end") group = "runtime";
    const gem = /^gem\s+["']([\w.-]+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(text);
    if (gem !== null)
      dependencies.push({
        name: gem[1] ?? "",
        version: (gem[2] ?? "").slice(0, 80),
        ecosystem: "rubygems",
        scope: group,
        manifest: file.path,
        line: index + 1,
      });
  });
  return {
    path: file.path,
    ecosystem: "rubygems",
    name: null,
    nameLine: 0,
    dependencies,
    scripts: [],
    entries: [],
    workspaces: [],
  };
}

function parseComposer(file: RepoFile): Manifest | null {
  let data: Record<string, unknown>;
  try {
    data = asRecord(JSON.parse(file.text) as unknown);
  } catch {
    return null;
  }
  const lines = fileLines(file);
  const dependencies: Dependency[] = [];
  for (const [block, scope] of [
    ["require", "runtime"],
    ["require-dev", "dev"],
  ] as const) {
    const start = jsonKeyLine(lines, block);
    for (const [name, version] of stringEntries(data[block])) {
      if (!PACKAGE_NAME.test(name)) continue;
      dependencies.push({
        name,
        version: version.slice(0, 80),
        ecosystem: "composer",
        scope,
        manifest: file.path,
        line: jsonKeyLine(lines, name, start) || start,
      });
    }
  }
  const name = typeof data.name === "string" && PACKAGE_NAME.test(data.name) ? data.name : null;
  return {
    path: file.path,
    ecosystem: "composer",
    name,
    nameLine: jsonKeyLine(lines, "name"),
    dependencies,
    scripts: [],
    entries: [],
    workspaces: [],
  };
}

export function parseManifest(file: RepoFile): Manifest | null {
  const base = baseName(file.path);
  if (base === "package.json") return parsePackageJson(file);
  if (base === "pyproject.toml") return parsePyproject(file);
  if (/^requirements[\w.-]*\.txt$/.test(base)) return parseRequirements(file);
  if (base === "go.mod") return parseGoMod(file);
  if (base === "Cargo.toml") return parseCargo(file);
  if (base === "Gemfile") return parseGemfile(file);
  if (base === "composer.json") return parseComposer(file);
  return null;
}
