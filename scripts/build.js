const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function getNextBin() {
  const direct = path.join(root, "node_modules", "next", "dist", "bin", "next");
  if (fs.existsSync(direct)) return direct;
  return "npx next";
}

function findServerJs(dir, depth) {
  if (depth > 3 || !fs.existsSync(dir)) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "server.js") return full;
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        const found = findServerJs(full, depth + 1);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function findServerDir(standaloneRoot) {
  if (!fs.existsSync(standaloneRoot)) return null;
  try {
    const pkg = require(path.join(root, "package.json"));
    const namedDir = path.join(standaloneRoot, pkg.name);
    if (fs.existsSync(path.join(namedDir, "server.js"))) return namedDir;
  } catch (_) {}
  try {
    for (const entry of fs.readdirSync(standaloneRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = path.join(standaloneRoot, entry.name);
        if (fs.existsSync(path.join(candidate, "server.js"))) return candidate;
      }
    }
  } catch (_) {}
  if (fs.existsSync(path.join(standaloneRoot, "server.js"))) return standaloneRoot;
  return null;
}

console.log("[build] Starting Next.js build...");
const nextBin = getNextBin();

try {
  execSync('node "' + nextBin + '" build', {
    cwd: root,
    stdio: "inherit",
    shell: true,
    timeout: 600000,
  });
  console.log("[build] next build finished (exit 0)");
} catch (err) {
  console.error("[build] BUILD FAILED - refusing to package stale standalone output.");
  process.exit(1);
}

console.log("[build] Copying static files...");
const standaloneRoot = path.join(root, ".next", "standalone");
const serverDir = findServerDir(standaloneRoot);

if (!serverDir) {
  console.error("[build] FAIL: server.js not found after build.");
  process.exit(1);
}

const staticSrc = path.join(root, ".next", "static");
if (fs.existsSync(staticSrc)) {
  copyDir(staticSrc, path.join(serverDir, ".next", "static"));
  console.log("[build] Static files copied");
}

const publicSrc = path.join(root, "public");
if (fs.existsSync(publicSrc) && fs.readdirSync(publicSrc).length > 0) {
  copyDir(publicSrc, path.join(serverDir, "public"));
}

const serverFile = findServerJs(standaloneRoot, 0);
if (serverFile) {
  console.log("[build] SUCCESS: server.js at " + path.relative(root, serverFile));
} else {
  console.error("[build] FAIL: server.js missing after postbuild.");
  process.exit(1);
}
