import { describe, expect, it } from "vitest";

import { loadKeylessChain } from "./model-chain-file";

describe("loadKeylessChain", () => {
  it("summarises the bundled config/models.json regardless of the working directory", () => {
    const original = process.cwd();
    process.chdir("/");
    try {
      const summary = loadKeylessChain();
      expect(summary.status).toBe("ok");
      if (summary.status !== "ok") return;
      expect(summary.providers.map((provider) => [provider.id, provider.placement])).toEqual([
        ["pollinations", "hosted"],
        ["webllm", "in-browser"],
      ]);
    } finally {
      process.chdir(original);
    }
  });
});
