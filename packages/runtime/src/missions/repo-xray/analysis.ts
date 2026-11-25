import { dependencyRisks, type DependencyRisk } from "./deprecated";
import { buildImportGraph, JS_EXTENSIONS, joinPath, type ImportGraph } from "./imports";
import { parseManifest, type Dependency, type Manifest } from "./manifests";
import {
  detectCi,
  frameworkSignals,
  isCodeFile,
  isTestFile,
  languageOf,
  scanRiskyPatterns,
  scanTodos,
  type CiConfig,
  type FrameworkSignal,
  type PatternHit,
  type TodoHit,
} from "./scan";
import { baseName, extensionOf, fileLines, type RepoFile, type RepoSnapshot } from "./snapshot";

export const ANALYSIS_LIMITS = {
  fileLevelModulesUpTo: 40,
  maxModules: 30,
  maxModuleDepth: 4,
  symbolsPerFile: 12,
  largestFiles: 8,
  mostImported: 10,
  todoFiles: 8,
  riskyHits: 40,
} as const;

const SAFE_PATH = /^[\w@+.,()[\]{}~ -]+(?:\/[\w@+.,()[\]{}~ -]+)*$/;
const SAFE_VERSION = /^[\w@^~<>=!.*:/+,|-]*(?: [\w@^~<>=!.*:/+,|-]+){0,4}$/;
const SAFE_SCRIPT = /^[\w@./:=+'" -]{1,120}$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,60}$/;

export function isSafeVersion(version: string): boolean {
  const words = version.split(" ").filter((token) => /^[A-Za-z]{3,}$/.test(token));
  return version.length <= 80 && SAFE_VERSION.test(version) && words.length <= 1;
}

export function isSafePath(path: string): boolean {
  return path.length <= 300 && SAFE_PATH.test(path);
}

const AUXILIARY =
  /^(?:(?:[\w.-]+\/)*(?:examples?|demos?|benchmarks?|\.[\w-]+)\/|docs?\/conf\.py$)|\.d\.[cm]?ts$|(^|\/)[\w.-]+\.config\.[cm]?[jt]s$|(^|\/)\.?eslintrc\.[cm]?js$|(^|\/)(setup|noxfile|conftest|fabfile)\.py$/;
const RE_EXPORT_SHELL = /(^|\/)(__init__\.py|index\.[cm]?[jt]sx?|mod\.rs)$/;

export function isAuxiliary(path: string): boolean {
  return AUXILIARY.test(path);
}

function isReExportShell(path: string): boolean {
  return RE_EXPORT_SHELL.test(path);
}

export function isSafeScript(command: string): boolean {
  return SAFE_SCRIPT.test(command);
}

export interface LanguageShare {
  language: string;
  bytes: number;
  files: number;
  share: number;
}

export interface EntryPoint {
  path: string;
  kind: "main" | "bin" | "exports" | "module" | "script" | "conventional";
  declaredIn: { path: string; line: number } | null;
}

export interface FileSymbols {
  path: string;
  symbols: { name: string; line: number }[];
}

export interface RepoModule {
  id: string;
  files: string[];
  codeFiles: number;
  bytes: number;
  lines: number;
  imports: string[];
  importedBy: string[];
  testFiles: string[];
  symbols: FileSymbols[];
}

export interface CoverageGap {
  module: string;
  file: string;
  lines: number;
  importedBy: number;
}

export interface RepoAnalysis {
  totals: { files: number; codeFiles: number; bytes: number; lines: number };
  topLevel: { path: string; files: number }[];
  languages: LanguageShare[];
  manifests: Manifest[];
  dependencies: Dependency[];
  dependencyRisks: DependencyRisk[];
  externalUsage: { name: string; files: number }[];
  entryPoints: EntryPoint[];
  graph: ImportGraph;
  modules: RepoModule[];
  moduleOf: ReadonlyMap<string, string>;
  largestFiles: { path: string; lines: number; bytes: number }[];
  mostImported: { path: string; importedBy: number }[];
  tests: { files: string[]; frameworks: FrameworkSignal[] };
  ci: CiConfig[];
  todos: { total: number; byMarker: Record<string, number>; hits: TodoHit[] };
  risky: PatternHit[];
  gaps: CoverageGap[];
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function moduleAssignment(codePaths: readonly string[]): Map<string, string> {
  if (codePaths.length <= ANALYSIS_LIMITS.fileLevelModulesUpTo)
    return new Map(codePaths.map((path) => [path, path]));
  const atDepth = (depth: number) =>
    new Map(
      codePaths.map((path) => {
        const directory = dirname(path);
        const segments = directory === "" ? [] : directory.split("/");
        return [path, segments.length === 0 ? "." : segments.slice(0, depth).join("/")];
      }),
    );
  let chosen = atDepth(1);
  for (let depth = 2; depth <= ANALYSIS_LIMITS.maxModuleDepth; depth += 1) {
    const candidate = atDepth(depth);
    if (new Set(candidate.values()).size > ANALYSIS_LIMITS.maxModules) break;
    chosen = candidate;
  }
  return chosen;
}

function symbolsOf(file: RepoFile): { name: string; line: number }[] {
  const extension = extensionOf(file.path);
  const patterns: RegExp[] = JS_EXTENSIONS.has(extension)
    ? [
        /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
      ]
    : extension === "py"
      ? [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/]
      : extension === "go"
        ? [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/, /^type\s+([A-Z]\w*)/]
        : extension === "rs"
          ? [/^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/]
          : [];
  const found: { name: string; line: number }[] = [];
  fileLines(file).forEach((raw, index) => {
    for (const pattern of patterns) {
      const name = pattern.exec(raw)?.[1];
      if (name !== undefined && IDENTIFIER.test(name) && !name.startsWith("_")) {
        found.push({ name, line: index + 1 });
        break;
      }
    }
  });
  return found.slice(0, ANALYSIS_LIMITS.symbolsPerFile);
}

function entryTargetPath(
  files: ReadonlyMap<string, RepoFile>,
  manifestDir: string,
  target: string,
): string | null {
  const joined = joinPath(manifestDir, target.replace(/^\.\//, ""));
  if (joined === null) return null;
  const output = /^(.*?)(?:dist|distribution|build|out|lib|esm|cjs)\/(.*)$/.exec(joined);
  const stems = [
    joined,
    ...(output === null
      ? []
      : ["src", "source", "lib"].map((root) => `${output[1] ?? ""}${root}/${output[2] ?? ""}`)),
  ];
  const candidates = stems.flatMap((stem) => [
    stem,
    stem.replace(/\.(c|m)?js$/, ".ts"),
    stem.replace(/\.(c|m)?js$/, ".tsx"),
    stem.replace(/\.(c|m)?js$/, ".mts"),
  ]);
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function pythonScriptTarget(files: ReadonlyMap<string, RepoFile>, target: string): string | null {
  const module = target.split(":")[0]?.replace(/\./g, "/") ?? "";
  if (module === "") return null;
  for (const root of ["", "src/"])
    for (const candidate of [
      `${root}${module}.py`,
      `${root}${module}/__init__.py`,
      `${root}${module}/__main__.py`,
    ])
      if (files.has(candidate)) return candidate;
  return null;
}

const CONVENTIONAL_ENTRIES = [
  /^((src|source|lib)\/)?(index|main|cli|app|server)\.[cm]?[jt]sx?$/,
  /^(src\/)?[\w-]+\/__main__\.py$/,
  /^__main__\.py$/,
  /^(src\/)?main\.py$/,
  /^(cmd\/[\w-]+\/)?main\.go$/,
  /^src\/(main|lib)\.rs$/,
];

function workspacePackages(
  files: ReadonlyMap<string, RepoFile>,
  manifests: readonly Manifest[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const manifest of manifests) {
    if (manifest.ecosystem !== "npm" || manifest.name === null) continue;
    const directory = dirname(manifest.path);
    const declared = manifest.entries
      .map((entry) => entryTargetPath(files, directory, entry.target))
      .find((path): path is string => path !== null);
    const prefix = directory === "" ? "" : `${directory}/`;
    const fallback = ["src/index.ts", "index.ts", "src/index.js", "index.js"]
      .map((candidate) => `${prefix}${candidate}`)
      .find((candidate) => files.has(candidate));
    const entry = declared ?? fallback;
    if (entry !== undefined) map.set(manifest.name, entry);
  }
  return map;
}

function sameStem(testPath: string, sourcePath: string): boolean {
  const stem = (path: string) =>
    baseName(path)
      .replace(/\.(test|spec)(?=\.)/, "")
      .replace(/^test_/, "")
      .replace(/_test(?=\.)/, "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
  const source = stem(sourcePath);
  return (
    source !== "index" && source !== "__init__" && source.length > 1 && stem(testPath) === source
  );
}

export function analyseSnapshot(snapshot: RepoSnapshot): RepoAnalysis {
  const files = snapshot.files;
  const all = [...files.values()].filter((file) => isSafePath(file.path));
  const languageTotals = new Map<string, { bytes: number; files: number }>();
  let totalLines = 0;
  let totalBytes = 0;
  for (const file of all) {
    totalLines += file.lineCount;
    totalBytes += file.bytes;
    const language = languageOf(file.path);
    if (language === null || !isCodeFile(file.path)) continue;
    const entry = languageTotals.get(language) ?? { bytes: 0, files: 0 };
    entry.bytes += file.bytes;
    entry.files += 1;
    languageTotals.set(language, entry);
  }
  const codeBytes = [...languageTotals.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const languages = [...languageTotals.entries()]
    .map(([language, entry]) => ({
      language,
      ...entry,
      share: codeBytes === 0 ? 0 : Math.round((entry.bytes / codeBytes) * 1000) / 1000,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const manifests = all.flatMap((file) => parseManifest(file) ?? []);
  const dependencies = manifests
    .flatMap((manifest) => manifest.dependencies)
    .map((dependency) =>
      isSafeVersion(dependency.version) ? dependency : { ...dependency, version: "(unparsed)" },
    );
  const safeFiles = new Map(all.map((file) => [file.path, file]));
  const graph = buildImportGraph(safeFiles, workspacePackages(safeFiles, manifests));

  const testFiles = all.filter((file) => isTestFile(file.path));
  const testPaths = new Set(testFiles.map((file) => file.path));
  const codeFiles = all.filter(
    (file) => isCodeFile(file.path) && !testPaths.has(file.path) && !isAuxiliary(file.path),
  );
  const moduleOf = moduleAssignment(codeFiles.map((file) => file.path));

  const importers = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const set = importers.get(edge.to) ?? new Set<string>();
    set.add(edge.from);
    importers.set(edge.to, set);
  }
  const modules = new Map<string, RepoModule>();
  for (const file of codeFiles) {
    const id = moduleOf.get(file.path) ?? file.path;
    const module = modules.get(id) ?? {
      id,
      files: [],
      codeFiles: 0,
      bytes: 0,
      lines: 0,
      imports: [],
      importedBy: [],
      testFiles: [],
      symbols: [],
    };
    module.files.push(file.path);
    module.codeFiles += 1;
    module.bytes += file.bytes;
    module.lines += file.lineCount;
    const symbols = symbolsOf(file);
    if (symbols.length > 0) module.symbols.push({ path: file.path, symbols });
    modules.set(id, module);
  }
  for (const edge of graph.edges) {
    const from = moduleOf.get(edge.from);
    const to = moduleOf.get(edge.to);
    if (to !== undefined && testPaths.has(edge.from)) {
      const target = modules.get(to);
      if (target !== undefined && !target.testFiles.includes(edge.from))
        target.testFiles.push(edge.from);
      continue;
    }
    if (from === undefined || to === undefined || from === to) continue;
    const source = modules.get(from);
    const target = modules.get(to);
    if (source !== undefined && !source.imports.includes(to)) source.imports.push(to);
    if (target !== undefined && !target.importedBy.includes(from)) target.importedBy.push(from);
  }
  for (const module of modules.values())
    for (const test of testFiles)
      if (
        !module.testFiles.includes(test.path) &&
        module.files.some((path) => sameStem(test.path, path))
      )
        module.testFiles.push(test.path);

  const entryPoints: EntryPoint[] = [];
  const seenEntries = new Set<string>();
  for (const manifest of manifests) {
    const directory = dirname(manifest.path);
    for (const entry of manifest.entries) {
      const path =
        manifest.ecosystem === "pypi"
          ? pythonScriptTarget(safeFiles, entry.target)
          : entryTargetPath(safeFiles, directory, entry.target);
      if (path === null || seenEntries.has(path) || isAuxiliary(path)) continue;
      seenEntries.add(path);
      entryPoints.push({
        path,
        kind: entry.kind,
        declaredIn: { path: manifest.path, line: entry.line },
      });
    }
  }
  for (const file of codeFiles)
    if (
      !seenEntries.has(file.path) &&
      CONVENTIONAL_ENTRIES.some((pattern) => pattern.test(file.path))
    ) {
      seenEntries.add(file.path);
      entryPoints.push({ path: file.path, kind: "conventional", declaredIn: null });
    }

  const externalCounts = new Map<string, Set<string>>();
  for (const usage of graph.external) {
    const set = externalCounts.get(usage.specifier) ?? new Set<string>();
    set.add(usage.from);
    externalCounts.set(usage.specifier, set);
  }
  const todoHits = all.flatMap(scanTodos);
  const byMarker: Record<string, number> = {};
  for (const hit of todoHits) byMarker[hit.marker] = (byMarker[hit.marker] ?? 0) + 1;

  const gaps: CoverageGap[] = [];
  for (const module of modules.values()) {
    if (module.testFiles.length > 0 || module.files.every(isReExportShell)) continue;
    const main = [...module.files]
      .map((path) => safeFiles.get(path))
      .filter((file): file is RepoFile => file !== undefined)
      .sort(
        (a, b) =>
          (importers.get(b.path)?.size ?? 0) - (importers.get(a.path)?.size ?? 0) ||
          b.lineCount - a.lineCount,
      )[0];
    if (main === undefined || main.lineCount < 5) continue;
    gaps.push({
      module: module.id,
      file: main.path,
      lines: module.lines,
      importedBy: module.importedBy.length,
    });
  }
  gaps.sort((a, b) => b.importedBy - a.importedBy || b.lines - a.lines);

  const topLevelCounts = new Map<string, number>();
  for (const file of all) {
    const top = file.path.includes("/") ? `${file.path.split("/")[0] ?? ""}/` : file.path;
    topLevelCounts.set(top, (topLevelCounts.get(top) ?? 0) + 1);
  }

  return {
    totals: {
      files: all.length,
      codeFiles: codeFiles.length,
      bytes: totalBytes,
      lines: totalLines,
    },
    topLevel: [...topLevelCounts.entries()]
      .map(([path, count]) => ({ path, files: count }))
      .sort((a, b) => b.files - a.files)
      .slice(0, 30),
    languages,
    manifests,
    dependencies,
    dependencyRisks: dependencyRisks(dependencies),
    externalUsage: [...externalCounts.entries()]
      .map(([name, set]) => ({ name, files: set.size }))
      .sort((a, b) => b.files - a.files)
      .slice(0, 20),
    entryPoints: entryPoints.slice(0, 12),
    graph,
    modules: [...modules.values()].sort(
      (a, b) => b.importedBy.length - a.importedBy.length || b.lines - a.lines,
    ),
    moduleOf,
    largestFiles: codeFiles
      .map((file) => ({ path: file.path, lines: file.lineCount, bytes: file.bytes }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, ANALYSIS_LIMITS.largestFiles),
    mostImported: [...importers.entries()]
      .filter(([path]) => !testPaths.has(path))
      .map(([path, set]) => ({
        path,
        importedBy: [...set].filter((from) => !testPaths.has(from)).length,
      }))
      .filter((entry) => entry.importedBy > 0)
      .sort((a, b) => b.importedBy - a.importedBy)
      .slice(0, ANALYSIS_LIMITS.mostImported),
    tests: {
      files: testFiles.map((file) => file.path),
      frameworks: frameworkSignals(dependencies, testFiles),
    },
    ci: all.flatMap((file) => detectCi(file) ?? []),
    todos: { total: todoHits.length, byMarker, hits: todoHits },
    risky: all.flatMap(scanRiskyPatterns).slice(0, ANALYSIS_LIMITS.riskyHits),
    gaps,
  };
}
