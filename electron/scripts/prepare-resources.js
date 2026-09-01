#!/usr/bin/env node
/**
 * prepare-resources.js
 *
 * Assembles everything the packaged app needs under electron/resources/:
 *
 *   electron/resources/
 *     bin/node.exe        <- Node runtime that runs the standalone server
 *     standalone/         <- .next/standalone + .next/static + public + .env
 *
 * electron-builder then copies this tree verbatim into the .exe as
 * <resourcesPath>/bin and <resourcesPath>/standalone — the exact paths
 * electron/main.js resolves at runtime.
 *
 * Run `npm run build` (next build) BEFORE this script.
 *
 * Usage:
 *   node electron/scripts/prepare-resources.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ELECTRON_DIR = path.resolve(__dirname, "..");
const ROOT = path.resolve(ELECTRON_DIR, "..");
const RESOURCES = path.join(ELECTRON_DIR, "resources");
const BIN_DIR = path.join(RESOURCES, "bin");
const NODE_EXE = path.join(BIN_DIR, "node.exe");
const STANDALONE_DST = path.join(RESOURCES, "standalone");

// Node runtime bundled in the original 6.1.4 build; kept pinned since.
const NODE_VERSION = "20.20.2";
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;

function log(msg) {
  console.log(`[prepare] ${msg}`);
}

function fail(msg) {
  console.error(`[prepare] ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Mirror `src` onto `dest`: copy only what actually differs, and delete what no
 * longer exists on the source side.
 *
 * This used to delete resources/standalone outright and re-copy all ~1300 files
 * on every build, and `next build` rewrites only a handful of them. Deleting
 * the stale entries is what keeps that safe — without it the old hashed chunks
 * under .next/static would pile up inside the .exe.
 *
 * Files are compared on size and mtime. copyFileSync does not carry the mtime
 * across, so it is restored explicitly; otherwise every file would look newer
 * than its source and the next run would copy everything again.
 */
function mirrorDir(src, dest, stats) {
  fs.mkdirSync(dest, { recursive: true });

  const seen = new Set();
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    seen.add(entry.name);
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      mirrorDir(s, d, stats);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      let current = null;
      try { current = fs.readlinkSync(d); } catch (_) {}
      if (current === target) { stats.kept++; continue; }
      fs.rmSync(d, { recursive: true, force: true });
      fs.symlinkSync(target, d);
      stats.copied++;
      continue;
    }

    const from = fs.statSync(s);
    let to = null;
    try { to = fs.statSync(d); } catch (_) {}
    // 2 ms of slack: FAT/NTFS timestamp rounding, not a real difference.
    if (to && to.isFile() && to.size === from.size && Math.abs(to.mtimeMs - from.mtimeMs) < 2) {
      stats.kept++;
      continue;
    }
    fs.copyFileSync(s, d);
    fs.utimesSync(d, from.atime, from.mtime);
    stats.copied++;
  }

  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (seen.has(entry.name)) continue;
    fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
    stats.removed++;
  }
}

/**
 * `next build` normally emits .next/standalone/server.js, but when Next.js
 * auto-detects a workspace root it nests the output under a project folder.
 * Mirror the lookup scripts/build.js does so both layouts work.
 */
function findServerDir(standaloneRoot) {
  if (!fs.existsSync(standaloneRoot)) return null;
  if (fs.existsSync(path.join(standaloneRoot, "server.js"))) return standaloneRoot;
  const stack = [standaloneRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const candidate = path.join(dir, entry.name);
      if (fs.existsSync(path.join(candidate, "server.js"))) return candidate;
      stack.push(candidate);
    }
  }
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".part";
    const file = fs.createWriteStream(tmp);
    const get = (u, redirects) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
        })
        .on("error", reject);
    };
    get(url, 0);
  });
}

async function ensureNodeExe() {
  if (fs.existsSync(NODE_EXE)) {
    log(`node.exe already present (${(fs.statSync(NODE_EXE).size / 1048576).toFixed(1)} MB)`);
    return;
  }
  log(`Downloading Node ${NODE_VERSION} (win-x64) -> ${path.relative(ROOT, NODE_EXE)}`);
  await download(NODE_URL, NODE_EXE);
  log("node.exe downloaded");
}

function assembleStandalone() {
  const standaloneRoot = path.join(ROOT, ".next", "standalone");
  const serverDir = findServerDir(standaloneRoot);
  if (!serverDir) {
    fail("no .next/standalone/server.js found — run `npm run build` first.");
  }
  log(`Standalone source: ${path.relative(ROOT, serverDir)}`);

  const stats = { copied: 0, kept: 0, removed: 0 };
  mirrorDir(serverDir, STANDALONE_DST, stats);

  // `next build` leaves .next/static and public/ outside the standalone dir.
  // scripts/build.js already copies them in, so these two mirrors are normally
  // no-ops; they are what makes this script work after a bare `next build`.
  const staticSrc = path.join(ROOT, ".next", "static");
  if (fs.existsSync(staticSrc)) mirrorDir(staticSrc, path.join(STANDALONE_DST, ".next", "static"), stats);

  const publicSrc = path.join(ROOT, "public");
  if (fs.existsSync(publicSrc)) mirrorDir(publicSrc, path.join(STANDALONE_DST, "public"), stats);

  const envSrc = path.join(ROOT, ".env");
  if (fs.existsSync(envSrc)) fs.copyFileSync(envSrc, path.join(STANDALONE_DST, ".env"));

  const required = [
    "server.js",
    "package.json",
    path.join(".next", "BUILD_ID"),
    path.join(".next", "required-server-files.json"),
    path.join(".next", "server"),
    path.join(".next", "static"),
    "node_modules",
  ];
  const missing = required.filter((r) => !fs.existsSync(path.join(STANDALONE_DST, r)));
  if (missing.length) fail(`assembled standalone is missing: ${missing.join(", ")}`);

  log(
    `Standalone mirrored and verified — ${stats.copied} copied, ` +
    `${stats.kept} unchanged, ${stats.removed} removed`
  );
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  assembleStandalone();
  await ensureNodeExe();
  log(`Ready: ${path.relative(ROOT, RESOURCES)}`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
