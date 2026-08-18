#!/usr/bin/env node
/**
 * rebuild-standalone.js
 *
 * Rebuilds the OpenFOAM Studio (WSL2) standalone from scratch.
 * Workflow:
 *   1. Stops the dev server (if running) to free memory
 *   2. Cleans .next/ and dist/ (previous output)
 *   3. Runs `next build` (produces .next/standalone/)
 *   4. Copies .next/static, public/, and auxiliary files into the standalone
 *   5. Creates a .zip ready for deployment
 *
 * Usage:
 *   node scripts/rebuild-standalone.js           # full rebuild + zip
 *   node scripts/rebuild-standalone.js --no-zip  # skip zip
 *   bun run rebuild                                # via package.json
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const NEXT_DIR = path.join(ROOT, ".next");
const STANDALONE_DIR = path.join(NEXT_DIR, "standalone");
const DIST_DIR = path.join(ROOT, "dist");
const ZIP_OUT = path.join(DIST_DIR, "wslGUI-standalone-codex.zip");

const MAKE_ZIP = !process.argv.includes("--no-zip");

// ── Helpers ──

function log(msg) {
  console.log(`[rebuild] ${msg}`);
}

function rimraf(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    // Retry once (Windows file locks)
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function stopDevServer() {
  log("Stopping any running dev server / next-server processes...");
  try {
    if (os.platform() === "win32") {
      execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq next*" 2>nul', { stdio: "ignore" });
    } else {
      execSync("pkill -9 -f 'next-server' 2>/dev/null; pkill -9 -f 'next dev' 2>/dev/null; true", { stdio: "ignore" });
    }
  } catch {}
  // Give the OS a moment to release memory + file locks
  try { execSync("sleep 2", { stdio: "ignore" }); } catch {}
}

// ── Main ──

async function main() {
  const t0 = Date.now();
  log(`Rebuild started at ${new Date().toISOString()}`);
  log(`Root: ${ROOT}`);
  log(`Platform: ${os.platform()} ${os.arch()}, node ${process.version}, mem ${Math.round(os.totalmem() / 1048576)}MB`);

  // 1. Stop dev server
  stopDevServer();

  // 2. Clean previous artifacts
  log("Cleaning previous build artifacts (.next/, dist/)...");
  rimraf(NEXT_DIR);
  rimraf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 3. Run next build (with a generous memory limit to survive OOM on small VMs)
  log("Running `next build` (output: standalone)...");
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const buildEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=2048"].filter(Boolean).join(" "),
  };

  try {
    execSync(`node "${nextBin}" build`, {
      cwd: ROOT,
      stdio: "inherit",
      env: buildEnv,
      timeout: 600000, // 10 min hard cap
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    log("ERROR: `next build` failed.");
    log("  Refusing to package incomplete or stale output.");
    process.exit(1);
  }

  // 4. Verify standalone exists
  if (!fs.existsSync(path.join(STANDALONE_DIR, "server.js"))) {
    log("ERROR: .next/standalone/server.js not found after build. Aborting.");
    process.exit(1);
  }
  log("Standalone server.js found.");

  // 5. Copy .next/static into standalone/.next/static
  const staticSrc = path.join(NEXT_DIR, "static");
  const staticDst = path.join(STANDALONE_DIR, ".next", "static");
  if (fs.existsSync(staticSrc)) {
    log("Copying .next/static → standalone/.next/static...");
    copyDir(staticSrc, staticDst);
  }

  // 6. Copy public/ into standalone/public
  const publicSrc = path.join(ROOT, "public");
  if (fs.existsSync(publicSrc) && fs.readdirSync(publicSrc).length > 0) {
    log("Copying public/ → standalone/public...");
    copyDir(publicSrc, path.join(STANDALONE_DIR, "public"));
  }

  // 7. Copy only runtime/user-facing auxiliary files. Development scripts,
  // package metadata and diagnostics are not needed by the standalone server.
  log("Copying auxiliary files...");
  copyFile(path.join(ROOT, "start.bat"), path.join(STANDALONE_DIR, "start.bat"));
  copyFile(path.join(ROOT, "README.md"), path.join(STANDALONE_DIR, "README.md"));
  copyFile(path.join(ROOT, ".env"), path.join(STANDALONE_DIR, ".env"));

  // 8. Post-build verification checks (grep compiled chunks for fix markers)
  log("Running post-build verification checks...");
  const chunksDir = path.join(STANDALONE_DIR, ".next", "server", "chunks");
  const chunkFiles = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter(f => f.endsWith(".js")).map(f => path.join(chunksDir, f))
    : [];
  // Also include client-side bundles (React components live here, not in server chunks)
  const clientChunksDir = path.join(STANDALONE_DIR, ".next", "static", "chunks");
  const clientChunkFiles = fs.existsSync(clientChunksDir)
    ? fs.readdirSync(clientChunksDir).filter(f => f.endsWith(".js")).map(f => path.join(clientChunksDir, f))
    : [];
  const allChunks = [...chunkFiles, ...clientChunkFiles].map(f => fs.readFileSync(f, "utf-8")).join("\n");

  const checks = [
    { name: "Fix 1: killAllProcesses uses ps -e -o (no foamSource, no ps aux)",
      pattern: /ps -e -o pid= -o command=/, present: true },
    { name: "Fix 1: killAllProcesses no longer uses ps aux",
      pattern: /ps aux.*grep.*foamRun/, present: false },
    { name: "Fix 2 (current session): background uses temp script file + nohup",
      pattern: /wslgui_bg_.*\.sh/, present: true },
    { name: "Fix 2: background no longer uses nohup bash -c with nested quoting",
      pattern: /nohup bash -c/, present: false },
    { name: "Fix 2: background no longer uses setsid bash -c",
      pattern: /setsid bash -c/, present: false },
    { name: "Fix 3+6 (current session): export COLUMNS/LINES/TERM inside bash command (definitive screen bogus fix)",
      pattern: /export COLUMNS=80 LINES=24 TERM=dumb/, present: true },
    { name: "Previous fix: findBashrc uses for-loop with break",
      pattern: /for f in[^;]*;\s*do\s*\[ -f "\$f" \] && echo "\$f" && break/, present: true },
    { name: "Previous fix: explicit source /opt/openfoam13/etc/bashrc",
      pattern: /\/opt\/openfoam13\/etc\/bashrc/, present: true },
    { name: "Previous fix: writeFile via stdin (base64 -d without echo)",
      pattern: /base64 -d > /, present: true },
    { name: "Fix 4 (current session): normalizeCommand prepends bash to ./Allrun",
      pattern: /bash \.\//, present: true },
    { name: "Numeric timesteps (including decimal/exponential) serial + processor",
      pattern: /sort -gu\s*\|\s*uniq/, present: true },
    { name: "Live timestep monitor every 750ms",
      pattern: /750/, present: true },
    { name: "Fix 9 (current session): dashboard cache (Date.now for throttle)",
      pattern: /Date\.now\(\)/, present: true },
    { name: "Fix 10 (current session): file editor cache (new Map per cached file)",
      pattern: /new Map/, present: true },
    { name: "Fix 11 (current session): validateBoundaryConditions with patchTypes + wildcard (aligned v4.1)",
      pattern: /matches:/, present: true },
    { name: "Function executeCommandAsync present",
      pattern: /executeCommandAsync/, present: true },
    { name: "Function getProcesses present",
      pattern: /getProcesses/, present: true },
    { name: "Function killAllProcesses present",
      pattern: /killAllProcesses/, present: true },
  ];

  const checkResults = checks.map(c => {
    const found = c.pattern.test(allChunks);
    const pass = found === c.present;
    return { ...c, found, pass };
  });

  let passCount = 0;
  for (const c of checkResults) {
    const status = c.pass ? "PASS" : "FAIL";
    log(`  [${status}] ${c.name} (expected ${c.present ? "present" : "absent"}, ${c.found ? "found" : "not found"})`);
    if (c.pass) passCount++;
  }
  log(`Verification: ${passCount}/${checkResults.length} checks passed`);

  // 10. Report
  const sizeMB = (dir) => {
    let total = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    try { walk(dir); } catch {}
    return (total / 1048576).toFixed(1);
  };
  log(`Standalone assembled at: ${STANDALONE_DIR}`);
  log(`  size: ${sizeMB(STANDALONE_DIR)} MB`);

  // 11. Zip (optional)
  if (MAKE_ZIP) {
    log("Creating zip archive...");
    try {
      if (os.platform() === "win32") {
        // Use .NET directly: Compress-Archive may be unavailable on stripped-down Windows installs.
        if (fs.existsSync(ZIP_OUT)) fs.rmSync(ZIP_OUT, { force: true });
        const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${STANDALONE_DIR.replace(/'/g, "''")}','${ZIP_OUT.replace(/'/g, "''")}',[System.IO.Compression.CompressionLevel]::Optimal,$false)`;
        execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "inherit" });
      } else {
        // zip — must cd into standalone so paths are relative
        execSync(`cd "${STANDALONE_DIR}" && zip -r -q "${ZIP_OUT}" .`, { stdio: "inherit" });
      }
      const zipSize = (fs.statSync(ZIP_OUT).size / 1048576).toFixed(1);
      log(`Zip created: ${ZIP_OUT} (${zipSize} MB)`);
    } catch (e) {
      log(`WARNING: zip creation failed (${e.message}). Standalone dir is still usable.`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log("");
  log(`Done in ${elapsed}s.`);
  log("");
  log("=== OUTPUT ===");
  log(`  Directory : ${STANDALONE_DIR}`);
  if (MAKE_ZIP && fs.existsSync(ZIP_OUT)) log(`  Standalone zip : ${ZIP_OUT}`);
  log("");
  log("To run the standalone:");
  log(`  cd "${STANDALONE_DIR}" && NODE_ENV=production PORT=3000 node server.js`);
}

main().catch((err) => {
  console.error("[rebuild] FATAL:", err);
  process.exit(1);
});
