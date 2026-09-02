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
  // What must NEVER be copied into .next/standalone.
  //
  // The tracer decides what the standalone server needs by following the code.
  // When it meets a path it cannot resolve statically — and src/lib/claude-cli.ts
  // is full of them, since it hunts for an executable across several directories
  // — it gives up and takes the whole tracing root. That produced a 533 MB
  // standalone carrying screenshots/, electron/ (including the 70 MB bundled
  // node.exe) and dist-electron/ — the previous .exe packed inside the new one,
  // which went from 87 MB to 268 MB. It also COMPOUNDS: the mirror under
  // electron/resources/standalone is itself inside the root, so the next build
  // copies the previous copy. One more build reached 1.7 GB.
  //
  // None of these three are runtime dependencies of the Next server: Electron
  // and the bundled node are packaged separately by electron-builder, and the
  // screenshots only exist for the README.
  outputFileTracingExcludes: {
    '*': [
      'dist-electron/**',
      'electron/**',
      'screenshots/**',
      // The TypeScript sources are compiled into .next; shipping them again
      // only adds weight to the exe — and the copy inside the mirror was then
      // type-checked as if it were the project, which broke `npm run check`
      // with errors from a stale duplicate of a file that was already fixed.
      'src/**',
      // Development-only files that the tracer sweeps up because they sit in
      // the root. None is read at runtime, and HANDOFF.md, AGENTS.md and
      // CLAUDE.md are internal notes that have no business inside a user's
      // copy of the app. The license texts deliberately stay: LICENSE and
      // THIRD-PARTY-NOTICES.md belong with the binary.
      'HANDOFF.md',
      'AGENTS.md',
      'CLAUDE.md',
      'eslint.config.mjs',
      'postcss.config.mjs',
      'components.json',
      'tsconfig.json',
      'tsconfig.tsbuildinfo',
    ],
  },
};

export default nextConfig;
