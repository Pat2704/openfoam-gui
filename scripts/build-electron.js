#!/usr/bin/env node
/**
 * build-electron.js
 *
 * Single entry point for producing OpenFOAMStudio-v2-portable.exe.
 *
 *   1. next build + copy static/public into .next/standalone  (scripts/build.js)
 *   2. assemble electron/resources/{bin,standalone}           (electron/scripts/prepare-resources.js)
 *   3. electron-builder --win, reading electron/electron-builder.yml
 *
 * Output: dist-electron/OpenFOAMStudio-v2-portable.exe
 *
 * Usage:
 *   node scripts/build-electron.js              # full build
 *   node scripts/build-electron.js --skip-build # reuse the existing .next build
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_BUILD = process.argv.includes("--skip-build");

function log(msg) {
  console.log(`[electron] ${msg}`);
}

// Always spawn Node directly (never through a shell): both this repo's path and
// the Node install path routinely contain spaces on Windows, and `shell: true`
// would split them into separate arguments.
function runNode(scriptPath, args) {
  log(`$ node ${[scriptPath, ...args].join(" ")}`);
  execFileSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, stdio: "inherit" });
}

function main() {
  if (SKIP_BUILD) {
    log("Skipping next build (--skip-build)");
  } else {
    log("[1/3] Building the Next.js standalone output...");
    runNode(path.join(ROOT, "scripts", "build.js"), []);
  }

  log("[2/3] Assembling electron/resources...");
  runNode(path.join(ROOT, "electron", "scripts", "prepare-resources.js"), []);

  log("[3/3] Packaging with electron-builder...");
  // Resolve electron-builder's own cli.js and run it with Node, rather than the
  // node_modules/.bin shim (a .cmd on Windows, which would need a shell).
  const cli = path.join(ROOT, "node_modules", "electron-builder", "cli.js");
  if (!fs.existsSync(cli)) {
    console.error("[electron] ERROR: electron-builder not installed. Run `npm install` first.");
    process.exit(1);
  }
  runNode(cli, [
    "--win",
    "--projectDir",
    path.join(ROOT, "electron"),
    "--config",
    path.join(ROOT, "electron", "electron-builder.yml"),
  ]);

  const out = path.join(ROOT, "dist-electron", "OpenFOAMStudio-v2-portable.exe");
  if (fs.existsSync(out)) {
    const mb = (fs.statSync(out).size / 1048576).toFixed(1);
    log(`SUCCESS: dist-electron/OpenFOAMStudio-v2-portable.exe (${mb} MB)`);
  } else {
    console.error("[electron] ERROR: expected artifact not found in dist-electron/");
    process.exit(1);
  }
}

main();
