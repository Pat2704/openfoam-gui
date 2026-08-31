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

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
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

  fs.rmSync(STANDALONE_DST, { recursive: true, force: true });
  copyDir(serverDir, STANDALONE_DST);

  // `next build` leaves .next/static and public/ outside the standalone dir.
  // scripts/build.js already copies them in, but re-copy defensively so this
  // script also works after a bare `next build`.
  const staticSrc = path.join(ROOT, ".next", "static");
  if (fs.existsSync(staticSrc)) copyDir(staticSrc, path.join(STANDALONE_DST, ".next", "static"));

  const publicSrc = path.join(ROOT, "public");
  if (fs.existsSync(publicSrc)) copyDir(publicSrc, path.join(STANDALONE_DST, "public"));

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

  log("Standalone assembled and verified");
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  assembleStandalone();
  await ensureNodeExe();
  log(`Ready: ${path.relative(ROOT, RESOURCES)}`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
