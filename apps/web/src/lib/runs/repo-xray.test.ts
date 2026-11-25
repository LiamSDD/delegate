import { parseRunEvent, type RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { citationHref, diagramLayers, repoXrayOf } from "./repo-xray";
import { XRAY } from "./repo-xray-fixture";

function events(content: unknown): RunEvent[] {
  return [
    parseRunEvent({
      runId: "r",
      seq: 1,
      at: "2026-11-25T10:00:00.000Z",
      type: "artifact.created",
      payload: {
        artifactId: "a1",
        kind: "repo-xray",
        title: "Repo X-ray",
        version: 1,
        content: { bad: true },
      },
    }),
    parseRunEvent({
      runId: "r",
      seq: 2,
      at: "2026-11-25T10:00:01.000Z",
      type: "artifact.updated",
      payload: { artifactId: "a1", version: 2, content },
    }),
  ];
}

describe("repoXrayOf", () => {
  it("returns the latest version of the deliverable", () => {
    expect(repoXrayOf(events(XRAY))).toEqual({ xray: XRAY, version: 2, invalid: false });
  });

  it("flags a deliverable that does not match the schema instead of rendering it", () => {
    expect(repoXrayOf(events({ missionId: "repo-xray" }))).toEqual({
      xray: null,
      version: 2,
      invalid: true,
    });
    expect(repoXrayOf([])).toEqual({ xray: null, version: 0, invalid: false });
  });
});

describe("citationHref", () => {
  it("links to the cited lines at the analysed commit", () => {
    expect(citationHref(XRAY, { path: "src/a b.ts", startLine: 3, endLine: 9 })).toBe(
      "https://github.com/acme/widget/blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/src/a%20b.ts#L3-L9",
    );
    expect(
      citationHref(
        { ...XRAY, repo: { ...XRAY.repo, commit: null } },
        { path: "x.ts", startLine: 2, endLine: 2 },
      ),
    ).toBe("https://github.com/acme/widget/blob/HEAD/x.ts#L2");
  });
});

describe("diagramLayers", () => {
  it("orders modules from importers to leaves with their import targets", () => {
    const diagram = XRAY.architecture.diagram;
    if (diagram === null) throw new Error("diagram expected");
    expect(diagramLayers(diagram)).toEqual([
      [
        {
          id: "m1",
          module: "src/cli.ts",
          role: "CLI entry",
          targets: [{ module: "src/index.ts", imports: 1 }],
        },
      ],
      [
        {
          id: "m2",
          module: "src/index.ts",
          role: null,
          targets: [{ module: "src/parser.ts", imports: 2 }],
        },
      ],
      [{ id: "m3", module: "src/parser.ts", role: null, targets: [] }],
    ]);
  });

  it("survives import cycles", () => {
    const layers = diagramLayers({
      mermaid: "flowchart LR",
      nodes: [
        { id: "m1", module: "a.ts" },
        { id: "m2", module: "b.ts" },
      ],
      edges: [
        { from: "m1", to: "m2", imports: 1 },
        { from: "m2", to: "m1", imports: 1 },
      ],
      source: "import-graph",
    });
    expect(
      layers
        .flat()
        .map((node) => node.module)
        .sort(),
    ).toEqual(["a.ts", "b.ts"]);
  });
});
