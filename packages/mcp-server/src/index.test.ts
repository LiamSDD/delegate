import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@delegate/mcp-server", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/mcp-server");
  });
});
