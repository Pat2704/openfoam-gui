#!/bin/bash
# build-release.sh — Build, assemble standalone, verify, and generate zips.
#
# Usage:
#   bash scripts/build-release.sh          # full build + zip
#   bash scripts/build-release.sh --skip-build  # only assemble + zip (skip next build)
#
# This script is the SINGLE SOURCE OF TRUTH for the build process.
# Always run this instead of manual commands.

set -euo pipefail

# ── Paths ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKING_DIR="$(cd "$SRC_ROOT/.." && pwd)"          # working/
STANDALONE_DST="$WORKING_DIR/wsl-standalone"
NEXT_DIR="$SRC_ROOT/.next"
STANDALONE_SRC="$NEXT_DIR/standalone"
STANDALONE_APP="$STANDALONE_SRC"

SKIP_BUILD=false
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=true

echo "═════════════════════════════════════════════"
echo "  OpenFOAM Studio — Build & Release Script"
echo "═════════════════════════════════════════════"
echo "  Source:    $SRC_ROOT"
echo "  Output:    $WORKING_DIR"
echo "  Skip build: $SKIP_BUILD"
echo ""

# ════════════════════════════════════════════
# STEP 1: Clean previous .next (full rebuild)
# ════════════════════════════════════════════
if [ "$SKIP_BUILD" = false ]; then
  echo "[1/5] Cleaning previous build..."
  rm -rf "$NEXT_DIR"
  echo "  ✅ .next/ removed"
fi

# ════════════════════════════════════════════
# STEP 2: Build
# ════════════════════════════════════════════
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "[2/5] Running next build..."
  cd "$SRC_ROOT"
  npx next build
  echo "  ✅ Build complete"
fi

# ── Verify standalone was generated ──
if [ ! -d "$STANDALONE_APP" ]; then
  echo "❌ ERROR: .next/standalone/working/wsl-source/ not found!"
  echo "   The build did not produce standalone output."
  exit 1
fi

# ════════════════════════════════════════════
# STEP 3: Assemble standalone
# ════════════════════════════════════════════
echo ""
echo "[3/5] Assembling standalone..."

# Clean destination
rm -rf "$STANDALONE_DST"
mkdir -p "$STANDALONE_DST"

# 3a. Copy standalone app files (the actual built output)
cp -r "$STANDALONE_APP/." "$STANDALONE_DST/"

# 3b. Copy standalone node_modules (minimal trace deps only)
cp -r "$STANDALONE_SRC/node_modules" "$STANDALONE_DST/node_modules"

# 3c. Copy .next/server — ALL files EXCEPT the build cache directory named "server"
mkdir -p "$STANDALONE_DST/.next/server"
for entry in "$SRC_ROOT/.next/server"/*; do
  bn="$(basename "$entry")"
  # Skip the Turbopack/webpack build cache subdirectory named "server"
  if [ "$bn" = "server" ] && [ -d "$entry" ]; then
    continue
  fi
  cp -r "$entry" "$STANDALONE_DST/.next/server/"
done

# 3d. Copy .next/static — CONTENTS (not the directory itself, to avoid nesting)
mkdir -p "$STANDALONE_DST/.next/static"
cp -r "$SRC_ROOT/.next/static/"* "$STANDALONE_DST/.next/static/"

# 3e. Copy .next root manifest files
MANIFEST_FILES=(BUILD_ID package.json app-path-routes-manifest.json build-manifest.json prerender-manifest.json required-server-files.json routes-manifest.json)
for f in "${MANIFEST_FILES[@]}"; do
  [ -f "$SRC_ROOT/.next/$f" ] && cp "$SRC_ROOT/.next/$f" "$STANDALONE_DST/.next/$f"
done

# 3f. Copy runtime & auxiliary files
AUX_FILES=(server.js start.bat diagnose.bat diagnose.ps1 README.txt Caddyfile)
for f in "${AUX_FILES[@]}"; do
  [ -f "$SRC_ROOT/$f" ] && cp "$SRC_ROOT/$f" "$STANDALONE_DST/$f"
done

# 3g. Copy directories
for d in public prisma scripts; do
  [ -d "$SRC_ROOT/$d" ] && cp -r "$SRC_ROOT/$d" "$STANDALONE_DST/$d"
done

# 3h. Copy .env (if exists)
[ -f "$SRC_ROOT/.env" ] && cp "$SRC_ROOT/.env" "$STANDALONE_DST/.env"

echo "  ✅ Standalone assembled"

# ════════════════════════════════════════════
# STEP 4: Verify critical files
# ════════════════════════════════════════════
echo ""
echo "[4/5] Verifying critical files..."

CRITICAL_FILES=(
  ".next/BUILD_ID"
  ".next/server/app-paths-manifest.json"
  ".next/server/app"
  ".next/server/chunks"
  ".next/static/chunks"
  ".next/required-server-files.json"
  "server.js"
  "package.json"
)

ALL_OK=true
for f in "${CRITICAL_FILES[@]}"; do
  if [ -e "$STANDALONE_DST/$f" ]; then
    echo "  ✅ $f"
  else
    echo "  ❌ MISSING: $f"
    ALL_OK=false
  fi
done

if [ "$ALL_OK" = false ]; then
  echo ""
  echo "❌ CRITICAL: Some files are missing! The standalone will not work."
  exit 1
fi

echo ""
echo "  ✅ All critical files present"
echo "  📦 Size: $(du -sh "$STANDALONE_DST" | cut -f1)"

# ════════════════════════════════════════════
# STEP 5: Generate zips
# ════════════════════════════════════════════
echo ""
echo "[5/5] Generating zip files..."

# Source zip (exclude node_modules, .next, db/*.db, .git)
cd "$SRC_ROOT"
rm -f "$WORKING_DIR/wsl-source.zip"
zip -r -q "$WORKING_DIR/wsl-source.zip" . \
  -x "*.next/*" \
  -x "node_modules/*" \
  -x "db/*.db" \
  -x ".git/*"
echo "  ✅ wsl-source.zip ($(du -sh "$WORKING_DIR/wsl-source.zip" | cut -f1))"

# Standalone zip (include everything except .db)
cd "$STANDALONE_DST"
rm -f "$WORKING_DIR/wsl-standalone.zip"
zip -r -q "$WORKING_DIR/wsl-standalone.zip" . \
  -x "*.db"
echo "  ✅ wsl-standalone.zip ($(du -sh "$WORKING_DIR/wsl-standalone.zip" | cut -f1))"

# ════════════════════════════════════════════
# DONE
# ════════════════════════════════════════════
echo ""
echo "═════════════════════════════════════════════"
echo "  ✅ BUILD SUCCESSFUL"
echo "═════════════════════════════════════════════"
echo "  Output:"
echo "    $WORKING_DIR/wsl-source.zip"
echo "    $WORKING_DIR/wsl-standalone.zip"
echo ""
