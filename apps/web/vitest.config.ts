import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(import.meta.dirname, "src"),
      "@config": path.join(import.meta.dirname, "..", "..", "config"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
