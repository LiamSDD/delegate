import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@delegate/policy", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/policy");
  });
});
