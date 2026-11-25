import { REPO_URL } from "@/lib/site";

import { isSafeRepoPath } from "./repo";

export const LIVE_DEMO_ORIGIN = "https://delegate-beryl.vercel.app";
export const DOCS_BRANCH = "main";

export type ResolvedLink =
  | { kind: "anchor"; href: string; anchor: string }
  | { kind: "doc"; href: string; route: string; source: string; anchor: string | null }
  | { kind: "site"; href: string }
  | { kind: "repo"; href: string; path: string }
  | { kind: "external"; href: string }
  | { kind: "invalid"; reason: string };

export interface LinkTargets {
  routeForSource(source: string): string | undefined;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SAFE_SITE_PATH = /^\/(?!\/)[\w\-./~%[\]@!$&'()*+,;=:]*$/;

export function repoBlobUrl(repoPath: string): string {
  return `${REPO_URL}/blob/${DOCS_BRANCH}/${repoPath}`;
}

export function repoEditUrl(repoPath: string): string {
  return `${REPO_URL}/edit/${DOCS_BRANCH}/${repoPath}`;
}

export function resolveRepoPath(fromSource: string, target: string): string | null {
  const base = target.startsWith("/") ? [] : fromSource.split("/").slice(0, -1);
  const segments = [...base];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = segments.join("/");
  return isSafeRepoPath(resolved) ? resolved : null;
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function splitFragment(value: string): { path: string; anchor: string | null } {
  const hash = value.indexOf("#");
  const beforeHash = hash === -1 ? value : value.slice(0, hash);
  const query = beforeHash.indexOf("?");
  const anchor = hash === -1 ? null : value.slice(hash + 1);
  return {
    path: query === -1 ? beforeHash : beforeHash.slice(0, query),
    anchor: anchor === null || anchor === "" ? null : anchor,
  };
}

function external(raw: string): ResolvedLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", reason: "malformed URL" };
  }
  if (url.username !== "" || url.password !== "")
    return { kind: "invalid", reason: "credentials in URL" };
  if (url.origin === LIVE_DEMO_ORIGIN) {
    const site = `${url.pathname}${url.search}${url.hash}`;
    return SAFE_SITE_PATH.test(url.pathname)
      ? { kind: "site", href: site }
      : { kind: "invalid", reason: "unsafe site path" };
  }
  return { kind: "external", href: url.href };
}

export function resolveLink(
  rawHref: string,
  fromSource: string,
  targets: LinkTargets,
): ResolvedLink {
  const href = rawHref.trim();
  if (href === "") return { kind: "invalid", reason: "empty link" };
  if (href.startsWith("#")) {
    const anchor = decodePath(href.slice(1));
    return anchor === null || anchor === ""
      ? { kind: "invalid", reason: "empty anchor" }
      : { kind: "anchor", href: `#${encodeURIComponent(anchor)}`, anchor };
  }
  if (href.startsWith("//")) return { kind: "invalid", reason: "protocol-relative URL" };
  const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return external(href);
  if (scheme === "mailto")
    return /^mailto:[^\s<>"']+@[^\s<>"']+$/i.test(href)
      ? { kind: "external", href }
      : { kind: "invalid", reason: "malformed mailto" };
  if (scheme !== undefined) return { kind: "invalid", reason: `scheme ${scheme}: is not allowed` };

  const { path: rawPath, anchor: rawAnchor } = splitFragment(href);
  const decoded = decodePath(rawPath);
  const anchor = rawAnchor === null ? null : decodePath(rawAnchor);
  if (decoded === null || (rawAnchor !== null && anchor === null))
    return { kind: "invalid", reason: "malformed escape" };
  const target = resolveRepoPath(fromSource, decoded);
  if (target === null) return { kind: "invalid", reason: "path leaves the repository" };
  const route = targets.routeForSource(target);
  if (route !== undefined)
    return {
      kind: "doc",
      href: anchor === null ? route : `${route}#${encodeURIComponent(anchor)}`,
      route,
      source: target,
      anchor,
    };
  return {
    kind: "repo",
    href: `${repoBlobUrl(target.split("/").map(encodeURIComponent).join("/"))}${
      anchor === null ? "" : `#${encodeURIComponent(anchor)}`
    }`,
    path: target,
  };
}
