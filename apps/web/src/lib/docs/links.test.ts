import { describe, expect, it } from "vitest";

import { REPO_URL } from "@/lib/site";

import { type LinkTargets, repoBlobUrl, repoEditUrl, resolveLink, resolveRepoPath } from "./links";

const ROUTES: Record<string, string> = {
  "docs/SECURITY.md": "/docs/trust/security",
  "docs/adr/0002-quarantined-reader.md": "/docs/architecture/adr/0002-quarantined-reader",
  "docs/guides/quickstart.md": "/docs/quickstart",
  "packages/db/README.md": "/docs/architecture/database",
  "docs/adr": "/docs/architecture/adr",
};

const targets: LinkTargets = { routeForSource: (source) => ROUTES[source] };

function resolve(href: string, from = "docs/guides/missions.md") {
  return resolveLink(href, from, targets);
}

describe("resolveRepoPath", () => {
  it("resolves against the linking file's folder", () => {
    expect(resolveRepoPath("docs/guides/a.md", "b.md")).toBe("docs/guides/b.md");
    expect(resolveRepoPath("docs/guides/a.md", "./b.md")).toBe("docs/guides/b.md");
    expect(resolveRepoPath("docs/guides/a.md", "../adr/x.md")).toBe("docs/adr/x.md");
    expect(resolveRepoPath("docs/guides/a.md", "../../packages/db/README.md")).toBe(
      "packages/db/README.md",
    );
    expect(resolveRepoPath("docs/guides/a.md", "/SPEC.md")).toBe("SPEC.md");
  });

  it("refuses paths that leave the repository", () => {
    expect(resolveRepoPath("docs/a.md", "../../etc/passwd")).toBeNull();
    expect(resolveRepoPath("docs/a.md", "..")).toBeNull();
    expect(resolveRepoPath("docs/a.md", "a\\b.md")).toBeNull();
  });
});

describe("resolveLink", () => {
  it("rewrites relative links between documents to docs routes", () => {
    expect(resolve("quickstart.md")).toEqual({
      kind: "doc",
      href: "/docs/quickstart",
      route: "/docs/quickstart",
      source: "docs/guides/quickstart.md",
      anchor: null,
    });
    expect(resolve("../SECURITY.md#crawler")).toMatchObject({
      kind: "doc",
      href: "/docs/trust/security#crawler",
      anchor: "crawler",
    });
    expect(resolve("../../packages/db/README.md?plain=1#retention")).toMatchObject({
      kind: "doc",
      href: "/docs/architecture/database#retention",
    });
    expect(resolve("0002-quarantined-reader.md", "docs/adr/0011-ship-a-pr.md")).toMatchObject({
      kind: "doc",
      route: "/docs/architecture/adr/0002-quarantined-reader",
    });
    expect(resolve("../adr/")).toMatchObject({ kind: "doc", route: "/docs/architecture/adr" });
  });

  it("keeps in-page anchors on the page", () => {
    expect(resolve("#limits")).toEqual({ kind: "anchor", href: "#limits", anchor: "limits" });
    expect(resolve("#gr%C3%B6%C3%9Fe")).toMatchObject({ kind: "anchor", anchor: "größe" });
    expect(resolve("#")).toMatchObject({ kind: "invalid" });
  });

  it("sends other repository files to GitHub", () => {
    expect(resolve("../../packages/runtime/src/router.ts")).toEqual({
      kind: "repo",
      href: `${REPO_URL}/blob/main/packages/runtime/src/router.ts`,
      path: "packages/runtime/src/router.ts",
    });
    expect(resolve("/SPEC.md#roadmap")).toMatchObject({
      kind: "repo",
      href: `${REPO_URL}/blob/main/SPEC.md#roadmap`,
    });
    expect(repoBlobUrl("docs/DEPLOY.md")).toBe(`${REPO_URL}/blob/main/docs/DEPLOY.md`);
    expect(repoEditUrl("docs/DEPLOY.md")).toBe(`${REPO_URL}/edit/main/docs/DEPLOY.md`);
  });

  it("turns links to the live site into same-deployment paths", () => {
    expect(resolve("https://delegate-beryl.vercel.app/settings/connections")).toEqual({
      kind: "site",
      href: "/settings/connections",
    });
    expect(resolve("https://delegate-beryl.vercel.app")).toEqual({ kind: "site", href: "/" });
    expect(resolve("https://delegate-beryl.vercel.app/evals#redteam")).toEqual({
      kind: "site",
      href: "/evals#redteam",
    });
  });

  it("passes other web and mail links through", () => {
    expect(resolve("https://example.com/a?b=1#c")).toEqual({
      kind: "external",
      href: "https://example.com/a?b=1#c",
    });
    expect(resolve("http://localhost:3000")).toEqual({
      kind: "external",
      href: "http://localhost:3000/",
    });
    expect(resolve("mailto:security@example.com")).toMatchObject({ kind: "external" });
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/x",
    "https://user:pass@example.com/",
    "../../../outside.md",
    "%E0%A4%A.md",
    "mailto:<script>",
    "",
  ])("refuses %j", (href) => {
    expect(resolve(href).kind).toBe("invalid");
  });
});
