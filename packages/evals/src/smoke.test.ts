import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVAL_MISSIONS } from "./missions";
import { runSmoke } from "./smoke";

describe("eval:smoke", () => {
  it("records and replays one gate case per mission with identical grades", async () => {
    const lines = await runSmoke(mkdtempSync(join(tmpdir(), "smoke-")));
    expect(lines.map((line) => line.mission)).toEqual([...EVAL_MISSIONS]);
    expect(lines.filter((line) => !line.ok)).toEqual([]);
  });
});
