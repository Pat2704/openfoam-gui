#!/usr/bin/env node
/**
 * package-source.js
 *
 * Creates a zip of the project source (without node_modules, .next, dist, etc.)
 * Output: dist/wslGUI-source.zip
 *
 * Usage:
 *   node scripts/package-source.js
 *   bun run source-zip
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const ZIP_OUT = path.join(DIST_DIR, "wslGUI-source.zip");

function log(msg) {
  console.log(`[source] ${msg}`);
}

function main() {
  const t0 = Date.now();
  log(`Packaging source at ${new Date().toISOString()}`);
  log(`Root: ${ROOT}`);

  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Remove previous source zip
  if (fs.existsSync(ZIP_OUT)) fs.rmSync(ZIP_OUT, { force: true });

  // Files/dirs to EXCLUDE from the source zip
  const excludes = [
    "node_modules",
    ".next",
    "dist",
    ".git",
    "upload",
    "download",
    "tool-results",
    "tests",
    "skills",
    "examples",
    "mini-services",
    ".zscripts",
    "dev.log",
    "server.log",
    "*.log",
    "db/*.db",
    "db/*.db-journal",
    ".DS_Store",
    "Thumbs.db",
  ];

  log("Creating source zip (excluding node_modules, .next, dist, .git, etc.)...");

  if (os.platform() === "win32") {
    // PowerShell — build exclude list and use Compress-Archive
    // Compress-Archive doesn't support excludes natively, so we copy to a
    // temp dir first, then zip. Simpler: use `git archive` if available.
    try {
      // Try git archive first (cleanest)
      execSync(`git archive --format=zip --output="${ZIP_OUT}" HEAD`, {
        cwd: ROOT,
        stdio: "inherit",
      });
      log("Created via git archive");
    } catch {
      // Fallback: PowerShell with manual exclude via robocopy + Compress-Archive
      log("git archive failed, using PowerShell fallback...");
      const tempDir = path.join(os.tmpdir(), `wslgui-src-${Date.now()}`);
      const excludePattern = excludes.join(",");
      // robocopy with /XD (exclude dirs) and /XF (exclude files)
      const xd = excludes.filter(e => !e.includes(".")).join(" ");
      const xf = excludes.filter(e => e.includes(".")).join(" ");
      execSync(`robocopy "${ROOT}" "${tempDir}" /E /XD ${xd} /XF ${xf} /NFL /NDL /NJH /NJS`, {
        stdio: "ignore",
      });
      execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${ZIP_OUT}' -Force"`, {
        stdio: "inherit",
      });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    // Linux/Mac: use zip with -x exclusions
    const excludeArgs = excludes.map(e => `-x "${e}" "${e}/*"`).join(" ");
    execSync(`cd "${ROOT}" && zip -r -q "${ZIP_OUT}" . ${excludeArgs}`, {
      stdio: "inherit",
    });
  }

  if (!fs.existsSync(ZIP_OUT)) {
    log("ERROR: zip creation failed");
    process.exit(1);
  }

  const sizeMB = (fs.statSync(ZIP_OUT).size / 1048576).toFixed(1);
  const fileCount = (() => {
    try {
      if (os.platform() === "win32") return "?";
      const out = execSync(`unzip -l "${ZIP_OUT}" | tail -1`, { encoding: "utf-8" });
      const m = out.match(/(\d+)\s+files/);
      return m ? m[1] : "?";
    } catch { return "?"; }
  })();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Done in ${elapsed}s.`);
  log("");
  log("=== OUTPUT ===");
  log(`  Zip       : ${ZIP_OUT}`);
  log(`  Size      : ${sizeMB} MB`);
  log(`  Files     : ${fileCount}`);
}

try {
  main();
} catch (err) {
  console.error("[source] FATAL:", err);
  process.exit(1);
}
