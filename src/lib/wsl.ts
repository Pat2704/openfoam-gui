import { execSync, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  boundedInteger,
  shellQuote,
  WslInputError,
  validateCaseName,
  validateLogName,
  validatePathWithin,
  validatePid,
  validateRelativePath,
} from './wsl-input';

// ── Distro selection (cached) ──
// Auto-detects an Ubuntu-like distro from `wsl --list -q`, skipping docker-desktop.
let distroName: string | null = null;

function stripDefaultMarker(s: string): string {
  return s.replace(/^\*+\s*/, '');
}

function getDistro(): string {
  if (distroName) return distroName;
  try {
    const raw = execSync('wsl --list -q');
    let str: string;
    // WSL on Windows returns UTF-16LE with BOM (FF FE)
    if (raw.length >= 2 && raw[0] === 255 && raw[1] === 254) {
      str = raw.slice(2).toString('utf16le');
    } else {
      str = raw.toString('utf-8');
      if (str.includes('\0')) str = str.replace(/\x00/g, '');
    }
    const lines = str
      .replace(/\r/g, '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(stripDefaultMarker) // strip leading "* " from default distro
      .filter(s => !/docker/i.test(s));
    distroName = lines.find(s => /ubuntu/i.test(s)) || lines[0] || 'Ubuntu-22.04';
  } catch {
    distroName = 'Ubuntu-22.04';
  }
  return distroName;
}

// ── Core: run a bash command inside the chosen WSL distro ──
// Uses `bash -c` (non-login, non-interactive). The OpenFOAM environment is
// loaded EXPLICITLY via foamSource() — NOT via .bashrc, because Ubuntu's
// default .bashrc does `return` early when not interactive.
//
// CRITICAL — screen bogus fix:
// wsl.exe sets COLUMNS=131072 in its env when no TTY is attached. Even though
// we set COLUMNS=80 in the Node.js spawn env, wsl.exe OVERRIDES it before
// passing to bash. So bash's readline sees COLUMNS=131072 and prints
// "your 131072x1 screen size is bogus. expect trouble" on EVERY invocation.
//
// Fix: prepend `export COLUMNS=80 LINES=24 TERM=dumb` INSIDE the bash command
// itself. This runs AFTER wsl.exe has set its env, so bash sees the correct
// values regardless of wsl.exe's env handling. The `2>/dev/null` suppresses
// any error if the export fails (shouldn't happen, but safe).
function runInWsl(cmd: string, timeout = 30000): string {
  const distro = getDistro();
  const wrappedCmd = `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; ${cmd}`;
  try {
    return execFileSync('wsl', ['-d', distro, '--', 'bash', '-c', wrappedCmd], {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 0x3200000,
      env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
    });
  } catch (e: any) {
    throw new Error((e.stderr || e.message || 'WSL command failed').trim());
  }
}

// Variant: runInWsl with stdin input (for writeFile base64 piping)
function runInWslWithInput(cmd: string, input: string, timeout = 30000): string {
  const distro = getDistro();
  const wrappedCmd = `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; ${cmd}`;
  try {
    return execFileSync('wsl', ['-d', distro, '--', 'bash', '-c', wrappedCmd], {
      input, encoding: 'utf-8', timeout, maxBuffer: 0x3200000,
      env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
    });
  } catch (e: any) {
    throw new Error((e.stderr || e.message || 'WSL command failed').trim());
  }
}

// Variant: runInWsl with a base64-encoded bash script (avoids quoting issues)
function runInWslScript(b64: string, timeout = 30000): string {
  const distro = getDistro();
  const wrappedCmd = `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; echo "${b64}" | base64 -d | bash`;
  try {
    return execFileSync('wsl', ['-d', distro, '--', 'bash', '-c', wrappedCmd], {
      encoding: 'utf-8', timeout, maxBuffer: 0x3200000,
      env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
    });
  } catch (e: any) {
    throw new Error((e.stderr || e.message || 'WSL command failed').trim());
  }
}

// ── Caches (in-memory + persistent disk) ──
let cachedBashrc: string | null = null;
let cachedRunDir: string | null = null;
let cachedTutDir: string | null = null;
let cachedFoamEnv: Record<string, string> | null = null;
let cachedVersion: string | null = null;

// ── Persistent disk cache ──
// Saves resolved values to ~/.wslgui-cache.json so server restarts don't
// re-discover everything from scratch. The file is OUTSIDE the project/standalone
// directory — it lives in the user's home and is never included in any ZIP.
const DISK_CACHE_PATH = path.join(os.homedir(), '.wslgui-cache.json');

interface DiskCache {
  distro?: string;
  bashrc?: string;
  runDir?: string;
  tutDir?: string;
  foamEnv?: Record<string, string>;
  version?: string;
}

function loadDiskCache(): DiskCache | null {
  try {
    const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function saveDiskCache(data: DiskCache): void {
  try {
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

// Track whether cached values have been verified (test -d / test -f) vs guessed
let runDirVerified = false;
let tutDirVerified = false;

// Load disk cache at module init — validate ALL paths with a SINGLE WSL call
(() => {
  const disk = loadDiskCache();
  if (!disk || disk.distro !== getDistro()) return;

  // Tentatively load values (they'll be validated below)
  if (disk.bashrc && disk.bashrc.startsWith('/')) cachedBashrc = disk.bashrc;
  if (disk.runDir && disk.runDir.startsWith('/')) cachedRunDir = disk.runDir;
  if (disk.tutDir && disk.tutDir.startsWith('/')) cachedTutDir = disk.tutDir;
  if (disk.foamEnv && Object.keys(disk.foamEnv).length > 5) cachedFoamEnv = disk.foamEnv;
  if (disk.version && disk.version !== 'Unknown') cachedVersion = disk.version;

  // SINGLE WSL call: validate bashrc (file exists), runDir (dir exists), tutDir (dir exists)
  const checks: string[] = [];
  if (cachedBashrc) checks.push(`[ -f ${shellQuote(cachedBashrc)} ] && echo "BASHRC_OK"`);
  if (cachedRunDir) checks.push(`[ -d ${shellQuote(cachedRunDir)} ] && echo "RUNDIR_OK"`);
  if (cachedTutDir) checks.push(`[ -d ${shellQuote(cachedTutDir)} ] && echo "TUTDIR_OK"`);

  if (checks.length > 0) {
    try {
      const result = runInWsl(checks.join('; '), 10000);
      if (cachedBashrc && !result.includes('BASHRC_OK')) {
        console.log('[wsl.ts] Disk cache: bashrc invalid, discarding');
        cachedBashrc = null;
      }
      if (cachedRunDir && result.includes('RUNDIR_OK')) {
        runDirVerified = true;
      } else if (cachedRunDir) {
        console.log('[wsl.ts] Disk cache: runDir invalid, discarding');
        cachedRunDir = null;
      }
      if (cachedTutDir && result.includes('TUTDIR_OK')) {
        tutDirVerified = true;
      } else if (cachedTutDir) {
        console.log('[wsl.ts] Disk cache: tutDir invalid, discarding');
        cachedTutDir = null;
      }
      if (cachedFoamEnv && cachedFoamEnv['FOAM_RUN'] && !runDirVerified) {
        console.log('[wsl.ts] Disk cache: foamEnv FOAM_RUN suspicious (runDir not verified), discarding foamEnv');
        cachedFoamEnv = null;
        cachedVersion = null; // version depends on foamEnv
      }
    } catch {
      console.log('[wsl.ts] Disk cache: WSL validation failed, discarding all path caches');
      cachedBashrc = null;
      cachedRunDir = null;
      cachedTutDir = null;
    }
  }
})();

function persistCache(): void {
  saveDiskCache({
    distro: getDistro(),
    bashrc: cachedBashrc || undefined,
    runDir: cachedRunDir || undefined,
    tutDir: cachedTutDir || undefined,
    foamEnv: cachedFoamEnv || undefined,
    version: cachedVersion || undefined,
  });
}

// ── Find the OpenFOAM bashrc file ──
// If the user has selected a specific version (via setOpenFOAMVersion), uses
// that bashrc. Otherwise searches common install paths for the first one found.
export function findBashrc(): string {
  if (cachedBashrc !== null) return cachedBashrc;

  // If a specific version was selected by the user, use it directly.
  if (selectedBashrc) {
    try {
      if (runInWsl(`test -f ${shellQuote(selectedBashrc)} && echo OK`).trim() === 'OK') {
        cachedBashrc = selectedBashrc;
        persistCache();
        return cachedBashrc;
      }
    } catch { /* fall through to auto-detect */ }
  }

  // Auto-detect: use findOpenFOAMVersions() which scans ALL installs, then
  // pick the MOST RECENT version. This replaces the old hardcoded knownPaths
  // list which took the first match (often an older version).
  // Version comparison: Foundation uses integers (9, 10, ..., 13, 14), ESI uses
  // YYYYMM (2212, 2312, ...). We sort numerically descending so the highest
  // number wins — 14 > 13, 2312 > 2212. Mixed Foundation/ESI: ESI numbers are
  // larger (2212 > 14), so ESI wins over Foundation if both installed. This is
  // a reasonable default; the user can always pick a specific one from settings.
  const versions = findOpenFOAMVersions();
  if (versions.length > 0) {
    const sorted = [...versions].sort((a, b) => {
      const an = parseInt(a.version, 10) || 0;
      const bn = parseInt(b.version, 10) || 0;
      return bn - an; // descending — highest version first
    });
    cachedBashrc = sorted[0].bashrcPath;
    persistCache();
    return cachedBashrc;
  }

  // Last-resort fallback: generic find search for any bashrc under common
  // install roots that contains WM_PROJECT_DIR. No hardcoded version numbers —
  // works with any past or future OpenFOAM version. Returns the first found
  // (the main auto-detect above already handles version sorting).
  try {
    const found = runInWsl(
      'find /opt /usr/lib /usr/local -maxdepth 5 -name bashrc -path "*/etc/*" 2>/dev/null | while IFS= read -r f; do grep -q "WM_PROJECT_DIR" "$f" 2>/dev/null && echo "$f" && break; done'
    ).trim();
    if (found && found.startsWith('/')) {
      cachedBashrc = found;
      persistCache();
      return cachedBashrc;
    }
  } catch { /* next */ }

  cachedBashrc = '';
  persistCache();
  return '';
}

// ── Detect ALL installed OpenFOAM versions ──
// Scans /opt, /usr/lib, /usr/local for every etc/bashrc belonging to an
// OpenFOAM install. Returns { version, bashrcPath, installDir }[] so the
// dashboard can show version buttons and let the user pick which one to use.
let cachedFoamVersions: { version: string; bashrcPath: string; installDir: string }[] | null = null;

export function findOpenFOAMVersions(): { version: string; bashrcPath: string; installDir: string }[] {
  if (cachedFoamVersions !== null) return cachedFoamVersions;
  const script = `#!/bin/bash
# Scan common install locations for OpenFOAM etc/bashrc files.
# Covers Foundation (openfoam9-13), ESI (openfoam2212, 2312), and any other.
for base in /opt /usr/lib /usr/local; do
  [ -d "$base" ] || continue
  find "$base" -maxdepth 5 -name bashrc -path "*/etc/*" 2>/dev/null | while IFS= read -r f; do
    # Verify it's an OpenFOAM bashrc (check for WM_PROJECT_DIR in the file)
    grep -q "WM_PROJECT_DIR" "$f" 2>/dev/null || continue
    # Extract the install dir (parent of etc/)
    installDir=$(dirname "$(dirname "$f")")
    # Extract version from the path or from sourcing
    ver=""
    case "$f" in
      */openfoam[0-9]*/etc/bashrc) ver=$(echo "$f" | sed 's|.*/openfoam\\([0-9]*\\)/.*|\\1|') ;;
      */OpenFOAM-[0-9]*/etc/bashrc) ver=$(echo "$f" | sed 's|.*/OpenFOAM-\\([0-9]*\\)/.*|\\1|') ;;
      */openfoam[0-9][0-9][0-9][0-9]*/etc/bashrc) ver=$(echo "$f" | sed 's|.*/openfoam\\([0-9]*\\)/.*|\\1|') ;;
    esac
    [ -z "$ver" ] && ver=$(basename "$installDir")
    echo "$ver|$f|$installDir"
  done
done | sort -u
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 15000).trim();
    if (!out) { cachedFoamVersions = []; return []; }
    const versions: { version: string; bashrcPath: string; installDir: string }[] = [];
    for (const line of out.split('\n')) {
      const parts = line.split('|');
      if (parts.length >= 3 && parts[1].startsWith('/')) {
        versions.push({ version: parts[0], bashrcPath: parts[1], installDir: parts[2] });
      }
    }
    cachedFoamVersions = versions;
    return versions;
  } catch {
    cachedFoamVersions = [];
    return [];
  }
}

// ── Select which OpenFOAM version to use ──
// Sets the active bashrc path. All subsequent calls (foamSource, getFoamEnv,
// getRunDirectory, getTutorialDirectory, getOpenFOAMVersion) will use this
// bashrc. Resets ALL caches so the new environment is picked up immediately.
let selectedBashrc: string | null = null;

export function setOpenFOAMVersion(bashrcPath: string): boolean {
  if (!bashrcPath || !bashrcPath.startsWith('/') || bashrcPath.includes('..')) return false;
  selectedBashrc = bashrcPath;
  // Reset ALL caches — the new bashrc sources a completely different environment.
  cachedBashrc = null;
  cachedFoamEnv = null;
  cachedVersion = null;
  cachedRunDir = null;
  cachedTutDir = null;
  runDirVerified = false;
  tutDirVerified = false;
  // Don't delete the disk cache file — it will be overwritten on next persistCache.
  persistCache();
  return true;
}

export function getSelectedBashrc(): string | null {
  return selectedBashrc;
}

// ── Build the "source <bashrc>; " prefix that loads the OpenFOAM environment ──
export function foamSource(): string {
  const bashrc = findBashrc();
  return bashrc ? `source ${shellQuote(bashrc)} 2>/dev/null; ` : '';
}

// ── Read all OpenFOAM-related env vars in a single WSL call ──
function getFoamEnv(): Record<string, string> {
  if (cachedFoamEnv) return cachedFoamEnv;
  try {
    const src = foamSource();
    const output = runInWsl(`${src} env -0`).trim();
    const env: Record<string, string> = {};
    for (const entry of output.split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) env[entry.substring(0, eq)] = entry.substring(eq + 1);
    }
    cachedFoamEnv = env;
    persistCache();
    return env;
  } catch {
    // Fallback: plain `env` (newline-separated)
    try {
      const src = foamSource();
      const output = runInWsl(`${src} env`).trim();
      const env: Record<string, string> = {};
      for (const line of output.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.substring(0, eq)] = line.substring(eq + 1);
      }
      cachedFoamEnv = env;
      persistCache();
      return env;
    } catch {
      cachedFoamEnv = {};
      return {};
    }
  }
}

// ── Run a command with OpenFOAM env loaded, optionally in a workDir ──
function foamExec(cmd: string, workDir?: string, timeout = 30000): string {
  const src = foamSource();
  const cd = workDir ? `cd ${shellQuote(workDir)} 2>/dev/null && ` : '';
  return runInWsl(`${cd}${src}${cmd}`, timeout);
}

// ── Public: check whether WSL responds ──
export function wslCheck(): { running: boolean; name: string; error?: string } {
  const name = getDistro();
  try {
    const out = runInWsl('echo ok', 5000).trim();
    if (out === 'ok') return { running: true, name };
    return { running: false, name, error: 'WSL not responding' };
  } catch (e: any) {
    return { running: false, name, error: e.message };
  }
}

// ── Public: list WSL distros (excluding docker-desktop) ──
export function wslListDistros(): string[] {
  try {
    const raw = execSync('wsl --list -q');
    let str: string;
    if (raw.length >= 2 && raw[0] === 255 && raw[1] === 254) {
      str = raw.slice(2).toString('utf16le');
    } else {
      str = raw.toString('utf-8');
      if (str.includes('\0')) str = str.replace(/\x00/g, '');
    }
    return str
      .replace(/\r/g, '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(stripDefaultMarker)
      .filter(s => !/docker/i.test(s));
  } catch {
    return [];
  }
}

export function setDistro(name: string): string {
  const requested = name.trim();
  const available = wslListDistros();
  const selected = available.find(item => item.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (!selected) {
    throw new WslInputError(`WSL distro not found: ${name}`);
  }
  if (distroName !== selected) {
    distroName = selected;
    resetCache();
  }
  return selected;
}

// ── Public: get OpenFOAM version (cached) ──
export function getOpenFOAMVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const env = getFoamEnv();
    cachedVersion = env.WM_PROJECT_VERSION || 'Unknown';
    return cachedVersion;
  } catch {
    return 'Unknown';
  }
}

// ── Public: get OpenFOAM env vars as a string ──
export function getOpenFOAMEnv(): string {
  try {
    const env = getFoamEnv();
    return Object.entries(env)
      .filter(([k]) => k.toUpperCase().includes('FOAM') || k.startsWith('WM_'))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  } catch {
    return '';
  }
}

// ── Public: get $FOAM_RUN (cached) ──
export function getRunDirectory(): string {
  if (cachedRunDir !== null) return cachedRunDir;

  // Fetch HOME and USER in one call (faster, fewer round-trips)
  const homeUser = runInWsl('printf "%s:%s" "$HOME" "$USER"').trim();
  const [home, user] = (homeUser.split(':', 2).length === 2) ? homeUser.split(':', 2) : [runInWsl('echo "$HOME"').trim(), runInWsl('echo "$USER"').trim()];
  const version = getOpenFOAMVersion();

  // 1. Use FOAM_RUN from the environment (cached)
  let foamRun = '';
  const env = getFoamEnv();
  if (env['FOAM_RUN'] && env['FOAM_RUN'] !== '$FOAM_RUN') {
    foamRun = env['FOAM_RUN'];
  } else {
    try {
      foamRun = foamExec('echo "$FOAM_RUN"').trim();
    } catch { /* next */ }
  }

  if (foamRun && foamRun !== '$FOAM_RUN' && foamRun.startsWith('/') && runInWsl(`test -d ${shellQuote(foamRun)} && echo OK`).trim() === 'OK') {
    cachedRunDir = foamRun; runDirVerified = true;
    persistCache();
    return cachedRunDir;
  }

  // 2. Try standard OpenFOAM user-versioned run dirs
  for (const candidate of [
    `${home}/OpenFOAM/${user}-${version}/run`,
    `${home}/OpenFOAM/${user}-13/run`,
    `${home}/OpenFOAM/${user}-12/run`,
    `${home}/OpenFOAM/${user}-11/run`,
  ]) {
    try {
      if (runInWsl(`test -d ${shellQuote(candidate)} && echo OK`).trim() === 'OK') {
        cachedRunDir = candidate; runDirVerified = true;
        persistCache();
        return cachedRunDir;
      }
    } catch { /* next */ }
  }

  // 3. Search for any "run" dir under ~/OpenFOAM
  try {
    const found = runInWsl(`find ${shellQuote(`${home}/OpenFOAM`)} -maxdepth 2 -type d -name run 2>/dev/null | head -1`).trim();
    if (found && found.startsWith('/')) {
      cachedRunDir = found; runDirVerified = true;
      persistCache();
      return cachedRunDir;
    }
  } catch { /* next */ }

  // 4. Fall back to a user-versioned directory (may not exist yet)
  try {
    const found = runInWsl(`find ${shellQuote(`${home}/OpenFOAM`)} -maxdepth 1 -type d -name '*-1[1-9]' 2>/dev/null | head -1`).trim();
    if (found && found.startsWith('/')) {
      const runPath = `${found}/run`;
      if (runInWsl(`test -d ${shellQuote(runPath)} && echo OK`).trim() === 'OK') {
        cachedRunDir = runPath; runDirVerified = true;
        persistCache();
        return cachedRunDir;
      }
      cachedRunDir = found; runDirVerified = true;
      persistCache();
      return cachedRunDir;
    }
  } catch { /* next */ }

  // GUESSED fallback — NOT verified with test -d. Do NOT persist to disk.
  cachedRunDir = `${home}/OpenFOAM/${user}-${version}/run`;
  runDirVerified = false;
  console.log(`[wsl.ts] WARNING: runDir is GUESSED (not verified): ${cachedRunDir}`);
  return cachedRunDir;
}

// ── Public: get $FOAM_TUTORIALS (cached) ──
export function getTutorialDirectory(): string {
  if (cachedTutDir !== null) return cachedTutDir;

  // 1. Use FOAM_TUTORIALS from the environment
  let foamTut = '';
  const env = getFoamEnv();
  if (env['FOAM_TUTORIALS'] && env['FOAM_TUTORIALS'] !== '$FOAM_TUTORIALS') {
    foamTut = env['FOAM_TUTORIALS'];
  } else {
    try {
      const src = foamSource();
      foamTut = runInWsl(`${src} echo "$FOAM_TUTORIALS"`).trim();
    } catch { /* next */ }
  }

  if (foamTut && foamTut !== '$FOAM_TUTORIALS' && runInWsl(`test -d "${foamTut}" && echo OK`).trim() === 'OK') {
    cachedTutDir = foamTut; tutDirVerified = true;
    persistCache();
    return cachedTutDir;
  }

  // 2. Derive from the active bashrc's install dir (WM_PROJECT_DIR/tutorials).
  // This is completely generic — no hardcoded version numbers.
  try {
    const bashrc = findBashrc();
    if (bashrc) {
      // bashrc is at <installDir>/etc/bashrc → tutorials is <installDir>/tutorials
      const installDir = bashrc.replace(/\/etc\/bashrc$/, '');
      const candidate = `${installDir}/tutorials`;
      if (runInWsl(`test -d ${shellQuote(candidate)} && echo OK`).trim() === 'OK') {
        cachedTutDir = candidate; tutDirVerified = true;
        persistCache();
        return cachedTutDir;
      }
    }
  } catch { /* next */ }

  // 3. Search /opt, /usr/lib, /usr/local for any tutorials dir (generic)
  try {
    const found = runInWsl('find /opt /usr/lib /usr/local -maxdepth 5 -type d -name tutorials 2>/dev/null | head -1').trim();
    if (found && found.startsWith('/')) {
      cachedTutDir = found; tutDirVerified = true;
      persistCache();
      return cachedTutDir;
    }
  } catch { /* next */ }

  // NOT found — do NOT persist empty string to disk (would bypass future resolution)
  cachedTutDir = '';
  tutDirVerified = false;
  return '';
}

// ── List case names in $FOAM_RUN ──
export function listCases(): string[] {
  try {
    const runDir = getRunDirectory();
    if (!runDir) return [];
    return runInWsl(`find ${shellQuote(runDir)} -mindepth 1 -maxdepth 1 -type d -printf '%p\\n' 2>/dev/null`)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(d => d.replace(/\/+$/, '').split('/').pop() || '')
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return [];
  }
}

function getCasePath(caseName: string): string {
  const safeName = validateCaseName(caseName);
  return `${getRunDirectory()}/${safeName}`;
}

// ── OpenFOAM install layout (general, not hard-coded to /opt/openfoam13) ──
// Both sections are resolved from the OpenFOAM environment / install layout:
//   - applications → $WM_PROJECT_DIR/applications (one level above solvers,
//     so it includes solvers/, utilities/, etc.)
//   - src          → FOAM_SRC (or $WM_PROJECT_DIR/src) — core library sources
// We fall back to WM_PROJECT_DIR-based well-known subpaths when the env var is
// unset (rare, but happens with stripped-down installs).
function getFoamApplications(): string {
  const env = getFoamEnv();
  // FOAM_APP: some installs export it pointing at applications/. If not, build it.
  if (env.FOAM_APP && env.FOAM_APP !== '$FOAM_APP') return env.FOAM_APP;
  if (env.WM_PROJECT_DIR) return `${env.WM_PROJECT_DIR}/applications`;
  return '';
}
function getFoamSrc(): string {
  const env = getFoamEnv();
  if (env.FOAM_SRC && env.FOAM_SRC !== '$FOAM_SRC') return env.FOAM_SRC;
  if (env.WM_PROJECT_DIR) return `${env.WM_PROJECT_DIR}/src`;
  return '';
}

// Resolve one of the OpenFOAM sections to its absolute path. Used by the
// API to map the abstract "section" to a concrete directory without exposing
// the raw path to the client (the client only knows 'applications' | 'src').
export type FoamSection = 'applications' | 'src';
export function getFoamSectionDir(section: FoamSection): string {
  switch (section) {
    case 'applications': return getFoamApplications();
    case 'src': return getFoamSrc();
  }
}

// ── List contents of a directory inside an OpenFOAM section ──
// `relPath` is a relative path inside the section ("" = section root). All path
// segments are validated to stay inside the section (no ../, no absolute). The
// returned items carry their relative path so the client can navigate deeper.
export interface FoamFileItem {
  name: string;
  path: string;     // relative path inside the section (e.g. "incompressible/icoFoam")
  isDir: boolean;
  size: number;     // bytes (0 for dirs)
}
export function listFoamDirectory(section: FoamSection, relPath: string): {
  exists: boolean;
  rootDir: string;   // absolute path of the section root (for display)
  relPath: string;   // sanitized relative path actually listed
  items: FoamFileItem[];
} {
  const rootDir = getFoamSectionDir(section);
  if (!rootDir) return { exists: false, rootDir: '', relPath: '', items: [] };
  // Sanitize relPath: must be relative, no .., no leading /
  const safeRel = validateRelativePath(relPath, 'Path', true);
  const fullPath = safeRel ? `${rootDir}/${safeRel}` : rootDir;
  const script = `#!/bin/bash
ROOT=${shellQuote(rootDir)}
DIR=${shellQuote(fullPath)}
if [ ! -d "$DIR" ]; then echo "NOEXIST"; exit 0; fi
for item in "$DIR"/*; do
  [ -e "$item" ] || continue
  bn=$(basename "$item")
  if [ -d "$item" ]; then
    echo "d|0|$bn"
  else
    sz=$(stat -c%s "$item" 2>/dev/null || echo 0)
    echo "f|$sz|$bn"
  fi
done
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 15000)
      .trim().replace(/\r/g, '');
    if (!out || out === 'NOEXIST') return { exists: false, rootDir, relPath: safeRel, items: [] };
    const items: FoamFileItem[] = [];
    for (const line of out.split('\n')) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const isDir = parts[0] === 'd';
      const size = parseInt(parts[1], 10) || 0;
      const name = parts.slice(2).join('|');
      if (!name) continue;
      items.push({
        name,
        path: safeRel ? `${safeRel}/${name}` : name,
        isDir,
        size,
      });
    }
    // Sort: directories first, then files, each alphabetically (case-insensitive)
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return { exists: true, rootDir, relPath: safeRel, items };
  } catch {
    return { exists: false, rootDir, relPath: safeRel, items: [] };
  }
}

// ── List ONLY subdirectories (one level deep) inside a section ──
// Used by the FOAMy copilot when the user asks "which solvers are in
// applications/solvers?" or "what folders are in src/OpenFOAM?". A content
// search (searchFoamTree) is useless for such "list/enumerate" questions —
// the answer IS the directory listing itself. This returns just the subdirs
// (no files), cheap and token-efficient.
export function listFoamSubdirs(section: FoamSection, relPath: string): {
  exists: boolean;
  rootDir: string;
  relPath: string;
  subdirs: string[]; // names only (basename), sorted alphabetically
} {
  const rootDir = getFoamSectionDir(section);
  if (!rootDir) return { exists: false, rootDir: '', relPath: '', subdirs: [] };
  const safeRel = validateRelativePath(relPath, 'Path', true);
  const fullPath = safeRel ? `${rootDir}/${safeRel}` : rootDir;
  const script = `#!/bin/bash
DIR=${shellQuote(fullPath)}
if [ ! -d "$DIR" ]; then echo "NOEXIST"; exit 0; fi
for item in "$DIR"/*/; do
  [ -d "$item" ] || continue
  bn=$(basename "$item")
  echo "$bn"
done | sort -f
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 10000)
      .trim().replace(/\r/g, '');
    if (!out || out === 'NOEXIST') return { exists: false, rootDir, relPath: safeRel, subdirs: [] };
    const subdirs = out.split('\n').filter(Boolean);
    return { exists: true, rootDir, relPath: safeRel, subdirs };
  } catch {
    return { exists: false, rootDir, relPath: safeRel, subdirs: [] };
  }
}

// ── Read a file inside an OpenFOAM section (text only, capped at 1 MB) ──
// Binary files (.so) are refused with a clear message. The cap prevents loading
// huge generated files (e.g. compiled .o or preprocessed .C) into the browser.
const FOAM_READ_MAX_BYTES = 1024 * 1024; // 1 MB
export function readFoamFile(section: FoamSection, relPath: string): {
  success: boolean;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  rootDir: string;
} {
  const rootDir = getFoamSectionDir(section);
  if (!rootDir) return { success: false, content: 'Section unavailable', size: 0, truncated: false, binary: false, rootDir: '' };
  const safeRel = validateRelativePath(relPath, 'File path');
  const fullPath = `${rootDir}/${safeRel}`;
  const script = `#!/bin/bash
F=${shellQuote(fullPath)}
if [ ! -f "$F" ]; then echo "NOEXIST"; exit 0; fi
sz=$(stat -c%s "$F" 2>/dev/null || echo 0)
# Detect binary: file -b returns "ELF" / "data" for binaries
ft=$(file -b "$F" 2>/dev/null | head -c 60)
echo "SZ:$sz"
echo "FT:$ft"
# Only emit content for text files (file -b says text/ASCII/UTF-8/empty)
case "$ft" in
  *ELF*|*data*|*executable*) echo "BINARY"; exit 0 ;;
esac
head -c ${FOAM_READ_MAX_BYTES + 1} "$F"
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 15000);
    if (out.startsWith('NOEXIST')) {
      return { success: false, content: 'File not found', size: 0, truncated: false, binary: false, rootDir };
    }
    const lines = out.split('\n');
    const szLine = lines.find(l => l.startsWith('SZ:')) || 'SZ:0';
    const ftLine = lines.find(l => l.startsWith('FT:')) || 'FT:';
    const size = parseInt(szLine.substring(3), 10) || 0;
    const fileType = ftLine.substring(3);
    if (out.includes('\nBINARY\n') || /ELF|executable/.test(fileType)) {
      return { success: false, content: `Binary file (${fileType || 'not text'}) — not viewable in the editor.`, size, truncated: false, binary: true, rootDir };
    }
    // Content is everything after the SZ: and FT: lines
    const contentStart = out.indexOf('\n', out.indexOf('FT:') + 3) + 1;
    const raw = contentStart > 0 ? out.substring(contentStart) : '';
    const truncated = raw.length > FOAM_READ_MAX_BYTES;
    const content = truncated ? raw.substring(0, FOAM_READ_MAX_BYTES) : raw;
    return { success: true, content, size, truncated, binary: false, rootDir };
  } catch (e: any) {
    return { success: false, content: `Error: ${e.message}`, size: 0, truncated: false, binary: false, rootDir };
  }
}

// ── Search a directory tree for files whose path matches a pattern ──
// Used by the FOAMy copilot to retrieve relevant source files from tutorials,
// applications, and src WITHOUT reading every file. Single WSL call: find →
// grep (path match) → file (skip binary) → head -c (cap size) → echo marker.
// `rootDir` must be absolute (validated). `pattern` is a grep -E regex.
// Returns up to `maxFiles` matching text files, each capped at `maxBytesPerFile`.
export function searchFoamTree(
  rootDir: string,
  pattern: string,
  maxFiles = 5,
  maxBytesPerFile = 4096
): { files: { path: string; content: string }[]; rootDir: string; scanned: number } {
  // Light validation: rootDir must be absolute, no .., no null bytes.
  if (!rootDir || !rootDir.startsWith('/') || rootDir.includes('..') || /[\0\r\n]/.test(rootDir)) {
    return { files: [], rootDir: rootDir || '', scanned: 0 };
  }
  // Sanitize pattern: escape single quotes for shell safety (the pattern goes
  // inside a single-quoted grep -E argument). We also strip newlines.
  const safePattern = pattern.replace(/'/g, `'"'"'`).replace(/[\r\n]/g, '');
  if (!safePattern) return { files: [], rootDir, scanned: 0 };

  const script = `#!/bin/bash
ROOT=${shellQuote(rootDir)}
PATTERN='${safePattern}'
MAXFILES=${maxFiles}
MAXBYTES=${maxBytesPerFile}
[ -d "$ROOT" ] || { echo "NOEXIST"; exit 0; }
# Find all files, match path against pattern (case-insensitive), cap candidates.
# NOTE: outputs the FULL path (not relative) — the JS side strips the ROOT/
# prefix. This avoids bash \${f#...} parameter expansion which conflicts with
# JS template-literal interpolation (\${...} is always JS interpolation).
count=0
scanned=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  scanned=$((scanned + 1))
  [ $scanned -gt 500 ] && break
  # Skip common binary/object/generated extensions
  case "$f" in
    *.o|*.so|*.a|*.pyc|*.class|*.gz|*.zip|*.pdf|*.png|*.jpg|*.svg) continue ;;
  esac
  # Skip binaries by file type
  ft=$(file -b "$f" 2>/dev/null | head -c 40)
  case "$ft" in
    *ELF*|*executable*|*data*|*compressed*) continue ;;
  esac
  printf '===FILE===%s\\n' "$f"
  head -c "$MAXBYTES" "$f" 2>/dev/null
  printf '\\n===END===\\n'
  count=$((count + 1))
  [ $count -ge $MAXFILES ] && break
done < <(find "$ROOT" -type f 2>/dev/null | grep -iE "$PATTERN" | head -60)
printf 'SEARCH_DONE:%d\\n' "$count"
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 30000);
    if (out.startsWith('NOEXIST')) return { files: [], rootDir, scanned: 0 };
    const files: { path: string; content: string }[] = [];
    // Parse ===FILE===<fullpath>\n<content>\n===END=== blocks
    const blocks = out.split('===FILE===');
    const prefix = rootDir + '/';
    for (const block of blocks.slice(1)) {
      const endIdx = block.indexOf('===END===');
      if (endIdx < 0) continue;
      const nl = block.indexOf('\n');
      if (nl < 0) continue;
      const fullPath = block.substring(0, nl).trim();
      // Strip the ROOT/ prefix to get a relative path
      const relPath = fullPath.startsWith(prefix) ? fullPath.substring(prefix.length) : fullPath;
      const content = block.substring(nl + 1, endIdx).replace(/\n$/, '');
      if (relPath) files.push({ path: relPath, content });
    }
    return { files, rootDir, scanned: 0 };
  } catch {
    return { files: [], rootDir, scanned: 0 };
  }
}

// ── Read all text files under 0/, system/, constant/ for the copilot context ──
// Recurses into subdirectories but EXCLUDES constant/polyMesh/ (mesh data —
// huge, not useful for the copilot, wastes tokens). Single WSL call: find →
// file -b (skip binary) → head -c (cap per file) → echo markers. Returns
// { path, content }[] with paths relative to the case root.
export function readCaseFilesDeep(caseName: string): { path: string; content: string }[] {
  const casePath = getCasePath(caseName);
  const script = `#!/bin/bash
CASE=${shellQuote(casePath)}
[ -d "$CASE" ] || { echo "NOEXIST"; exit 0; }
# Find all files under 0/, system/, constant/ — EXCLUDING constant/polyMesh/.
# The -path '*/polyMesh/*' -prune skips polyMesh entirely (and its subdirs).
# Outputs FULL paths; the JS side strips the CASE/ prefix (avoids bash \${f#...}
# which conflicts with JS template-literal interpolation).
find "$CASE/0" "$CASE/system" "$CASE/constant" \\
  -path '*/polyMesh/*' -prune -o \\
  -type f -print 2>/dev/null | while IFS= read -r f; do
  # Skip binaries
  ft=$(file -b "$f" 2>/dev/null | head -c 40)
  case "$ft" in
    *ELF*|*executable*|*data*|*compressed*) continue ;;
  esac
  printf '===FILE===%s\\n' "$f"
  head -c 8000 "$f" 2>/dev/null
  printf '\\n===END===\\n'
done
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 30000);
    if (out.startsWith('NOEXIST')) return [];
    const files: { path: string; content: string }[] = [];
    const blocks = out.split('===FILE===');
    const prefix = casePath + '/';
    for (const block of blocks.slice(1)) {
      const endIdx = block.indexOf('===END===');
      if (endIdx < 0) continue;
      const nl = block.indexOf('\n');
      if (nl < 0) continue;
      const fullPath = block.substring(0, nl).trim();
      const path = fullPath.startsWith(prefix) ? fullPath.substring(prefix.length) : fullPath;
      const content = block.substring(nl + 1, endIdx).replace(/\n$/, '');
      if (path) files.push({ path, content });
    }
    return files;
  } catch {
    return [];
  }
}

// ── Search the CONTENT of multiple OpenFOAM install trees at once ──
// Unlike searchFoamTree (which matches file PATHS), this greps the actual
// file CONTENTS with grep -r -l to find files that mention the query terms,
// then reads up to `maxBytesPerFile` of each. Used by the FOAMy copilot for
// "deep search" mode: when the user activates the install-context toggle,
// FOAMy greps applications/ + src/ + tutorials/ for the query keywords and
// reads the matching files — so it can answer "how do I write a fixedValue BC"
// by reading the actual OpenFOAM source that defines fixedValue.
//
// `roots` is an array of { section, rootDir } pairs so the results carry their
// section origin. Single WSL call per root (parallelizable in JS via Promise.all).
export function searchFoamContent(
  roots: { section: string; rootDir: string }[],
  pattern: string,
  maxFilesPerRoot = 4,
  maxBytesPerFile = 4096
): { section: string; path: string; content: string; rootDir: string }[] {
  if (!roots.length) return [];
  const safePattern = pattern.replace(/'/g, `'"'"'`).replace(/[\r\n]/g, '');
  if (!safePattern) return [];

  const results: { section: string; path: string; content: string; rootDir: string }[] = [];
  // Sequential per-root grep (runInWslScript is synchronous). Each root is an
  // independent WSL call; we cap candidates at 30 and files returned at
  // maxFilesPerRoot to bound total WSL time and token usage.
  for (const { section, rootDir } of roots) {
    if (!rootDir || !rootDir.startsWith('/') || rootDir.includes('..')) continue;
    const script = `#!/bin/bash
ROOT=${shellQuote(rootDir)}
PATTERN='${safePattern}'
MAXFILES=${maxFilesPerRoot}
MAXBYTES=${maxBytesPerFile}
[ -d "$ROOT" ] || exit 0
# grep -rIl: list files whose CONTENT matches (case-insensitive), binary skip (-I).
# Cap candidates at 30 to bound WSL time.
count=0
grep -rIl -e "$PATTERN" "$ROOT" 2>/dev/null | head -30 | while IFS= read -r f; do
  [ -f "$f" ] || continue
  # Skip binaries (defensive — grep -I should have, but double-check)
  ft=$(file -b "$f" 2>/dev/null | head -c 40)
  case "$ft" in
    *ELF*|*executable*|*data*|*compressed*) continue ;;
  esac
  printf '===FILE===%s\\n' "$f"
  head -c "$MAXBYTES" "$f" 2>/dev/null
  printf '\\n===END===\\n'
  count=$((count + 1))
  [ $count -ge $MAXFILES ] && break
done
`;
    const b64 = Buffer.from(script).toString('base64');
    try {
      const out = runInWslScript(b64, 30000);
      const blocks = out.split('===FILE===');
      const prefix = rootDir + '/';
      for (const block of blocks.slice(1)) {
        const endIdx = block.indexOf('===END===');
        if (endIdx < 0) continue;
        const nl = block.indexOf('\n');
        if (nl < 0) continue;
        const fullPath = block.substring(0, nl).trim();
        const relPath = fullPath.startsWith(prefix) ? fullPath.substring(prefix.length) : fullPath;
        const content = block.substring(nl + 1, endIdx).replace(/\n$/, '');
        if (relPath) results.push({ section, path: relPath, content, rootDir });
      }
    } catch {
      /* skip this root on error */
    }
  }
  return results;
}

// ── Run `<command> -help` inside the OpenFOAM environment ──
// Used by the FOAMy copilot to fetch authoritative syntax/usage info for any
// OpenFOAM command or solver (e.g. "blockMesh -help", "icoFoam -help"). The
// output is capped to keep token usage bounded. Returns empty string on failure.
export function runFoamHelp(command: string, maxBytes = 6000): string {
  // Validate the command: only allow letters, digits, and a few separators.
  // This prevents shell injection via the foamExec call (the command is passed
  // as an argument to bash -c inside foamSource).
  if (!/^[\w./-]+$/.test(command) || command.length > 64) return '';
  try {
    const out = foamExec(`${command} -help 2>&1 | head -c ${maxBytes}`, undefined, 15000);
    return out.trim();
  } catch {
    return '';
  }
}

// ── Batch: info of all cases in a SINGLE WSL call ──
export function listCasesBatch(): {
  name: string;
  dirs: string[];
  fileCount: Record<string, number>;
  timeStepCount: number;
  lastTimeStep: string;
  hasLog: boolean;
  logFiles: string[];
}[] {
  const runDir = getRunDirectory();
  if (!runDir) return [];

  const debug: string[] = [];
  try {
    debug.push(`runDir=${runDir}`);
    const script = `
RD=${shellQuote(runDir)}
if [ -d "$RD" ]; then echo "DBG:dir_exists=yes"; else echo "DBG:dir_exists=no"; fi
for casedir in "$RD"/*/; do
  [ -d "$casedir" ] || continue
  name=$(basename "$casedir")
  fc0=0; fcsys=0; fccon=0
  [ -d "$casedir/0" ] && fc0=$(find "$casedir/0" -maxdepth 1 -type f 2>/dev/null | wc -l)
  [ -d "$casedir/system" ] && fcsys=$(find "$casedir/system" -maxdepth 1 -type f 2>/dev/null | wc -l)
  [ -d "$casedir/constant" ] && fccon=$(find "$casedir/constant" -maxdepth 1 -type f 2>/dev/null | wc -l)
  tsc=0; lastts=""
  for d in "$casedir"/*/; do
    [ -d "$d" ] || continue
    bn=$(basename "$d")
    case "$bn" in 0|system|constant|processor*|postProcessing) continue ;; esac
    if printf '%s' "$bn" | grep -qE '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'; then
      tsc=$((tsc + 1)); lastts="$bn"
    fi
  done
  logs=$(find "$casedir" -maxdepth 1 -name 'log.*' -type f -exec basename {} \\; 2>/dev/null | tr '\\n' ' ')
  hlog="no"; [ -n "$logs" ] && hlog="yes"
  echo "CASE|$name|0:$fc0 system:$fcsys constant:$fccon|$tsc|\${lastts:- }|$hlog|$logs"
done
echo "DBG:done"
`;
    const output = runInWsl(script, 60000).trim();
    debug.push(`output_len=${output.length}`);
    if (!output) return [];

    for (const line of output.split('\n')) {
      if (line.startsWith('DBG:')) debug.push(line);
    }
    const caseLines = output.split('\n').filter(l => l.startsWith('CASE|'));
    debug.push(`case_lines=${caseLines.length}`);

    if (caseLines.length === 0) {
      debug.push('fallback=trying_find');
      try {
        const findOut = runInWsl(`find ${shellQuote(runDir)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null`).trim();
        debug.push(`find_output_len=${findOut.length}`);
        if (findOut) {
          return findOut.split('\n').filter(Boolean).map(name => ({
            name,
            dirs: [],
            fileCount: {},
            timeStepCount: 0,
            lastTimeStep: '',
            hasLog: false,
            logFiles: [],
          })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        }
      } catch (e: any) {
        debug.push(`find_error=${e.message}`);
      }
      return [];
    }

    return caseLines.map(line => {
      const parts = line.substring(5).split('|');
      const name = parts[0] || '';
      const fileCount: Record<string, number> = {};
      if (parts[1]) {
        for (const kv of parts[1].trim().split(' ')) {
          const [k, v] = kv.split(':');
          if (k && v) fileCount[k] = parseInt(v, 10) || 0;
        }
      }
      return {
        name,
        dirs: [],
        fileCount,
        timeStepCount: parseInt(parts[2] || '0', 10),
        lastTimeStep: parts[3] || '',
        hasLog: parts[4] === 'yes',
        logFiles: (parts[5] || '').trim().split(' ').filter(Boolean),
      };
    }).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } catch (e: any) {
    debug.push(`EXCEPTION=${e.message}`);
    return [];
  }
}

export function createCase(caseName: string, template?: string): string {
  const safeName = validateCaseName(caseName);
  const casePath = getCasePath(safeName);
  try {
    runInWsl(`mkdir -p -- ${shellQuote(`${casePath}/0`)} ${shellQuote(`${casePath}/system`)} ${shellQuote(`${casePath}/constant`)} && echo "OK"`);
    return safeName;
  } catch (e: any) {
    throw new Error(`Case creation failed: ${e.message}`);
  }
}

export function deleteCase(caseName: string): void {
  const casePath = getCasePath(caseName);
  try {
    runInWsl(`rm -rf -- ${shellQuote(casePath)}`);
  } catch (e: any) {
    throw new Error(`Unable to delete ${caseName}: ${e.message}`);
  }
}

// ── Tutorial categories (top-level dirs under $FOAM_TUTORIALS) ──
export function listTutorialCategories(): { name: string; path: string }[] {
  try {
    const tutDir = getTutorialDirectory();
    if (!tutDir) return [];
    return runInWsl(`find ${shellQuote(tutDir)} -mindepth 1 -maxdepth 1 -type d -printf '%p\\n' 2>/dev/null`)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(p => p.replace(/\/+$/, ''))
      .map(p => ({
        name: p.split('/').pop() || '',
        path: p,
      }))
      .filter(c => c.name);
  } catch {
    return [];
  }
}

// ── Tutorial cases inside a category (one level deep) ──
export function listTutorialCases(categoryPath: string): { name: string; fullPath: string }[] {
  const category = validatePathWithin(getTutorialDirectory(), categoryPath, 'Tutorial category');
  try {
    return runInWsl(`find ${shellQuote(category)} -mindepth 1 -maxdepth 1 -type d -printf '%p\\n' 2>/dev/null`)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(p => p.replace(/\/+$/, ''))
      .map(p => ({
        name: p.split('/').pop() || '',
        fullPath: p,
      }))
      .filter(c => c.name);
  } catch {
    return [];
  }
}

export function copyTutorial(tutorialPath: string, newCaseName: string): string {
  const runDir = getRunDirectory();
  const sourcePath = validatePathWithin(getTutorialDirectory(), tutorialPath, 'Tutorial path');
  const safeName = validateCaseName(newCaseName);
  const destinationPath = `${runDir}/${safeName}`;
  try {
    runInWsl(
      `test ! -e ${shellQuote(destinationPath)} || { echo "Case already exists" >&2; exit 1; }; ` +
      `cp -r -- ${shellQuote(sourcePath)} ${shellQuote(destinationPath)} && echo "OK"`,
      60000
    );
    return safeName;
  } catch (e: any) {
    throw new Error(`Tutorial copy failed: ${e.message}`);
  }
}

// ── File/directory item type used throughout the file-tree API ──
export interface CaseFileItem {
  name: string;
  path: string;
  isDir: boolean;
}

// ── Get case structure (dirs, files in each dir, timesteps) in ONE WSL call ──
export function getCaseInfo(caseName: string): {
  exists: boolean;
  directories: string[];
  files: Record<string, CaseFileItem[]>;
  timeSteps: string[];
} {
  const casePath = getCasePath(caseName);
  try {
    if (runInWsl(`test -d ${shellQuote(casePath)} && echo "yes" || echo "no"`).trim() !== 'yes') {
      return { exists: false, directories: [], files: {}, timeSteps: [] };
    }

    const script = `
CASEPATH=${shellQuote(casePath)}
for item in "$CASEPATH"/*; do
  [ -e "$item" ] || continue
  bn=$(basename "$item")
  if [ -d "$item" ]; then
    echo "D|$bn"
    for sub in "$item"/*; do
      [ -e "$sub" ] || continue
      sbn=$(basename "$sub")
      if [ -d "$sub" ]; then
        echo "S|$bn|$sbn"
      else
        echo "F|$bn|$sbn"
      fi
    done
  else
    echo "R|$bn"
  fi
done
ts=""
for d in "$CASEPATH"/*/; do
  [ -d "$d" ] || continue
  bn=$(basename "$d")
  case "$bn" in 0|system|constant|processor*|postProcessing) continue ;; esac
  if printf '%s' "$bn" | grep -qE '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'; then
    ts="$ts$bn,"
  fi
done
ts=$(printf '%s' "$ts" | tr ',' '\\n' | grep -v '^$' | sort -gu | tr '\\n' ',' | tr -d '\\r')
echo "TS:$ts"
`;
    const b64 = Buffer.from(script).toString('base64');
    const output = runInWslScript(b64, 60000)
      .trim()
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '');

    if (!output) return { exists: true, directories: [], files: {}, timeSteps: [] };

    const lines = output.split('\n');
    const files: Record<string, CaseFileItem[]> = {};
    const directories: string[] = [];
    let timeSteps: string[] = [];

    for (const line of lines) {
      if (line.startsWith('TS:')) {
        timeSteps = line.substring(3).split(',').filter(Boolean);
      } else if (line.startsWith('D|')) {
        const dirName = line.substring(2);
        directories.push(dirName);
        files[dirName] = [];
      } else if (line.startsWith('S|')) {
        const parts = line.substring(2).split('|');
        const parentDir = parts[0];
        const subName = parts[1];
        if (!files[parentDir]) files[parentDir] = [];
        files[parentDir].push({ name: subName, path: `${parentDir}/${subName}`, isDir: true });
      } else if (line.startsWith('F|')) {
        const parts = line.substring(2).split('|');
        const parentDir = parts[0];
        const fileName = parts[1];
        if (!files[parentDir]) files[parentDir] = [];
        files[parentDir].push({ name: fileName, path: `${parentDir}/${fileName}`, isDir: false });
      } else if (line.startsWith('R|')) {
        files['_root'] = files['_root'] || [];
        const name = line.substring(2);
        files['_root'].push({ name, path: name, isDir: false });
      }
    }

    return { exists: true, directories, files, timeSteps };
  } catch {
    return { exists: false, directories: [], files: {}, timeSteps: [] };
  }
}

// ── List contents of ANY subdirectory inside a case (lazy-loading support) ──
export function listDirectory(caseName: string, dirPath: string): CaseFileItem[] {
  const safeDirPath = validateRelativePath(dirPath, 'Directory path', true);
  const casePath = getCasePath(caseName);
  const fullPath = safeDirPath ? `${casePath}/${safeDirPath}` : casePath;
  try {
    if (runInWsl(`test -d ${shellQuote(fullPath)} && echo "yes" || echo "no"`).trim() !== 'yes') {
      return [];
    }

    const script = `
DIRPATH=${shellQuote(fullPath)}
for item in "$DIRPATH"/*; do
  [ -e "$item" ] || continue
  bn=$(basename "$item")
  if [ -d "$item" ]; then
    echo "d|$bn"
  else
    echo "f|$bn"
  fi
done
`;
    const b64 = Buffer.from(script).toString('base64');
    const output = runInWslScript(b64, 15000)
      .trim()
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '');

    if (!output) return [];

    const items: CaseFileItem[] = [];
    for (const line of output.split('\n')) {
      if (line.startsWith('d|')) {
        const name = line.substring(2);
        items.push({ name, path: safeDirPath ? `${safeDirPath}/${name}` : name, isDir: true });
      } else if (line.startsWith('f|')) {
        const name = line.substring(2);
        items.push({ name, path: safeDirPath ? `${safeDirPath}/${name}` : name, isDir: false });
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function readFile(caseName: string, filePath: string): string {
  try {
    const safePath = validateRelativePath(filePath, 'File path');
    return runInWsl(`cat -- ${shellQuote(`${getCasePath(caseName)}/${safePath}`)}`, 10000);
  } catch (e: any) {
    throw new Error(`Unable to read ${filePath}: ${e.message}`);
  }
}

export function writeFile(caseName: string, filePath: string, content: string): void {
  const safePath = validateRelativePath(filePath, 'File path');
  const casePath = getCasePath(caseName);
  const fullPath = `${casePath}/${safePath}`;
  const dirPath = path.posix.dirname(fullPath);

  runInWsl(`mkdir -p -- ${shellQuote(dirPath)}`);

  const b64 = Buffer.from(content).toString('base64');
  try {
    runInWslWithInput(`base64 -d > ${shellQuote(fullPath)}`, b64, 30000);
  } catch (e: any) {
    throw new Error(`Unable to write ${filePath}: ${e.message}`);
  }
}

export function createDirectory(caseName: string, dirPath: string): string {
  const safePath = validateRelativePath(dirPath, 'Directory path');
  return runInWsl(`mkdir -p -- ${shellQuote(`${getCasePath(caseName)}/${safePath}`)}`);
}

export function deleteFile(caseName: string, filePath: string): string {
  const safePath = validateRelativePath(filePath, 'File path');
  return runInWsl(`rm -f -- ${shellQuote(`${getCasePath(caseName)}/${safePath}`)}`);
}

export function deletePath(caseName: string, targetPath: string): string {
  const safePath = validateRelativePath(targetPath);
  return runInWsl(`rm -rf -- ${shellQuote(`${getCasePath(caseName)}/${safePath}`)}`);
}

// ── Delete all timestep dirs except 0 ──
export function deleteAllTimesteps(caseName: string): { deleted: string[]; count: number } {
  const casePath = getCasePath(caseName);
  try {
    const bashScript = [
      `CASEPATH=${shellQuote(casePath)}`,
      `cd "$CASEPATH" || exit 1`,
      `count=0`,
      `deleted=""`,
      `for d in "$CASEPATH"/*/; do`,
      `  [ -d "$d" ] || continue`,
      `  bn=$(basename "$d")`,
      `  [ "$bn" = "0" ] && continue`,
      `  case "$bn" in`,
      `    0|system|constant|processor*|postProcessing) continue ;;`,
      `  esac`,
      `  if printf '%s' "$bn" | grep -qE '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'; then`,
      `    rm -rf "$CASEPATH/$bn"`,
      `    deleted="$deleted $bn"`,
      `    count=$((count + 1))`,
      `  fi`,
      `done`,
      `echo "DELETED:$count:$deleted"`,
    ].join('\n');

    const b64 = Buffer.from(bashScript).toString('base64');
    const output = runInWslScript(b64, 120000)
      .trim()
      .match(/DELETED:(\d+):(.*)/);

    if (output) {
      return { count: parseInt(output[1]), deleted: output[2].trim().split(/\s+/).filter(Boolean) };
    }
    return { deleted: [], count: 0 };
  } catch {
    return { deleted: [], count: 0 };
  }
}

// ── Normalize a user command to handle common issues ──
function normalizeCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (/^\.\/[A-Za-z_]/.test(trimmed)) {
    return `bash ${cmd}`;
  }
  if (/^(Allrun|Allclean)\b/.test(trimmed)) {
    return `bash ./${cmd}`;
  }
  return cmd;
}

// ── Warm-up WSL once (non-blocking) ──
let wslWarmedUp = false;
function warmUpWslOnce(): void {
  if (wslWarmedUp) return;
  wslWarmedUp = true;
  setTimeout(() => {
    try { runInWsl('true', 5000); } catch {}
    try { findBashrc(); } catch {}
  }, 0);
}

// ── Async command execution with streaming logs (used by /api/commands) ──
export function executeCommandAsync(
  caseName: string,
  command: string,
  onLog?: (data: string) => void
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        warmUpWslOnce();

        const casePath = getCasePath(caseName);
        let output = '';
        let outputTruncated = false;
        const outputLimit = 5 * 1024 * 1024;
        const appendOutput = (chunk: string) => {
          if (output.length >= outputLimit) {
            outputTruncated = true;
            return;
          }
          const remaining = outputLimit - output.length;
          output += chunk.slice(0, remaining);
          if (chunk.length > remaining) outputTruncated = true;
        };
        const src = foamSource();
        const normalizedCommand = normalizeCommand(command);
        const trimmed = normalizedCommand.trimEnd();
        const isBackground = trimmed.endsWith('&');

        let fullCmd: string;
        let pidFile: string | null = null;

        if (isBackground) {
          const inner = trimmed.slice(0, -1).trimEnd(); // remove trailing &
          const scriptId = Math.random().toString(36).substring(2, 10);
          const tmpScript = `/tmp/wslgui_bg_${scriptId}.sh`;
          pidFile = `/tmp/wslgui_bg_${scriptId}.pid`;

          const hasRedirect = />|>>|&>|&>>/.test(inner);
          const commandToken = inner.trim().split(/\s+/)[0] || 'unknown';
          const cmdName = path.posix.basename(commandToken).replace(/[^A-Za-z0-9._-]/g, '_') || 'command';
          const outputRedirect = hasRedirect ? '' : ` > log.${cmdName} 2>&1`;

          const scriptContent = `#!/bin/bash
${src}
cd ${shellQuote(casePath)} 2>/dev/null || exit 1
echo $$ > "${pidFile}"
exec ${inner}${outputRedirect}
`;
          const workerB64 = Buffer.from(scriptContent).toString('base64');

          const launcherContent = `#!/bin/bash
echo "${workerB64}" | base64 -d > "${tmpScript}"
chmod +x "${tmpScript}" 2>/dev/null || true
if command -v setsid >/dev/null 2>&1; then
  nohup setsid -f bash "${tmpScript}" </dev/null >/dev/null 2>&1 &
else
  nohup bash "${tmpScript}" </dev/null >/dev/null 2>&1 & disown
fi
for i in $(seq 1 20); do
  [ -s "${pidFile}" ] && break
  sleep 0.1
done
if [ -s "${pidFile}" ]; then
  echo "BG_PID=$(cat "${pidFile}")"
else
  echo "BG_PID="
fi
`;
          const launcherB64 = Buffer.from(launcherContent).toString('base64');

          fullCmd = `bash -c 'echo "${launcherB64}" | base64 -d > "/tmp/wslgui_launch_${scriptId}.sh" && bash "/tmp/wslgui_launch_${scriptId}.sh" && rm -f "/tmp/wslgui_launch_${scriptId}.sh" 2>/dev/null || true'`;
        } else {
          fullCmd = `${src}${trimmed}`;
        }

        const distro = getDistro();
        const wslArgs = ['-d', distro, '--', 'bash', '-c',
          `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; cd ${shellQuote(casePath)} 2>/dev/null && ${fullCmd}`,
        ];
        const proc = spawn('wsl', wslArgs, {
          env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let resolved = false;

        const finish = (code: number, out: string) => {
          if (resolved) return;
          resolved = true;
          resolve({
            exitCode: code,
            output: outputTruncated ? `${out}\n\n[Output limited to 5 MiB]` : out,
          });
        };

        proc.stdout.on('data', (data: Buffer) => {
          const str = data.toString();
          appendOutput(str);
          onLog?.(str);
        });

        proc.stderr.on('data', (data: Buffer) => {
          const str = data.toString();
          appendOutput(str);
          onLog?.(str);
        });

        proc.on('close', (code) => {
          finish(code || 0, output);
        });

        proc.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });

        if (isBackground) {
          setTimeout(() => {
            if (!resolved) {
              try { proc.unref(); } catch {}

              const bgPidMatch = output.match(/BG_PID=(\d+)/);
              const capturedPid = bgPidMatch ? bgPidMatch[1] : null;

              if (!capturedPid) {
                let retryPid: string | null = null;
                try {
                  if (pidFile) {
                    const pidOut = runInWsl(`cat "${pidFile}" 2>/dev/null`, 5000);
                    retryPid = pidOut.trim() || null;
                  }
                } catch { /* ignore */ }

                if (!retryPid) {
                  finish(-1,
                    output + '\n\n[ERROR] Unable to confirm background command startup.\n' +
                    'WSL is probably still starting the VM. Try again in a few seconds.\n'
                  );
                  return;
                }
                verifyPid(retryPid);
              } else {
                verifyPid(capturedPid);
              }
            }
          }, 8000);
        }

        function verifyPid(pid: string) {
          validatePid(pid);
          const maxAttempts = 5;
          const attemptInterval = 2000;
          let attempts = 0;

          const tryVerify = () => {
            attempts++;
            try {
              const checkResult = runInWsl(
                `kill -0 "${pid}" 2>/dev/null && echo "ALIVE" || echo "DEAD"`,
                5000
              );
              if (checkResult.trim().includes('ALIVE')) {
                finish(0, output || `(started in background, PID ${pid})`);
              } else if (attempts < maxAttempts) {
                setTimeout(tryVerify, attemptInterval);
              } else {
                finish(0, output || `(background command terminated quickly, PID ${pid})`);
              }
            } catch {
              if (attempts < maxAttempts) {
                setTimeout(tryVerify, attemptInterval);
              } else {
                finish(0, output || `(started in background — unable to verify status, PID ${pid})`);
              }
            }
          };
          setTimeout(tryVerify, 1000);
        }
      } catch (err) {
        reject(err);
      }
    }); // setImmediate
  });
}

// ── List running OpenFOAM processes ──
export function getProcesses(): string {
  // For each OpenFOAM process, also resolve its working directory so the Monitor
  // can tell which case a process belongs to. `readlink /proc/<pid>/cwd` is the
  // universal Linux mechanism (WSL2 Ubuntu supports it); `pwdx` is the fallback.
  // The cwd is appended to each ps line after a `|` separator.
  //
  // Uses runInWslScript (base64-encoded) rather than runInWsl because the
  // while-read loop with nested $(...), awk, sed, readlink is too complex for
  // safe inline quoting — every other non-trivial script in this file
  // (deleteAllTimesteps, getCaseInfo, getTimeStepsOnly, killProcessesForCase)
  // uses the same base64 pattern. The loop ALWAYS emits the ps line, even if
  // readlink fails (cwd just ends up empty) — so the process list never
  // disappears just because cwd resolution had a bad day.
  const script = `#!/bin/bash
ps -e -o user= -o pid= -o %cpu= -o %mem= -o vsz= -o rss= -o stat= -o time= -o etimes= -o command= |
grep -E "foamRun|decompressPar|reconstructPar|simpleFoam|icoFoam|pimpleFoam|snappyHexMesh|blockMesh|checkMesh|wslgui_bg_" |
grep -v grep |
while IFS= read -r line; do
  pid=$(printf '%s' "$line" | awk '{print $2}')
  cwd=""
  if [ -n "$pid" ]; then
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
    [ -z "$cwd" ] && cwd=$(pwdx "$pid" 2>/dev/null | sed 's/^[0-9]*: //')
  fi
  printf '%s|%s\\n' "$line" "$cwd"
done
`;
  try {
    return runInWslScript(Buffer.from(script).toString('base64'));
  } catch {
    return '';
  }
}

export function killProcess(pid: string): string {
  const safePid = validatePid(pid);
  try {
    return runInWsl(`kill -TERM -- ${safePid} 2>&1 && echo OK`);
  } catch (e: any) {
    throw new Error(e.message);
  }
}

// ── Kill every OpenFOAM-related process running in the distro ──
export function killAllProcesses(): { killed: number; output: string } {
  const scriptContent = `#!/bin/bash
PIDS=$(ps -e -o pid= -o command= | grep -E "foamRun|decomposePar|reconstructPar|simpleFoam|icoFoam|pimpleFoam|snappyHexMesh|blockMesh|checkMesh|wslgui_bg_" | grep -v grep | awk '{print $1}')
COUNT=0
for P in $PIDS; do
  kill -9 $P 2>/dev/null
  pkill -9 -P $P 2>/dev/null
  COUNT=$((COUNT+1))
done
echo "killed=$COUNT"
`;
  const b64 = Buffer.from(scriptContent).toString('base64');

  try {
    const result = runInWslScript(b64, 30000).trim();
    const match = result.match(/killed=(\d+)/);
    const killed = match ? parseInt(match[1]) : 0;
    return { killed, output: result };
  } catch (e: any) {
    return { killed: 0, output: `Error: ${e.message}` };
  }
}

// ── Kill only the OpenFOAM processes belonging to a specific case ──
// A process is attributed to the case when its working directory (resolved via
// /proc/<pid>/cwd) equals the case directory or lives underneath it (parallel
// decomposed runs keep their per-rank processes in processor*/ subdirs).
// Uses SIGTERM (graceful, lets the solver flush) then SIGKILLs children.
export function killProcessesForCase(caseName: string): { killed: number; pids: string[]; output: string } {
  const casePath = getCasePath(caseName);
  const scriptContent = `#!/bin/bash
TARGET=${shellQuote(casePath)}
PIDS=$(ps -e -o pid= -o command= | grep -E "foamRun|decomposePar|reconstructPar|simpleFoam|icoFoam|pimpleFoam|snappyHexMesh|blockMesh|checkMesh|wslgui_bg_" | grep -v grep | awk '{print $1}')
COUNT=0
KILLED=""
for P in $PIDS; do
  cwd=$(readlink "/proc/$P/cwd" 2>/dev/null)
  [ -z "$cwd" ] && continue
  # Match the case dir itself or anything beneath it (processor0/, etc.)
  # Uses case/glob (not \${cwd#...}) to avoid JS template interpolation.
  case "$cwd" in
    "$TARGET"|"$TARGET"/*)
      kill -TERM "$P" 2>/dev/null
      pkill -9 -P "$P" 2>/dev/null
      KILLED="$KILLED $P"
      COUNT=$((COUNT+1))
      ;;
  esac
done
echo "killed=$COUNT:$KILLED"
`;
  const b64 = Buffer.from(scriptContent).toString('base64');
  try {
    const result = runInWslScript(b64, 30000).trim();
    const match = result.match(/killed=(\d+):(.*)/);
    const killed = match ? parseInt(match[1]) : 0;
    const pids = match ? match[2].trim().split(/\s+/).filter(Boolean) : [];
    return { killed, pids, output: result };
  } catch (e: any) {
    return { killed: 0, pids: [], output: `Error: ${e.message}` };
  }
}

export function getCaseLog(caseName: string, logFile: string, tail = 100): string {
  const casePath = getCasePath(caseName);
  const safeLogName = validateLogName(logFile);
  const safeTail = boundedInteger(tail, 100, 1, 50000);
  const logPath = safeLogName === 'log' ? `${casePath}/log` : `${casePath}/log.${safeLogName}`;
  const cmd = safeTail >= 50000 ? `cat -- ${shellQuote(logPath)}` : `tail -n ${safeTail} -- ${shellQuote(logPath)}`;
  try {
    return runInWsl(`${cmd} 2>/dev/null || echo ${shellQuote(`Log not found: ${safeLogName}`)}`, safeTail > 1000 ? 120000 : 30000);
  } catch {
    return `Log not found: ${safeLogName}`;
  }
}

export function listLogFiles(caseName: string): string[] {
  const casePath = getCasePath(caseName);
  try {
    const output = runInWsl(`(
  find ${shellQuote(casePath)} -mindepth 1 -maxdepth 1 -type f -name 'log.*' -printf '%p\\n' 2>/dev/null;
  if [ -f ${shellQuote(`${casePath}/log`)} ]; then
    echo ${shellQuote(`${casePath}/log`)}
  fi
) || true`);
    return output.trim().split('\n').filter(Boolean).map(f => {
      const base = f.split('/').pop() || f;
      if (base === 'log') return 'log';
      return base.replace(/^log\./, '');
    });
  } catch {
    return [];
  }
}

// ── Clone a case (only 0/, system/, constant/ — no timesteps, no logs) ──
export function cloneCase(sourceName: string, newName: string): string {
  const srcPath = getCasePath(sourceName);
  const dstPath = getCasePath(newName);
  // Avoid embedding newName directly to prevent odd quoting; refer to $DST in message
  const b64 = Buffer.from(`
SRC=${shellQuote(srcPath)}
DST=${shellQuote(dstPath)}
if [ -d "$DST" ]; then echo "ERROR: case already exists: $DST"; exit 1; fi
mkdir -p "$DST"
for d in 0 system constant; do
  if [ -d "$SRC/$d" ]; then cp -r "$SRC/$d" "$DST/"; fi
done
echo "OK: cloned"
`).toString('base64');
  return runInWslScript(b64, 30000).trim();
}

// ── Rename a case directory in $FOAM_RUN ──
// Validates both names, refuses to overwrite an existing destination, and uses
// `mv` so the operation is atomic and instant regardless of case size. Returns
// the new validated name on success; throws WslInputError on bad names or a
// generic Error if the destination already exists or the move fails.
export function renameCase(oldName: string, newName: string): string {
  const safeOld = validateCaseName(oldName);
  const safeNew = validateCaseName(newName);
  if (safeOld === safeNew) return safeNew;
  const oldPath = `${getRunDirectory()}/${safeOld}`;
  const newPath = `${getRunDirectory()}/${safeNew}`;
  const b64 = Buffer.from(`
SRC=${shellQuote(oldPath)}
DST=${shellQuote(newPath)}
if [ ! -d "$SRC" ]; then echo "ERROR: case not found: $SRC"; exit 1; fi
if [ -e "$DST" ]; then echo "ERROR: a case with this name already exists: $DST"; exit 1; fi
mv -- "$SRC" "$DST" && echo "OK: renamed" || { echo "ERROR: mv failed"; exit 1; }
`).toString('base64');
  const result = runInWslScript(b64, 30000).trim();
  if (!result.startsWith('OK')) {
    throw new Error(result.replace(/^ERROR:\s*/, '') || 'Rename failed');
  }
  return safeNew;
}

// ── Helper: extract content inside a { } block using brace counting ──
function extractBraceBlock(str: string, openBracePos: number): string | null {
  if (str[openBracePos] !== '{') return null;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = openBracePos; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && (i === 0 || str[i - 1] !== '\\')) { inDoubleQuote = !inDoubleQuote; continue; }
    if (ch === "'" && (i === 0 || str[i - 1] !== '\\')) { inSingleQuote = !inSingleQuote; continue; }
    if (inSingleQuote || inDoubleQuote) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(openBracePos + 1, i);
      }
    }
  }
  return null;
}

// ── Validate Boundary Conditions ──
export interface BCValidationResult {
  success: boolean;
  fields: {
    name: string;
    patches: { patch: string; type: string; valid: boolean; note?: string }[];
  }[];
  meshPatches: string[];
  warnings: string[];
}

export function validateBoundaryConditions(caseName: string): BCValidationResult {
  const casePath = getCasePath(caseName);
  const result: BCValidationResult = { success: false, fields: [], meshPatches: [], warnings: [] };

  try {
    // 1. Get mesh patches from boundary file
    let boundaryFile = '';
    try {
      boundaryFile = runInWsl(`cat -- ${shellQuote(`${casePath}/constant/polyMesh/boundary`)} 2>/dev/null`).trim();
    } catch { /* try alternate location */ }

    if (!boundaryFile) {
      try {
        boundaryFile = runInWsl(`find ${shellQuote(`${casePath}/constant`)} -name boundary -exec cat {} \\; 2>/dev/null | head -200`).trim();
      } catch { /* */ }
    }

    const patchNames: string[] = [];
    const patchTypes: string[] = [];
    const patchGroups: Map<string, string[]> = new Map();
    const allGroups: Set<string> = new Set();
    if (boundaryFile) {
      const blockRegex = /^\s*(\S+)\s*\{([\s\S]*?)\n\s*\}/gm;
      let m;
      while ((m = blockRegex.exec(boundaryFile)) !== null) {
        const name = m[1];
        const body = m[2];
        if (['FoamFile', 'boundary', 'locationInMesh', 'searchableSurface'].includes(name)) continue;
        patchNames.push(name);
        const typeMatch = body.match(/type\s+(\S+)\s*;/);
        if (typeMatch) {
          const pType = typeMatch[1].replace(/;$/, '');
          if (!patchTypes.includes(pType)) patchTypes.push(pType);
        }
        const groupsMatch = body.match(/inGroups\s+List<word>\s+\d+\(([^)]+)\)/);
        if (groupsMatch) {
          const groups = groupsMatch[1].trim().split(/\s+/).filter(Boolean);
          patchGroups.set(name, groups);
          groups.forEach(g => allGroups.add(g));
        }
      }
    }
    result.meshPatches = patchNames;

    function getPatchesCoveredByBC(bcName: string): { matched: string[]; matchType: string } | null {
      if (patchNames.includes(bcName)) {
        return { matched: [bcName], matchType: 'direct' };
      }
      if (patchTypes.includes(bcName)) {
        const matched: string[] = [];
        for (const p of patchNames) {
          const body = boundaryFile.match(new RegExp(`^\\s*${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'));
          if (body && body[1].match(new RegExp(`type\\s+${bcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;`))) {
            matched.push(p);
          }
        }
        return { matched, matchType: 'type' };
      }
      if (allGroups.has(bcName)) {
        const matched: string[] = [];
        for (const [p, groups] of patchGroups) {
          if (groups.includes(bcName)) matched.push(p);
        }
        return { matched, matchType: 'group' };
      }
      const hasRegexChars = /[\[\]\+\(\)\|\^]/.test(bcName);
      const hasGlobChars = /[*?]/.test(bcName);
      if (hasRegexChars || hasGlobChars) {
        try {
          let regexStr: string;
          if (hasGlobChars && !hasRegexChars) {
            regexStr = bcName
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.');
          } else {
            regexStr = bcName;
          }
          const regex = new RegExp(`^${regexStr}$`);
          const matched = patchNames.filter(p => regex.test(p));
          if (matched.length > 0) {
            return { matched, matchType: hasGlobChars && !hasRegexChars ? 'wildcard' : 'regex' };
          }
        } catch { /* invalid regex, fall through */ }
      }
      return null;
    }

    const zeroDir = runInWsl(`find ${shellQuote(`${casePath}/0`)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null`).trim();
    const fieldFiles = zeroDir.split('\n').filter(f => {
      const name = f.trim();
      if (!name) return false;
      if (name === '.' || name === '..') return false;
      return true;
    });

    if (fieldFiles.length === 0) {
      result.warnings.push('Directory 0/ empty or nonexistent');
      result.success = true;
      return result;
    }

    for (const fieldFile of fieldFiles) {
      let content = '';
      try {
        content = runInWsl(`cat -- ${shellQuote(`${casePath}/0/${fieldFile}`)} 2>/dev/null`).trim();
      } catch { continue; }

      if (!content) continue;

      const patches: { patch: string; type: string; valid: boolean; note?: string }[] = [];

      const bfIdx = content.indexOf('boundaryField');
      if (bfIdx === -1) {
        result.warnings.push(`${fieldFile}: no boundaryField found`);
        continue;
      }

      let pos = bfIdx + 'boundaryField'.length;
      while (pos < content.length && /\s/.test(content[pos])) pos++;
      if (pos >= content.length || content[pos] !== '{') {
        result.warnings.push(`${fieldFile}: boundaryField without opening brace`);
        continue;
      }

      const bfBlock = extractBraceBlock(content, pos);
      if (!bfBlock) {
        result.warnings.push(`${fieldFile}: unable to extract boundaryField`);
        continue;
      }

      let searchPos = 0;
      while (searchPos < bfBlock.length) {
        while (searchPos < bfBlock.length && /\s/.test(bfBlock[searchPos])) searchPos++;
        if (searchPos >= bfBlock.length) break;

        let nameStart = searchPos;
        while (searchPos < bfBlock.length && /[\w.]/.test(bfBlock[searchPos])) searchPos++;
        if (searchPos === nameStart) { searchPos++; continue; }
        const patchName = bfBlock.substring(nameStart, searchPos);

        while (searchPos < bfBlock.length && /\s/.test(bfBlock[searchPos])) searchPos++;
        if (searchPos >= bfBlock.length || bfBlock[searchPos] !== '{') continue;

        const patchBlock = extractBraceBlock(bfBlock, searchPos);
        if (!patchBlock) { searchPos++; continue; }

        searchPos += patchBlock.length + 2;

        const typeMatch = patchBlock.match(/type\s+(\S+)\s*;/);
        if (!typeMatch) continue;

        const bcType = typeMatch[1].replace(/;$/, '');
        let valid = true;
        let note: string | undefined;

        if (patchNames.length > 0 && !patchNames.includes(patchName)) {
          const coverage = getPatchesCoveredByBC(patchName);
          if (coverage) {
            const matchTypeLabels: Record<string, string> = {
              direct: 'Direct',
              type: 'Type',
              group: 'Group',
              wildcard: 'Pattern',
              regex: 'Regex',
            };
            const label = matchTypeLabels[coverage.matchType] || 'Match';
            note = `${label} "${patchName}" — matches: ${coverage.matched.join(', ')}`;
          } else {
            valid = false;
            note = 'Patch not found in mesh';
          }
        }

        patches.push({ patch: patchName, type: bcType, valid, note });
      }

      if (patchNames.length > 0) {
        const coveredPatches = new Set<string>();
        for (const p of patches) {
          if (!p.valid) continue;
          const coverage = getPatchesCoveredByBC(p.patch);
          if (coverage) {
            coverage.matched.forEach(mp => coveredPatches.add(mp));
          }
        }
        for (const mp of patchNames) {
          if (!coveredPatches.has(mp)) {
            patches.push({ patch: mp, type: 'MISSING', valid: false, note: 'BC not defined for this field' });
          }
        }
      }

      if (patches.length > 0) {
        result.fields.push({ name: fieldFile, patches });
      }
    }

    result.success = true;
  } catch (e: any) {
    result.warnings.push(e.message);
  }

  return result;
}

// ── Case Summary ──
export interface CaseSummaryInfo {
  success: boolean;
  solver: string;
  meshCells: string;
  endTime: string;
  deltaT: string;
  writeInterval: string;
  scheme: string;
  patches: string[];
  fieldCount: number;
  timestepCount: number;
  timestepRange: string;
  logSize: string;
}

export function getCaseSummary(caseName: string): CaseSummaryInfo {
  const casePath = getCasePath(caseName);
  const empty: CaseSummaryInfo = {
    success: false, solver: '', meshCells: '', endTime: '', deltaT: '',
    writeInterval: '', scheme: '', patches: [], fieldCount: 0,
    timestepCount: 0, timestepRange: '', logSize: '',
  };

  try {
    const script = `
CASE=${shellQuote(casePath)}
# Solver from controlDict
SOLVER=$(grep -E '^application\\s+' "$CASE/system/controlDict" 2>/dev/null | awk '{print $2}' | tr -d ';')
echo "SOLVER:$SOLVER"
# Time params from controlDict
DT=$(grep -E '^deltaT\\s+' "$CASE/system/controlDict" 2>/dev/null | awk '{print $2}' | tr -d ';')
echo "DT:$DT"
ET=$(grep -E '^endTime\\s+' "$CASE/system/controlDict" 2>/dev/null | awk '{print $2}' | tr -d ';')
echo "ET:$ET"
WI=$(grep -E '^writeInterval\\s+' "$CASE/system/controlDict" 2>/dev/null | awk '{print $2}' | tr -d ';')
echo "WI:$WI"
# Scheme (ddtSchemes)
SCHEME=$(grep -A2 'ddtSchemes' "$CASE/system/fvSchemes" 2>/dev/null | grep 'default' | awk '{print $NF}' | tr -d ';')
echo "SCHEME:$SCHEME"
# Mesh cells (best effort)
CELLS=$(grep -E '^nCells\\s*:' "$CASE/constant/polyMesh/boundary" 2>/dev/null | awk '{print $NF}')
if [ -z "$CELLS" ]; then
  CELLS=$(grep -c '^(' "$CASE/constant/polyMesh/faces" 2>/dev/null || echo "")
fi
echo "CELLS:$CELLS"
# Patch count
PATCHES=$(grep -cE '^\\s*[a-zA-Z][a-zA-Z0-9_]*\\s*\\{' "$CASE/constant/polyMesh/boundary" 2>/dev/null || echo "0")
echo "PATCHES:$PATCHES"
# Field count in 0/
FIELDS=$(ls -1 "$CASE/0/" 2>/dev/null | wc -l)
echo "FIELDS:$FIELDS"
# Timestep count and range
TS_LIST=$(
  for d in "$CASE"/*/; do
    [ -d "$d" ] || continue
    bn=$(basename "$d")
    case "$bn" in 0|system|constant|processor*|postProcessing) continue ;; esac
    printf '%s\\n' "$bn"
  done | grep -E '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' | sort -gu | uniq
)
TS_COUNT=$(printf '%s\\n' "$TS_LIST" | grep -c -v '^$')
TS_FIRST=$(printf '%s\\n' "$TS_LIST" | head -1)
TS_LAST=$(printf '%s\\n' "$TS_LIST" | tail -1)
echo "TS:$TS_COUNT:$TS_FIRST:$TS_LAST"
# Log size (main log)
LOGSIZE=$(stat -c%s "$CASE/log" 2>/dev/null || echo "0")
if [ "$LOGSIZE" = "0" ]; then
  LOGSIZE=$(stat -c%s $CASE/log.* 2>/dev/null | awk '{sum+=$1}END{print sum+0}')
fi
echo "LOGSIZE:$LOGSIZE"
`;

    const output = runInWsl(script, 30000).trim();
    const lines = output.split('\n');

    const get = (prefix: string) => {
      const l = lines.find(x => x.startsWith(prefix + ':'));
      return l ? l.substring(prefix.length + 1) : '';
    };

    const tsCount = parseInt(get('TS').split(':')[0]) || 0;
    const tsFirst = get('TS').split(':')[1] || '';
    const tsLast = get('TS').split(':')[2] || '';
    const logBytes = parseInt(get('LOGSIZE')) || 0;
    const formatBytes = (b: number) => {
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      return (b / 1048576).toFixed(1) + ' MB';
    };

    const patchCount = parseInt(get('PATCHES')) || 0;
    const patchList: string[] = [];
    if (patchCount > 0) {
      try {
        const patchOutput = runInWsl(`grep -E '^\\s*[a-zA-Z][a-zA-Z0-9_]*\\s*\\{' ${shellQuote(`${casePath}/constant/polyMesh/boundary`)} 2>/dev/null | awk '{print $1}' | head -20`).trim();
        patchList.push(...patchOutput.split('\n').filter(Boolean));
      } catch { /* */ }
    }

    return {
      success: true,
      solver: get('SOLVER'),
      meshCells: get('CELLS'),
      endTime: get('ET'),
      deltaT: get('DT'),
      writeInterval: get('WI'),
      scheme: get('SCHEME'),
      patches: patchList,
      fieldCount: parseInt(get('FIELDS')) || 0,
      timestepCount: tsCount,
      timestepRange: tsCount > 0 ? `${tsFirst} → ${tsLast}` : '-',
      logSize: formatBytes(logBytes),
    };
  } catch {
    return empty;
  }
}

// ── Lightweight: fetch ONLY timesteps ──
export function getTimeStepsOnly(caseName: string): string[] {
  const casePath = getCasePath(caseName);
  try {
    // Use directory tests instead of `find -type d`: OpenFOAM cases may keep
    // time directories behind symlinks, especially in decomposed runs.
    // The explicit loop also avoids a non-matching processor* glob poisoning
    // the command and supports every numeric spelling accepted by OpenFOAM.
    const script = `
CASE=${shellQuote(casePath)}
{
  for dir in "$CASE"/*/; do
    [ -d "$dir" ] && basename "$dir"
  done
  for processor in "$CASE"/processor*/; do
    [ -d "$processor" ] || continue
    for dir in "$processor"/*/; do
      [ -d "$dir" ] && basename "$dir"
    done
  done
} | grep -E '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' | sort -gu | uniq
`;
    const output = runInWslScript(Buffer.from(script).toString('base64')).trim();
    if (!output) return [];
    return output.replace(/\r/g, '').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ── Quick status (single WSL call: version + runDir + tutDir + env snippet + cases) ──
export function getQuickStatus(): {
  version: string;
  runDir: string;
  tutorialDir: string;
  envSnippet: string;
  cases: { name: string; dirs: string[]; fileCount: Record<string, number>; timeStepCount: number; lastTimeStep: string; hasLog: boolean; logFiles: string[] }[];
} {
  try {
    if (cachedFoamEnv && cachedVersion && cachedVersion !== 'Unknown' && cachedRunDir) {
      const envSnippet = Object.entries(cachedFoamEnv)
        .filter(([k]) => k.toUpperCase().includes('FOAM') || k.startsWith('WM_'))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      const cases = listCasesBatch();
      return {
        version: cachedVersion,
        runDir: cachedRunDir,
        tutorialDir: cachedTutDir || '',
        envSnippet,
        cases,
      };
    }

    const src = foamSource();
    const script = `${src}echo "VER:$WM_PROJECT_VERSION"
${src}echo "RUN:$FOAM_RUN"
${src}echo "TUT:$FOAM_TUTORIALS"
${src}env | grep -E '^(WM_|FOAM_)' | head -15
echo CASES_MARKER`;

    const raw = runInWsl(script, 60000).split('CASES_MARKER')[0] || '';
    const lines = raw.split('\n');
    const get = (prefix: string) => {
      const l = lines.find(x => x.startsWith(prefix));
      return l ? l.substring(prefix.length).trim() : '';
    };

    const version = get('VER:') || 'Unknown';
    let runDir = get('RUN:');
    const tutDir = get('TUT:');
    const envSnippet = lines.filter(l => /^(WM_|FOAM_)/.test(l)).join('\n');

    if (runDir && runDir.startsWith('/')) {
      cachedRunDir = runDir;
      runDirVerified = true;
    } else {
      runDir = getRunDirectory();
    }
    if (tutDir) { cachedTutDir = tutDir; tutDirVerified = true; }
    if (version && version !== 'Unknown') cachedVersion = version;
    persistCache();

    const cases = listCasesBatch();
    return { version, runDir, tutorialDir: tutDir, envSnippet, cases };
  } catch {
    return { version: 'N/A', runDir: 'N/A', tutorialDir: 'N/A', envSnippet: '', cases: [] };
  }
}

// ── Full status: WSL check + OpenFOAM info ──
export function getFullStatus(): {
  wsl: { running: boolean; name: string; error?: string };
  openfoam: { found: boolean; version?: string; runDir?: string; cases?: string[] };
} {
  const wsl = wslCheck();
  const openfoam: { found: boolean; version?: string; runDir?: string; cases?: string[] } = { found: false };
  try {
    openfoam.found = true;
    openfoam.version = getOpenFOAMVersion();
    openfoam.runDir = getRunDirectory();
    openfoam.cases = listCases();
  } catch { /* */ }
  return { wsl, openfoam };
}

// ── checkMesh ──
export interface CheckMeshResult {
  success: boolean;
  raw: string;
  overallStats: { key: string; value: string }[];
  failedChecks: { severity: 'fail' | 'warning'; message: string }[];
  meshOk: boolean;
}

export function runCheckMesh(caseName: string): CheckMeshResult {
  const casePath = getCasePath(caseName);
  try {
    const raw = foamExec('checkMesh 2>&1', casePath, 60000);
    const lines = raw.split('\n');

    const overallStats: { key: string; value: string }[] = [];
    const failedChecks: { severity: 'fail' | 'warning'; message: string }[] = [];
    let meshOk = false;

    for (const line of lines) {
      if (line.match(/^<<Writing/)) continue;
      const statMatch = line.match(/^Overall\s+(.+?)\s*=\s*(.+)/);
      if (statMatch) {
        overallStats.push({ key: statMatch[1].trim(), value: statMatch[2].trim() });
      }
      const failMatch = line.match(/^\*\*\*\*(.+)/);
      if (failMatch) {
        failedChecks.push({ severity: 'fail', message: failMatch[1].trim() });
      }
      const warnMatch = line.match(/^-->(.+)/);
      if (warnMatch) {
        failedChecks.push({ severity: 'warning', message: warnMatch[1].trim() });
      }
    }

    const okLine = lines.find(l => l.includes('Mesh OK') || l.includes('Failed'));
    if (okLine) {
      meshOk = okLine.includes('Mesh OK');
    } else {
      meshOk = failedChecks.filter(c => c.severity === 'fail').length === 0;
    }

    return { success: true, raw, overallStats, failedChecks, meshOk };
  } catch (e: any) {
    return { success: false, raw: e.message, overallStats: [], failedChecks: [], meshOk: false };
  }
}

// ── Reset all caches (called when the distro changes or on manual refresh) ──
export function resetCache() {
  cachedBashrc = null;
  cachedRunDir = null;
  cachedTutDir = null;
  cachedFoamEnv = null;
  cachedVersion = null;
  runDirVerified = false;
  tutDirVerified = false;
  try { fs.unlinkSync(DISK_CACHE_PATH); } catch { /* best effort */ }
}

// ── Expose cache status for diagnostics ──
export function getCacheStatus(): { runDirVerified: boolean; tutDirVerified: boolean; runDir: string | null; tutDir: string | null } {
  return {
    runDirVerified,
    tutDirVerified,
    runDir: cachedRunDir,
    tutDir: cachedTutDir,
  };
}
