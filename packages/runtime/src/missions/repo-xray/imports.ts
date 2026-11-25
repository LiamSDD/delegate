import { extensionOf, fileLines, type RepoFile } from "./snapshot";

export const JS_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
export const PY_EXTENSIONS = new Set(["py"]);

export interface ImportEdge {
  from: string;
  to: string;
  line: number;
}

export interface ExternalImport {
  from: string;
  specifier: string;
  line: number;
}

export interface ImportGraph {
  edges: ImportEdge[];
  external: ExternalImport[];
  unresolved: number;
}

const JS_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"'\n]+)["']/g,
  /^\s*import\s+["']([^"'\n]+)["']/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
];

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function joinPath(base: string, relative: string): string | null {
  const parts = base === "" ? [] : base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

function resolveJs(
  files: ReadonlyMap<string, RepoFile>,
  from: string,
  specifier: string,
): string | null {
  const target = joinPath(dirname(from), specifier);
  if (target === null) return null;
  const candidates = [target, target.replace(/\.(m|c)?js$/, ""), target.replace(/\.jsx$/, "")];
  for (const candidate of candidates)
    for (const suffix of RESOLVE_SUFFIXES)
      if (files.has(candidate + suffix)) return candidate + suffix;
  return null;
}

export function packageOfSpecifier(specifier: string): string | null {
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return name === undefined || name === "" ? null : name;
}

function jsSpecifiers(file: RepoFile): { specifier: string; line: number }[] {
  const found: { specifier: string; line: number }[] = [];
  fileLines(file).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const pattern of JS_PATTERNS)
      for (const match of raw.matchAll(pattern))
        found.push({ specifier: match[1] ?? "", line: index + 1 });
  });
  return found;
}

function pythonRoots(files: ReadonlyMap<string, RepoFile>): string[] {
  const roots = new Set<string>([""]);
  for (const path of files.keys()) {
    if (!path.endsWith("/__init__.py")) continue;
    const packageDir = dirname(path);
    const parent = dirname(packageDir);
    if (!files.has(`${parent === "" ? "" : `${parent}/`}__init__.py`)) roots.add(parent);
  }
  return [...roots];
}

function resolvePython(
  files: ReadonlyMap<string, RepoFile>,
  roots: readonly string[],
  from: string,
  module: string,
): string | null {
  const dots = /^\.*/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).replace(/\./g, "/");
  const bases: string[] = [];
  if (dots > 0) {
    let base = dirname(from);
    for (let level = 1; level < dots; level += 1) base = dirname(base);
    bases.push(base);
  } else bases.push(...roots);
  for (const base of bases) {
    const stem = [base, rest].filter((part) => part !== "").join("/");
    for (const candidate of [`${stem}.py`, `${stem}/__init__.py`])
      if (stem !== "" && files.has(candidate)) return candidate;
  }
  return null;
}

function pythonImports(file: RepoFile): { module: string; names: string[]; line: number }[] {
  const found: { module: string; names: string[]; line: number }[] = [];
  fileLines(file).forEach((raw, index) => {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+\(?\s*([\w\s,*]+)/.exec(raw);
    if (from !== null) {
      found.push({
        module: from[1] ?? "",
        names: (from[2] ?? "")
          .split(",")
          .map((name) => name.trim().split(/\s+/)[0] ?? "")
          .filter((name) => /^\w+$/.test(name)),
        line: index + 1,
      });
      return;
    }
    const plain = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(raw);
    if (plain !== null)
      for (const module of (plain[1] ?? "").split(","))
        found.push({ module: module.trim(), names: [], line: index + 1 });
  });
  return found;
}

export function buildImportGraph(
  files: ReadonlyMap<string, RepoFile>,
  workspacePackages: ReadonlyMap<string, string>,
): ImportGraph {
  const edges: ImportEdge[] = [];
  const external: ExternalImport[] = [];
  let unresolved = 0;
  const roots = pythonRoots(files);
  const seen = new Set<string>();
  const add = (edge: ImportEdge) => {
    const key = `${edge.from}>${edge.to}`;
    if (edge.from === edge.to || seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  for (const file of files.values()) {
    const extension = extensionOf(file.path);
    if (JS_EXTENSIONS.has(extension)) {
      for (const { specifier, line } of jsSpecifiers(file)) {
        if (specifier.startsWith(".")) {
          const to = resolveJs(files, file.path, specifier);
          if (to === null) unresolved += 1;
          else add({ from: file.path, to, line });
          continue;
        }
        const name = packageOfSpecifier(specifier);
        if (name === null) continue;
        const workspaceEntry = workspacePackages.get(name);
        if (workspaceEntry !== undefined) add({ from: file.path, to: workspaceEntry, line });
        else external.push({ from: file.path, specifier: name, line });
      }
    } else if (PY_EXTENSIONS.has(extension)) {
      for (const entry of pythonImports(file)) {
        const target = resolvePython(files, roots, file.path, entry.module);
        let resolvedAny = false;
        for (const name of entry.names) {
          const submodule = resolvePython(
            files,
            roots,
            file.path,
            `${entry.module}${entry.module.endsWith(".") ? "" : "."}${name}`,
          );
          if (submodule !== null) {
            add({ from: file.path, to: submodule, line: entry.line });
            resolvedAny = true;
          }
        }
        if (target !== null && !resolvedAny) add({ from: file.path, to: target, line: entry.line });
        else if (target === null && !resolvedAny) {
          if (entry.module.startsWith(".")) unresolved += 1;
          else {
            const top = entry.module.split(".")[0] ?? "";
            if (top !== "") external.push({ from: file.path, specifier: top, line: entry.line });
          }
        }
      }
    }
  }
  return { edges, external, unresolved };
}
