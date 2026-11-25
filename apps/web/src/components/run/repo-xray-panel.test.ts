import { parseRunEvent } from "@delegate/runtime";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { XRAY } from "@/lib/runs/repo-xray-fixture";

import { RepoXrayPanel } from "./repo-xray-panel";

const created = parseRunEvent({
  runId: "r",
  seq: 1,
  at: "2026-11-25T10:00:00.000Z",
  type: "artifact.created",
  payload: { artifactId: "a1", kind: "repo-xray", title: "Repo X-ray", version: 1, content: XRAY },
});

describe("RepoXrayPanel", () => {
  it("renders the map, cited lines, hotspots and a disabled Ship it button", () => {
    const html = renderToString(
      createElement(RepoXrayPanel, { events: [created], running: false }),
    );
    expect(html).toContain("acme/widget");
    expect(html).toContain("src/cli.ts:1");
    expect(html).toContain("blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/src/io.ts#L5");
    expect(html).toContain("Dynamic code evaluation in src/io.ts");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Ship it/);
    expect(html).toContain("Arrives next");
    expect(html).toContain("flowchart LR");
  });

  it("shows a loading state while running and an honest empty state after", () => {
    expect(renderToString(createElement(RepoXrayPanel, { events: [], running: true }))).toContain(
      "downloaded once as an archive",
    );
    expect(renderToString(createElement(RepoXrayPanel, { events: [], running: false }))).toContain(
      "This run produced no Repo X-ray.",
    );
  });
});
