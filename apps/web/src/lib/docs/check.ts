import { LIVE_DIRECTIVES } from "./directives";
import { resolveLink } from "./links";
import { type DocEntry, type DocsRegistry, loadDoc, type LoadedDoc } from "./registry";
import { repoFileExists } from "./repo";

export interface DocProblem {
  source: string;
  subject: string;
  reason: string;
}

const APP_DIRECTORY = "apps/web/src/app";

function anchorsOf(doc: LoadedDoc): Set<string> {
  const anchors = new Set(doc.markdown.headings.map((heading) => heading.id));
  if (doc.markdown.titleId !== null) anchors.add(doc.markdown.titleId);
  return anchors;
}

export function appRouteExists(pathname: string, registry: DocsRegistry): boolean {
  const clean = pathname.replace(/\/+$/, "");
  if (clean === "/docs" || clean.startsWith("/docs/"))
    return registry.bySlug(clean.split("/").slice(2)) !== undefined;
  return ["page.tsx", "route.ts"].some((file) =>
    repoFileExists(`${APP_DIRECTORY}${clean}/${file}`),
  );
}

export function checkDocs(
  registry: DocsRegistry,
  load: (entry: DocEntry) => LoadedDoc = loadDoc,
  exists: (repoPath: string) => boolean = repoFileExists,
): DocProblem[] {
  const problems: DocProblem[] = [];
  const routes = new Map<string, string>();
  const knownDirectives: ReadonlySet<string> = new Set(LIVE_DIRECTIVES);

  for (const entry of registry.entries) {
    const clash = routes.get(entry.route);
    if (clash !== undefined)
      problems.push({
        source: entry.source,
        subject: entry.route,
        reason: `route also used by ${clash}`,
      });
    routes.set(entry.route, entry.source);
    if (!exists(entry.source)) {
      problems.push({
        source: entry.source,
        subject: entry.source,
        reason: "source file is missing",
      });
      continue;
    }

    const doc = load(entry);
    const ownAnchors = anchorsOf(doc);
    if (doc.markdown.title === null)
      problems.push({ source: entry.source, subject: "title", reason: "no level-one heading" });
    for (const directive of doc.markdown.directives)
      if (!knownDirectives.has(directive))
        problems.push({
          source: entry.source,
          subject: directive,
          reason: "unknown live directive",
        });

    for (const link of doc.markdown.links) {
      const resolved = resolveLink(link.href, entry.source, registry);
      const report = (reason: string) => {
        problems.push({ source: entry.source, subject: link.href, reason });
      };
      switch (resolved.kind) {
        case "invalid":
          report(resolved.reason);
          break;
        case "anchor":
          if (!ownAnchors.has(resolved.anchor)) report("no heading with this anchor on the page");
          break;
        case "doc": {
          const target = registry.bySource(resolved.source);
          if (resolved.anchor !== null && target !== undefined) {
            if (!anchorsOf(load(target)).has(resolved.anchor))
              report(`no heading with this anchor in ${resolved.source}`);
          }
          break;
        }
        case "repo":
          if (!exists(resolved.path)) report(`${resolved.path} does not exist in the repository`);
          break;
        case "site": {
          const pathname = resolved.href.split(/[?#]/)[0] ?? "";
          if (!appRouteExists(pathname === "" ? "/" : pathname, registry))
            report(`${pathname} is not a page of the app`);
          break;
        }
        case "external":
          break;
      }
    }
  }
  return problems;
}
