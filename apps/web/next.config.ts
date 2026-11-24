import path from "node:path";
import type { NextConfig } from "next";

const monorepoRoot = path.join(import.meta.dirname, "..", "..");

export const STATIC_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  transpilePackages: ["@delegate/runtime", "@delegate/db"],
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] }]);
  },
};

export default nextConfig;
