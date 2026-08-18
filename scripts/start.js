const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");

function findServerFile(dir, depth) {
  if (depth > 2 || !fs.existsSync(dir)) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === "server.js") return path.join(dir, "server.js");
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        const found = findServerFile(path.join(dir, entry.name), depth + 1);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

const standaloneDir = path.join(root, ".next", "standalone");
const serverFile = findServerFile(standaloneDir, 0);

if (!serverFile) {
  console.error("[start] ERROR: server.js not found. Run npm run build.");
  process.exit(1);
}

console.log("[start] Starting: " + path.relative(root, serverFile));
process.env.NODE_ENV = "production";
process.env.PORT = process.env.PORT || "3000";
process.env.HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
process.chdir(path.dirname(serverFile));
require(serverFile);
