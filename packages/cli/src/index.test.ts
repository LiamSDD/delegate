import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@delegate/cli", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/cli");
  });
});
