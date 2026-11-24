import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@delegate/evals", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/evals");
  });
});
