import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep the standalone tracing root pinned to this project dir so the
  // emitted `.next/standalone/server.js` stays flat (otherwise Next.js
  // auto-detects a parent workspace root from the upstream bun.lock and
  // nests the output under working/wsl-source/).
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
