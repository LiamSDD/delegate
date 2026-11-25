import { describe, expect, it } from "vitest";

import { type RepoDiff } from "./schema";
import { DiffRejectedError, approvedFileChanges, sha256Hex } from "./workspace";

const bytes = new TextEncoder().encode("export const answer = 42;\n");

function diff(overrides: Partial<RepoDiff> = {}): RepoDiff {
  return {
    baseSha: "a".repeat(40),
    patch: "",
    files: [
      { path: "src/answer.ts", status: "modified", mode: "100644", additions: 1, deletions: 1 },
      { path: "src/old.ts", status: "deleted", mode: "100644", additions: 0, deletions: 3 },
    ],
    contents: [
      {
        path: "src/answer.ts",
        sha256: sha256Hex(bytes),
        base64: Buffer.from(bytes).toString("base64"),
      },
    ],
    stat: { files: 2, additions: 1, deletions: 4 },
    ...overrides,
  };
}

describe("approvedFileChanges", () => {
  it("returns exactly the pinned bytes of the approved diff", () => {
    const files = approvedFileChanges(diff());
    expect(files).toHaveLength(2);
    expect(Buffer.from(files[0]?.content ?? []).toString("utf8")).toBe(
      "export const answer = 42;\n",
    );
    expect(files[1]).toEqual({ path: "src/old.ts", mode: "100644", content: null });
  });

  it("refuses content that does not match its approved SHA-256", () => {
    const tampered = diff({
      contents: [
        {
          path: "src/answer.ts",
          sha256: sha256Hex(bytes),
          base64: Buffer.from("tampered").toString("base64"),
        },
      ],
    });
    expect(() => approvedFileChanges(tampered)).toThrow(DiffRejectedError);
  });

  it("refuses a diff recorded without pinned contents or missing a file", () => {
    const { contents: _dropped, ...unpinned } = diff();
    expect(() => approvedFileChanges(unpinned)).toThrow(DiffRejectedError);
    expect(() => approvedFileChanges(diff({ contents: [] }))).toThrow(/no approved content/);
  });
});
