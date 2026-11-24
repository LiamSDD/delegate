export type DetectedMission =
  | {
      kind: "company";
      label: "Company X-ray + AI Automation Audit";
      missionIds: readonly ["company-xray", "automation-audit"];
      target: string;
      url: string;
    }
  | {
      kind: "repo";
      label: "Repo X-ray";
      missionIds: readonly ["repo-xray"];
      target: string;
      url: string;
    }
  | {
      kind: "goal";
      label: "Custom goal";
      missionIds: readonly ["custom-goal"];
      target: string;
    };

export type DetectedKind = DetectedMission["kind"];

export const MAX_INPUT_LENGTH = 2000;

const HTTP_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const HOSTNAME = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,63}|xn--[a-z\d-]{2,59})$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_OWNER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const GITHUB_REPO = /^[\w.-]{1,100}$/;
const GITHUB_RESERVED = new Set([
  "about",
  "apps",
  "collections",
  "customer-stories",
  "enterprise",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "team",
  "topics",
  "trending",
]);

function parsePublicUrl(text: string): URL | null {
  if (/\s/.test(text) || text.includes("@")) return null;
  if (ANY_SCHEME.test(text) && !HTTP_SCHEME.test(text)) return null;
  const candidate = HTTP_SCHEME.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.port !== "" || !HOSTNAME.test(url.hostname)) return null;
  return url;
}

function githubRepo(url: URL): string | null {
  if (!GITHUB_HOSTS.has(url.hostname)) return null;
  const [owner, rawRepo] = url.pathname.split("/").filter((segment) => segment !== "");
  if (owner === undefined || rawRepo === undefined) return null;
  if (GITHUB_RESERVED.has(owner.toLowerCase()) || !GITHUB_OWNER.test(owner)) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!GITHUB_REPO.test(repo) || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

function companyUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname}${path}`;
}

export function detectMission(raw: string): DetectedMission | null {
  const text = raw.trim().slice(0, MAX_INPUT_LENGTH);
  if (text === "") return null;

  const url = parsePublicUrl(text);
  if (url !== null) {
    const repo = githubRepo(url);
    if (repo !== null) {
      return {
        kind: "repo",
        label: "Repo X-ray",
        missionIds: ["repo-xray"],
        target: repo,
        url: `https://github.com/${repo}`,
      };
    }
    return {
      kind: "company",
      label: "Company X-ray + AI Automation Audit",
      missionIds: ["company-xray", "automation-audit"],
      target: url.hostname.replace(/^www\./, ""),
      url: companyUrl(url),
    };
  }

  return {
    kind: "goal",
    label: "Custom goal",
    missionIds: ["custom-goal"],
    target: text.replace(/\s+/g, " "),
  };
}
