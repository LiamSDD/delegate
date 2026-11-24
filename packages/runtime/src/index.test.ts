import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@delegate/runtime", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/runtime");
  });
});
