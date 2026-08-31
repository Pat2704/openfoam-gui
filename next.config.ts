import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep the standalone tracing root pinned to this project dir so the
  // emitted `.next/standalone/server.js` stays flat. Without this, Next.js
  // can infer a workspace root from a lockfile in a parent directory and
  // nest the output one or more levels deeper, which breaks the paths
  // electron/scripts/prepare-resources.js and scripts/start.js expect.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
