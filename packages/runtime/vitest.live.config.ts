import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 60_000,
    reporters: ["dot"],
  },
});
