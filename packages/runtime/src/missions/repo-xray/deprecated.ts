import { type Dependency, type Ecosystem } from "./manifests";

export const DEPRECATED_LIST_AS_OF = "2026-11";

export interface DeprecationNote {
  ecosystem: Ecosystem;
  name: string;
  reason: string;
  severity: "low" | "medium" | "high";
}

export const KNOWN_DEPRECATIONS: readonly DeprecationNote[] = [
  {
    ecosystem: "npm",
    name: "request",
    reason: "deprecated by its maintainers since 2020",
    severity: "medium",
  },
  {
    ecosystem: "npm",
    name: "request-promise",
    reason: "deprecated together with request",
    severity: "medium",
  },
  {
    ecosystem: "npm",
    name: "node-sass",
    reason: "deprecated; Dart Sass (sass) replaces it",
    severity: "medium",
  },
  {
    ecosystem: "npm",
    name: "tslint",
    reason: "deprecated in favour of ESLint with typescript-eslint",
    severity: "low",
  },
  {
    ecosystem: "npm",
    name: "babel-eslint",
    reason: "deprecated; renamed @babel/eslint-parser",
    severity: "low",
  },
  {
    ecosystem: "npm",
    name: "istanbul",
    reason: "unmaintained; nyc or c8 replace it",
    severity: "low",
  },
  { ecosystem: "npm", name: "gulp-util", reason: "deprecated by the gulp team", severity: "low" },
  { ecosystem: "npm", name: "node-uuid", reason: "deprecated; renamed uuid", severity: "low" },
  {
    ecosystem: "npm",
    name: "coffee-script",
    reason: "deprecated; renamed coffeescript",
    severity: "low",
  },
  {
    ecosystem: "npm",
    name: "querystring",
    reason: "deprecated legacy API; URLSearchParams replaces it",
    severity: "low",
  },
  {
    ecosystem: "npm",
    name: "moment",
    reason: "in maintenance mode; its authors recommend alternatives",
    severity: "low",
  },
  {
    ecosystem: "npm",
    name: "left-pad",
    reason: "deprecated; String.prototype.padStart replaces it",
    severity: "low",
  },
  {
    ecosystem: "npm",
    name: "har-validator",
    reason: "deprecated, pulled in by request",
    severity: "low",
  },
  {
    ecosystem: "pypi",
    name: "nose",
    reason: "unmaintained since 2016 and broken on current Python",
    severity: "medium",
  },
  {
    ecosystem: "pypi",
    name: "pycrypto",
    reason: "unmaintained with known vulnerabilities; use pycryptodome or cryptography",
    severity: "high",
  },
  {
    ecosystem: "pypi",
    name: "mock",
    reason: "backport of unittest.mock, unnecessary on Python 3",
    severity: "low",
  },
  {
    ecosystem: "pypi",
    name: "distribute",
    reason: "merged back into setuptools long ago",
    severity: "low",
  },
  {
    ecosystem: "go",
    name: "github.com/dgrijalva/jwt-go",
    reason: "unmaintained with a known vulnerability; golang-jwt/jwt replaces it",
    severity: "high",
  },
  {
    ecosystem: "go",
    name: "github.com/golang/protobuf",
    reason: "superseded by google.golang.org/protobuf",
    severity: "low",
  },
  {
    ecosystem: "go",
    name: "github.com/pkg/errors",
    reason: "archived; the standard errors package covers wrapping",
    severity: "low",
  },
  {
    ecosystem: "cargo",
    name: "failure",
    reason: "deprecated; thiserror or anyhow replace it",
    severity: "low",
  },
];

export interface DependencyRisk {
  dependency: Dependency;
  kind: "deprecated-dependency" | "unpinned-dependency";
  severity: "low" | "medium" | "high";
  reason: string;
}

const UNPINNED = /^(\*|latest|x|)$/i;
const REMOTE = /^(git(\+\w+)?:|https?:|github:|file:|link:)/;

export function dependencyRisks(dependencies: readonly Dependency[]): DependencyRisk[] {
  const risks: DependencyRisk[] = [];
  for (const dependency of dependencies) {
    const note = KNOWN_DEPRECATIONS.find(
      (entry) =>
        entry.ecosystem === dependency.ecosystem &&
        entry.name.toLowerCase() === dependency.name.toLowerCase(),
    );
    if (note !== undefined) {
      risks.push({
        dependency,
        kind: "deprecated-dependency",
        severity: note.severity,
        reason: `${dependency.name} is ${note.reason} (static list as of ${DEPRECATED_LIST_AS_OF})`,
      });
      continue;
    }
    const version = dependency.version.trim();
    if (dependency.ecosystem === "npm" && (UNPINNED.test(version) || REMOTE.test(version))) {
      risks.push({
        dependency,
        kind: "unpinned-dependency",
        severity: "low",
        reason: `${dependency.name} is declared as "${version || "any"}", so installs are not reproducible`,
      });
    }
  }
  return risks;
}
