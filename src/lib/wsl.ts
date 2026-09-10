import { execSync, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';
import { buildInstallationId } from './foam-installation';
import {
  boundedInteger,
  isPhysicalFieldFile,
  shellQuote,
  WslInputError,
  validateCaseName,
  validateLogName,
  validatePathWithin,
  validatePid,
  validateRelativePath,
} from './wsl-input';
import {
  POST_PROCESSING_DIR,
  isTabularOutput,
  parseFunctionTemplate,
  resolveTemplateExtras,
  optionalTemplateEntries,
  tutorialExamplesFor,
  parseClassDocumentation,
  type FunctionArg,
  type FunctionDefault,
  type ClassDocumentation,
  type CaseContext,
} from './postprocess';
import { parseCheckMeshOutput } from './check-mesh';

// ─────────────────────────────────────────────────────────────────────────────
// EVERY child_process call in this file MUST pass `windowsHide: true`.
//
// `wsl.exe` is a console-subsystem program. Under Electron the Next.js server
// runs as a detached node.exe that main.js spawned with `windowsHide: true`,
// so that process owns no console. Windows therefore allocates a BRAND NEW
// console window for each console child it starts — unless the child is
// created with CREATE_NO_WINDOW, which is exactly what `windowsHide: true`
// sets.
//
// That console window appears for a few milliseconds and takes the foreground.
// It is barely visible, but it steals native focus from the app window, and
// Chromium is left with stale input routing: the window still looks focused,
// yet keystrokes no longer reach the focused <input>. The only way out is a
// real window focus event — which is why clicking on another app and back
// "unfreezes" typing (that path hits the refocus handlers in electron/main.js).
//
// It shows up right after pressing a command button because the UI refreshes
// case/status/process data immediately afterwards, firing several synchronous
// WSL calls in a row.
//
// This is invisible when the server runs from a terminal (`npm run dev`,
// `npm start`): there the children inherit the existing console and no new
// window is ever created. It only bites in the packaged app — so never drop
// these flags just because the dev build looks fine.
// ─────────────────────────────────────────────────────────────────────────────

// ── Distro selection (cached) ──
// Auto-detects an Ubuntu-like distro from `wsl --list -q`, skipping docker-desktop.
let distroName: string | null = null;
/** Set when `wsl --list` fails, so the 15 s probe is not repeated per call. */
let distroFailedAt = 0;
const DISTRO_RETRY_MS = 5000;

function stripDefaultMarker(s: string): string {
  return s.replace(/^\*+\s*/, '');
}

function getDistro(): string {
  if (distroName) return distroName;
  if (distroFailedAt && Date.now() - distroFailedAt < DISTRO_RETRY_MS) return 'Ubuntu-22.04';
  try {
    // execFileSync, not execSync: no shell in the middle. And a TIMEOUT, because
    // `wsl.exe` blocks while the WSL VM starts — after a resume from hibernate
    // that can be tens of seconds, and without a bound this synchronous call
    // holds the server's only thread for as long as it takes, so every request
    // the page makes during startup queues behind it.
    const raw = execFileSync('wsl', ['--list', '-q'], { timeout: 15000, windowsHide: true });
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
    // Return the guess WITHOUT caching it. This used to assign distroName, so a
    // single failed probe — the app launched while WSL was still starting, which
    // is the normal case on a cold boot — pinned the app to "Ubuntu-22.04" for
    // the whole life of the server process. On a machine whose distro is called
    // anything else, every WSL call then failed for ever, and the only cure was
    // restarting the app. Leaving it null means the next call asks again —
    // but not on EVERY call: getDistro() is on the path of every single WSL
    // invocation, and the probe above has a 15 s timeout, so an unresponsive
    // `wsl.exe` would otherwise add that timeout to every request in turn.
    // Remembering the failure for a few seconds keeps a burst to one probe
    // while still letting the app recover once WSL is up.
    distroFailedAt = Date.now();
    return 'Ubuntu-22.04';
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
      windowsHide: true,
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
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
    });
  } catch (e: any) {
    throw new Error((e.stderr || e.message || 'WSL command failed').trim());
  }
}

// Variant: runInWsl with a base64-encoded bash script (avoids quoting issues)
// Exported for src/lib/foam-index.ts, which builds its whole index in one call.
export function runInWslScript(b64: string, timeout = 30000): string {
  const distro = getDistro();
  const wrappedCmd = `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; echo "${b64}" | base64 -d | bash`;
  try {
    return execFileSync('wsl', ['-d', distro, '--', 'bash', '-c', wrappedCmd], {
      encoding: 'utf-8', timeout, maxBuffer: 0x3200000,
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
    });
  } catch (e: any) {
    throw new Error((e.stderr || e.message || 'WSL command failed').trim());
  }
}

/**
 * Same as runInWslScript, but without blocking the event loop.
 *
 * Everything else in this file is synchronous, which is fine for the sub-second
 * calls the UI makes one at a time. The OpenFOAM index build is different: it
 * runs foamToC plus 151 `-help` invocations and takes about eight seconds, and
 * execFileSync would freeze every other request in the server for that whole
 * time — including the ones the page makes while the user waits.
 */
export function runInWslScriptAsync(b64: string, timeout = 120000): Promise<string> {
  const distro = getDistro();
  const wrappedCmd = `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; echo "${b64}" | base64 -d | bash`;
  return new Promise((resolve, reject) => {
    // windowsHide is mandatory here like everywhere else in this file — see the
    // banner at the top: a console child steals focus in the packaged app.
    const child = spawn('wsl', ['-d', distro, '--', 'bash', '-c', wrappedCmd], {
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error(`WSL script timed out after ${timeout} ms`));
    }, timeout);

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A non-zero exit still carries useful stdout for scripts that report
      // their own errors, so only reject when there is nothing to work with.
      if (code !== 0 && !stdout) reject(new Error((stderr || `WSL exited with ${code}`).trim()));
      else resolve(stdout);
    });
  });
}

// ── Caches (in-memory + persistent disk) ──
let cachedBashrc: string | null = null;
let cachedInstallationIdentity: OpenFOAMInstallationIdentity | null = null;
let cachedRunDir: string | null = null;
let cachedTutDir: string | null = null;
let cachedFoamEnv: Record<string, string> | null = null;
let cachedVersion: string | null = null;
/** The bashrc the USER picked (see setOpenFOAMVersion); restored from disk. */
let selectedBashrc: string | null = null;

// ── Persistent disk cache ──
// Saves resolved values to ~/.wslgui-cache.json so server restarts don't
// re-discover everything from scratch. The file is OUTSIDE the project/standalone
// directory — it lives in the user's home and is never included in any ZIP.
const DISK_CACHE_PATH = path.join(os.homedir(), '.wslgui-cache.json');

interface DiskCache {
  distro?: string;
  bashrc?: string;
  /**
   * The version the user PICKED in the settings, as opposed to the one we
   * detected. Persisted so that an explicit choice survives a restart: without
   * it, auto-detection quietly moved the user to the newest install (and to a
   * different run directory, so their case list changed).
   */
  selected?: string;
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
  if (disk.selected && disk.selected.startsWith('/')) selectedBashrc = disk.selected;
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
      // KEEP the cached paths. An exception here means the validation could not
      // be RUN — WSL still waking up, the distro busy, the call timing out —
      // not that the paths are gone. Discarding them made a cold start silently
      // re-detect and switch OpenFOAM version, so the user's case list changed
      // under them and their cases appeared to vanish. A wrong path costs one
      // failed command; a wrong version costs trust.
      console.log('[wsl.ts] Disk cache: WSL unreachable during validation, keeping cached paths');
    }
  }
})();

function persistCache(): void {
  saveDiskCache({
    distro: getDistro(),
    bashrc: cachedBashrc || undefined,
    selected: selectedBashrc || undefined,
    runDir: cachedRunDir || undefined,
    tutDir: cachedTutDir || undefined,
    foamEnv: cachedFoamEnv || undefined,
    version: cachedVersion || undefined,
  });
}

// ── Find the OpenFOAM bashrc file ──
// If the user has selected a specific version (via setOpenFOAMVersion), uses
// that bashrc. Otherwise searches common install paths for the first one found.
/**
 * How long a FAILED detection is remembered.
 *
 * Caching a failure for ever is the bug that was just removed — one probe while
 * WSL was still starting decided permanently that the machine had no OpenFOAM.
 * But not remembering it at all is its own problem: `foamSource()` is on the path
 * of nearly every operation, so with WSL unreachable each request would re-run
 * the whole detection (several `wsl.exe` invocations, each synchronous and each
 * blocking the server's only thread) instead of answering from one cached result.
 *
 * A few seconds is the middle ground: a burst of calls serving one page load
 * probes once, and a user who starts WSL and clicks Retry is not made to wait for
 * a stale "no".
 */
const NEGATIVE_CACHE_MS = 5000;
let bashrcFailedAt = 0;
let foamEnvFailedAt = 0;

/** Reset by resetCache() so an explicit refresh is never answered from a failure. */
export function clearNegativeCaches(): void {
  bashrcFailedAt = 0;
  distroFailedAt = 0;
  foamEnvFailedAt = 0;
}

export function findBashrc(): string {
  if (cachedBashrc !== null) return cachedBashrc;
  if (bashrcFailedAt && Date.now() - bashrcFailedAt < NEGATIVE_CACHE_MS) return '';

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

  // A FAILURE is not cached, and this is the same lesson findClaude learned:
  // storing the empty string here (and persisting it) meant that one probe run
  // while WSL was still coming up decided, permanently, that this machine has no
  // OpenFOAM. Every later call short-circuited on the cached '' — foamSource()
  // returned no prefix, so every command ran without the OpenFOAM environment
  // and failed with "blockMesh: command not found", and nothing short of
  // restarting the app could shift it. A wrong "yes" is impossible here; a wrong
  // "no" was permanent. Leaving cachedBashrc null costs one retry per call until
  // WSL answers, and then it caches the real answer — bounded by
  // NEGATIVE_CACHE_MS so an unreachable WSL is not re-probed on every call.
  bashrcFailedAt = Date.now();
  return '';
}

// ── Detect ALL installed OpenFOAM versions ──
// Scans /opt, /usr/lib, /usr/local for every etc/bashrc belonging to an
// OpenFOAM install. Returns { version, bashrcPath, installDir }[] so the
// dashboard can show version buttons and let the user pick which one to use.
let cachedFoamVersions: { version: string; bashrcPath: string; installDir: string }[] | null = null;
let foamVersionsFailedAt = 0;

export function findOpenFOAMVersions(refresh = false): { version: string; bashrcPath: string; installDir: string }[] {
  const previous = cachedFoamVersions;
  if (refresh) foamVersionsFailedAt = 0;
  if (!refresh && cachedFoamVersions !== null) return cachedFoamVersions;
  // An empty result can mean "nothing is installed", but it can equally mean
  // WSL was restarting or briefly busy. Never turn that transient state into a
  // session-long empty version picker; retain it only long enough to stop a
  // burst of UI requests from repeating the same scan.
  if (foamVersionsFailedAt && Date.now() - foamVersionsFailedAt < NEGATIVE_CACHE_MS) return [];
  const script = `#!/bin/bash
# Shell globs visit only the shallow directory levels where an OpenFOAM
# installation can contain etc/bashrc. The old recursive find over all of
# /usr/lib walked thousands of unrelated packages and made this small picker
# take several seconds. Names and versions remain unrestricted; /usr/lib is
# narrowed only to its documented OpenFOAM branches.
shopt -s nullglob
candidates=(
  /opt/*/etc/bashrc /opt/*/*/etc/bashrc /opt/*/*/*/etc/bashrc
  /usr/local/*/etc/bashrc /usr/local/*/*/etc/bashrc /usr/local/*/*/*/etc/bashrc
  /usr/lib/openfoam*/etc/bashrc /usr/lib/openfoam*/*/etc/bashrc /usr/lib/openfoam*/*/*/etc/bashrc
  /usr/lib/OpenFOAM*/etc/bashrc /usr/lib/OpenFOAM*/*/etc/bashrc /usr/lib/OpenFOAM*/*/*/etc/bashrc
)
for f in "\${candidates[@]}"; do
  [ -f "$f" ] || continue
  grep -q "WM_PROJECT_DIR" "$f" 2>/dev/null || continue
  installDir=\${f%/etc/bashrc}
  leaf=\${installDir##*/}
  case "$leaf" in
    OpenFOAM-v*) ver=\${leaf#OpenFOAM-v} ;;
    OpenFOAM-*) ver=\${leaf#OpenFOAM-} ;;
    openfoam*) ver=\${leaf#openfoam} ;;
    v[0-9]*) ver=\${leaf#v} ;;
    *) ver="$leaf" ;;
  esac
  echo "$ver|$f|$installDir"
done | sort -u
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 15000).trim();
    if (!out) {
      cachedFoamVersions = null;
      foamVersionsFailedAt = Date.now();
      return [];
    }
    const versions: { version: string; bashrcPath: string; installDir: string }[] = [];
    for (const line of out.split('\n')) {
      const parts = line.split('|');
      if (parts.length >= 3 && parts[1].startsWith('/')) {
        versions.push({ version: parts[0], bashrcPath: parts[1], installDir: parts[2] });
      }
    }
    if (versions.length === 0) {
      foamVersionsFailedAt = Date.now();
      return [];
    }
    foamVersionsFailedAt = 0;
    cachedFoamVersions = versions;
    return versions;
  } catch {
    // Keep the last proven list when WSL itself fails. This is the recovery
    // path for resume/restart glitches: a failed refresh may report the known
    // versions, but it must not make them disappear or poison later selection.
    foamVersionsFailedAt = Date.now();
    return previous || [];
  }
}

// ── Select which OpenFOAM version to use ──
// Sets the active bashrc path. All subsequent calls (foamSource, getFoamEnv,
// getRunDirectory, getTutorialDirectory, getOpenFOAMVersion) will use this
// bashrc. Resets ALL caches so the new environment is picked up immediately.
// (Declared next to the other cache variables at the top of the file, because
// the disk-cache loader restores it.)

export function setOpenFOAMVersion(bashrcPath: string): boolean {
  if (!bashrcPath || !bashrcPath.startsWith('/') || bashrcPath.includes('..')) return false;

  // The chosen file is SOURCED into every WSL call this app makes from here on
  // (foamSource, just below), so choosing it is choosing what runs — and the
  // shape checks above accept any absolute path at all. `/api/wsl` reaches this
  // over a plain GET, which made it the one endpoint where a request could
  // install arbitrary code into the app's whole subsequent session.
  //
  // The only legitimate values are the ones the detector itself produced, so
  // that is now the whole rule: it must be one of them. This is not a
  // normalisation the caller can talk its way around — it is an identity test
  // against a list this app built by looking at the disk.
  const known = findOpenFOAMVersions();
  if (!known.some(v => v.bashrcPath === bashrcPath)) return false;

  selectedBashrc = bashrcPath;
  // An explicit choice must be acted on NOW. Clearing only the positive caches
  // left a recent failure remembered, so findBashrc() would answer '' from the
  // negative-cache window and the version the user had just picked was ignored
  // for the next few seconds — long enough to look like the setting had not
  // taken.
  clearNegativeCaches();
  // Reset ALL caches — the new bashrc sources a completely different environment.
  cachedBashrc = null;
  cachedFoamEnv = null;
  cachedVersion = null;
  cachedInstallationIdentity = null;
  cachedRunDir = null;
  cachedTutDir = null;
  // Both of these are keyed by the installation and would miss on their own,
  // but "reset ALL caches" should mean all of them: a key that happens to be
  // right is a weaker guarantee than not keeping the answer at all.
  cachedCatalog = null;
  cachedUtility = null;
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
  if (foamEnvFailedAt && Date.now() - foamEnvFailedAt < NEGATIVE_CACHE_MS) return {};

  // Without a bashrc there is no OpenFOAM environment to read, and running the
  // probe anyway is how a TEMPORARY failure became a PERMANENT one: on a cold
  // boot, findBashrc() fails while WSL is still starting, and moments later —
  // still inside its negative-cache window, so foamSource() is empty without
  // re-probing — WSL comes up and this probe SUCCEEDS. It then stored a shell
  // environment with no OpenFOAM in it into `cachedFoamEnv`, which has no
  // expiry and is persisted to ~/.wslgui-cache.json, and `cachedVersion` became
  // the sticky string 'Unknown'. The version, the env panel and the
  // applications browser stayed empty for the rest of the process, and survived
  // a restart. Returning early keeps the two caches consistent: no bashrc, no
  // environment, nothing remembered.
  if (!foamSource()) return {};

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
      // Not cached, for the same reason as findBashrc above: an empty
      // environment remembered from one unreachable-WSL moment is indis-
      // tinguishable from "this installation exports nothing", and it never
      // retried. Return the empty map, keep cachedFoamEnv null — but remember
      // the failure briefly, so an unreachable WSL is not re-probed per call.
      foamEnvFailedAt = Date.now();
      return {};
    }
  }
}

// ── Run a command with OpenFOAM env loaded, optionally in a workDir ──
function foamExec(cmd: string, workDir?: string, timeout = 30000): string {
  const src = foamSource();
  // `cd … || exit 1;` and NOT `cd … && `. What follows is `foamSource()` — which
  // ends in a `;` — so `cd X && source …; cmd` groups as `(cd && source); cmd`,
  // and bash happily runs `cmd` after a FAILED cd, in whatever directory the
  // shell started in. A missing or renamed workDir therefore ran the command
  // somewhere else instead of failing. `|| exit 1` binds to the cd alone.
  const cd = workDir ? `cd ${shellQuote(workDir)} || exit 1; ` : '';
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
    const raw = execSync('wsl --list -q', { windowsHide: true });
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
    // A bashrc path the user picked inside the OLD distro names a file that
    // need not exist in the new one, and keeping it made every command source
    // nothing. The choice is meaningful per distro, so it goes with the distro.
    selectedBashrc = null;
    resetCache();
  }
  return selected;
}

// ── Public: get OpenFOAM version (cached) ──
export function getOpenFOAMVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const env = getFoamEnv();
    // 'Unknown' is NOT cached. `cachedVersion` is guarded by a plain
    // `if (cachedVersion) return`, so storing the failure made it permanent —
    // one probe taken while WSL was still starting left the app reporting
    // "Unknown" for the rest of the process, with no way to re-detect.
    if (!env.WM_PROJECT_VERSION) return 'Unknown';
    cachedVersion = env.WM_PROJECT_VERSION;
    return cachedVersion;
  } catch {
    return 'Unknown';
  }
}

/**
 * Stable identity of the OpenFOAM installation selected in the Dashboard.
 *
 * A bashrc path is not an identity by itself: two WSL distros can both contain
 * `/opt/openfoam14/etc/bashrc`, and an installation can be upgraded in place.
 * The knowledge caches use this value, so include the distro, the resolved
 * environment paths and a small metadata fingerprint of the installed binaries.
 * It is computed once per selection and reset together with the WSL caches.
 */
export interface OpenFOAMInstallationIdentity {
  id: string;
  baseId: string;
  distro: string;
  bashrc: string;
  version: string;
  projectDir: string;
  tutorials: string;
  applicationBin: string;
  fingerprint: string;
  fingerprintAvailable: boolean;
}

export function getOpenFOAMInstallationIdentity(): OpenFOAMInstallationIdentity {
  if (cachedInstallationIdentity) return cachedInstallationIdentity;

  const env = getFoamEnv();
  const distro = getDistro();
  const bashrc = findBashrc();
  const version = env.WM_PROJECT_VERSION || getOpenFOAMVersion();
  const projectDir = env.WM_PROJECT_DIR || '';
  const tutorials = env.FOAM_TUTORIALS || getTutorialDirectory();
  const applicationBin = env.FOAM_APPBIN || '';
  const tracked = [bashrc, projectDir, tutorials, applicationBin, env.FOAM_SRC || '', env.FOAM_APP || '']
    .filter(p => p.startsWith('/'));

  let metadata = '';
  let fingerprintAvailable = true;
  try {
    const quoted = tracked.map(shellQuote).join(' ');
    const script = `#!/bin/bash
${foamSource()}
cd /tmp || cd /
for p in ${quoted}; do
  [ -e "$p" ] && stat -c '%n|%Y|%s' "$p" 2>/dev/null
done
for d in ${shellQuote(applicationBin)} ${shellQuote(projectDir ? `${projectDir}/bin` : '')}; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 1 -type f -printf '%f|%s|%T@\n' 2>/dev/null | sort | cksum
done
`;
    metadata = runInWslScript(Buffer.from(script).toString('base64'), 30000).trim();
  } catch {
    // The paths and distro still distinguish normal version switches. A later
    // explicit refresh resets this value and gets another chance to fingerprint.
    metadata = 'metadata-unavailable';
    fingerprintAvailable = false;
  }

  const hashes = buildInstallationId({
    distro, bashrc, version, projectDir, tutorials, applicationBin, metadata,
  });
  const identity: OpenFOAMInstallationIdentity = {
    id: hashes.id,
    baseId: hashes.baseId,
    distro,
    bashrc,
    version,
    projectDir,
    tutorials,
    applicationBin,
    fingerprint: hashes.fingerprint,
    fingerprintAvailable,
  };
  // Do not freeze an incomplete fingerprint for the whole process. WSL may
  // simply have been waking up; the next request should be able to verify it.
  if (fingerprintAvailable) cachedInstallationIdentity = identity;
  return identity;
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
/** Per-file slice sent to the copilot. Anything longer is cut and MARKED. */
export const CASE_CONTEXT_FILE_LIMIT = 32_000;

/**
 * Cheap content-state marker for the dictionaries FOAMy can see.
 *
 * It hashes full path, size and nanosecond mtime rather than reading every
 * file. FOAMy checks it before a turn and reloads the bounded case context only
 * when something changed, including writes made by an agent, script or terminal.
 */
export function getCaseFilesFingerprint(caseName: string): string {
  const casePath = getCasePath(validateCaseName(caseName));
  const script = `#!/bin/bash
CASE=${shellQuote(casePath)}
[ -d "$CASE" ] || { echo NOEXIST; exit 0; }
find "$CASE/0" "$CASE/system" "$CASE/constant" \
  -path '*/polyMesh/*' -prune -o \
  -type f -printf '%p|%s|%T@\n' 2>/dev/null | sort | sha256sum | cut -d' ' -f1
`;
  return runInWslScript(Buffer.from(script).toString('base64'), 30000).trim();
}

export interface CaseFileSlice {
  path: string;
  content: string;
  /** Size of the file on disk, which may be larger than `content`. */
  bytes: number;
  /** True when `content` is only the first CASE_CONTEXT_FILE_LIMIT bytes. */
  truncated: boolean;
}

/**
 * Read a case's dictionaries for the copilot.
 *
 * Every slice carries its real size and whether it was cut, because FOAMy
 * answers with WHOLE files: if it is shown the first 8 KB of a 20 KB
 * blockMeshDict and cannot tell, it will happily "rewrite" the file and delete
 * the part it never saw. The caller marks truncated files in the prompt and the
 * system prompt forbids rewriting them.
 */
export function readCaseFilesDeep(caseName: string): CaseFileSlice[] {
  const casePath = getCasePath(caseName);
  const script = `#!/bin/bash
CASE=${shellQuote(casePath)}
[ -d "$CASE" ] || { echo "NOEXIST"; exit 0; }
# All files under 0/, system/, constant/ — EXCLUDING constant/polyMesh/.
# Outputs FULL paths plus the file size; the JS side strips the CASE/ prefix
# (avoids bash \${f#...} which conflicts with JS template-literal interpolation).
find "$CASE/0" "$CASE/system" "$CASE/constant" \
  -path '*/polyMesh/*' -prune -o \
  -type f -print 2>/dev/null | while IFS= read -r f; do
  # Skip binaries
  ft=$(file -b "$f" 2>/dev/null | head -c 40)
  case "$ft" in
    *ELF*|*executable*|*data*|*compressed*) continue ;;
  esac
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
  printf '===FILE===%s|%s\\n' "$f" "$sz"
  head -c ${CASE_CONTEXT_FILE_LIMIT} "$f" 2>/dev/null
  printf '\\n===END===\\n'
done
`;
  try {
    const out = runInWslScript(Buffer.from(script).toString('base64'), 30000);
    if (out.startsWith('NOEXIST')) return [];
    const files: CaseFileSlice[] = [];
    const blocks = out.split('===FILE===');
    const prefix = casePath + '/';
    for (const block of blocks.slice(1)) {
      const endIdx = block.indexOf('===END===');
      if (endIdx < 0) continue;
      const nl = block.indexOf('\n');
      if (nl < 0) continue;
      const headerLine = block.substring(0, nl).trim();
      const sep = headerLine.lastIndexOf('|');
      const fullPath = sep >= 0 ? headerLine.substring(0, sep) : headerLine;
      const bytes = sep >= 0 ? Number(headerLine.substring(sep + 1)) || 0 : 0;
      const path = fullPath.startsWith(prefix) ? fullPath.substring(prefix.length) : fullPath;
      const content = block.substring(nl + 1, endIdx).replace(/\n$/, '');
      if (path) {
        files.push({
          path,
          content,
          bytes,
          truncated: bytes > CASE_CONTEXT_FILE_LIMIT,
        });
      }
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

/**
 * Make a case folder with empty 0/, system/ and constant/.
 *
 * An existing name is refused unless `allowExisting` says the caller already
 * asked the user (the wizard's "Overwrite"): `mkdir -p` alone reported
 * "created" for a case that was already there, possibly full of results. The
 * run directory itself may still be missing on a fresh install, hence `-p` on
 * the parent only.
 */
export function createCase(caseName: string, options: { allowExisting?: boolean } = {}): string {
  const safeName = validateCaseName(caseName);
  const casePath = getCasePath(safeName);
  const refuseExisting = options.allowExisting
    ? ''
    : `{ test ! -e ${shellQuote(casePath)} || { echo "A case called ${safeName} already exists" >&2; exit 1; }; mkdir -- ${shellQuote(casePath)}; } && `;
  try {
    runInWsl(
      `mkdir -p -- ${shellQuote(path.posix.dirname(casePath))} && ${refuseExisting}` +
      `mkdir -p -- ${shellQuote(`${casePath}/0`)} ${shellQuote(`${casePath}/system`)} ${shellQuote(`${casePath}/constant`)} && echo "OK"`,
    );
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

// ── Tutorials inside a category, at any depth ──
//
// A category's first level is not always its tutorials. `mesh/`, `multiRegion/`
// and `legacy/` group them one or two folders deeper (`mesh/snappyHexMesh/
// flange`), and on v9-v10 the whole tree is grouped by solver
// (`incompressible/simpleFoam/pitzDaily`). Listing only the first level offered
// those group folders as tutorials, and copying one produced a "case" with no
// system/ that nothing could run.
//
// So: a folder with system/ is a tutorial, and is not descended into. A folder
// with its own Allrun but no system/ is a wrapper whose Allrun drives the cases
// under it (hopperParticles, wingMotion) — listed as well, since those cases
// often depend on each other, but only if a real case sits below it. Anything
// else is only walked through. `"$1"/*/` also follows directory links.
export function listTutorialCases(categoryPath: string): { name: string; fullPath: string; wrapper?: boolean }[] {
  const category = validatePathWithin(getTutorialDirectory(), categoryPath, 'Tutorial category').replace(/\/+$/, '');
  const script = `
walk() {
  local d
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    d=\${d%/}
    if [ -d "$d/system" ]; then printf 'C\\t%s\\n' "$d"; continue; fi
    [ -f "$d/Allrun" ] && printf 'W\\t%s\\n' "$d"
    [ "$2" -lt 4 ] && walk "$d" $(( $2 + 1 ))
  done
}
walk ${shellQuote(category)} 1
exit 0
`;
  // No catch: a failed listing is an error the Dashboard shows, not an empty
  // category.
  const entries = runInWslScript(Buffer.from(script).toString('base64'), 30000)
    .split('\n')
    .map(line => line.replace(/\r$/, '').split('\t'))
    .filter(([kind, p]) => (kind === 'C' || kind === 'W') && !!p && p.startsWith(`${category}/`));
  const cases = entries.filter(([kind]) => kind === 'C').map(([, p]) => p);
  return entries
    .filter(([kind, p]) => kind === 'C' || cases.some(c => c.startsWith(`${p}/`)))
    .map(([kind, p]) => ({
      name: p.slice(category.length + 1),
      fullPath: p,
      ...(kind === 'W' ? { wrapper: true } : {}),
    }));
}

export function copyTutorial(tutorialPath: string, newCaseName: string): string {
  const runDir = getRunDirectory();
  const sourcePath = validatePathWithin(getTutorialDirectory(), tutorialPath, 'Tutorial path');
  const safeName = validateCaseName(newCaseName);
  const destinationPath = `${runDir}/${safeName}`;
  try {
    // `mkdir` is the existence check that counts: it fails atomically if the
    // name exists. `test` alone left a gap — two quick copies (Enter pressed
    // twice) could both pass it, and the second `cp -r` into the directory the
    // first had just made nested the tutorial inside the new case. `test` stays
    // only for its clearer message. Copying `src/.` into the directory made
    // here gives the same layout, and a copy that fails halfway removes only
    // what this call created.
    runInWsl(
      `test ! -e ${shellQuote(destinationPath)} || { echo "Case already exists" >&2; exit 1; }; ` +
      `mkdir -- ${shellQuote(destinationPath)} || exit 1; ` +
      `cp -r -- ${shellQuote(`${sourcePath}/.`)} ${shellQuote(destinationPath)} || { rm -rf -- ${shellQuote(destinationPath)}; exit 1; }; ` +
      `echo "OK"`,
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
  // Validation stays OUTSIDE the try: wrapping it meant a rejected path was
  // rethrown as a plain Error, which apiError() cannot recognise as a
  // WslInputError — so bad input came back as HTTP 500 "Internal error"
  // instead of 400, and a caller could not tell the two apart.
  const safePath = validateRelativePath(filePath, 'File path');
  try {
    return runInWsl(`cat -- ${shellQuote(`${getCasePath(caseName)}/${safePath}`)}`, 10000);
  } catch (e: any) {
    throw new Error(`Unable to read ${filePath}: ${e.message}`);
  }
}

/**
 * A cheap fingerprint of one file, for noticing that something else changed it.
 *
 * The editor cannot tell from its own state whether a file it is showing is
 * still what is on disk: an agent, FOAMy, an Allrun script or the user's own
 * terminal can all rewrite it. Asking the file itself is the only answer that
 * covers every writer, so this is deliberately source-agnostic.
 *
 * mtime and size alone are not quite enough. WSL reports whole-second mtimes
 * here (`stat -c '%.9Y'` returns `.000000000`), so two writes in the same second
 * that happen to produce the same length would look identical and the editor
 * would stay stale until the next change. A checksum closes that, and is only
 * taken for files small enough for it to be free — the case dictionaries people
 * actually edit. Above the threshold the fingerprint degrades to mtime+size,
 * which is the right trade for a 200 MB log nobody is hand-editing.
 */
export function statFile(caseName: string, filePath: string): {
  exists: boolean;
  mtime: number;
  size: number;
  stamp: string;
} {
  const casePath = getCasePath(caseName);
  const safePath = validateRelativePath(filePath, 'File path');
  const fullPath = `${casePath}/${safePath}`;
  const HASH_LIMIT = 2 * 1024 * 1024;
  const script = `
f=${shellQuote(fullPath)}
if [ ! -f "$f" ]; then echo "missing"; exit 0; fi
meta=$(stat -c '%Y %s' "$f" 2>/dev/null) || { echo "missing"; exit 0; }
size=\${meta##* }
sum=""
if [ "$size" -le ${HASH_LIMIT} ]; then sum=$(cksum < "$f" 2>/dev/null | tr -d ' '); fi
echo "ok $meta $sum"
`;
  try {
    const output = runInWslScript(Buffer.from(script).toString('base64'), 20000).trim();
    if (!output.startsWith('ok ')) return { exists: false, mtime: 0, size: 0, stamp: '' };
    const [, mtime, size, sum = ''] = output.split(/\s+/);
    return {
      exists: true,
      mtime: Number(mtime) || 0,
      size: Number(size) || 0,
      stamp: `${mtime}:${size}:${sum}`,
    };
  } catch {
    // Unreachable WSL must not read as "the file changed": an empty stamp is
    // ignored by the caller rather than triggering a reload of nothing.
    return { exists: false, mtime: 0, size: 0, stamp: '' };
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
    // Decode into a sibling temp file and rename over the target, rather than
    // redirecting straight onto it.
    //
    // `base64 -d > file` truncates `file` as the shell sets the redirect up —
    // BEFORE a single decoded byte exists. Anything that interrupts the run
    // between those two moments (WSL restarting, the 30 s timeout, a full disk,
    // the app being closed) leaves the user's controlDict or 0/U empty, and the
    // content it held is gone: this is the path the File Editor's Save, FOAMy's
    // apply buttons and the agent's write_case_file all take.
    //
    // rename(2) within one directory is atomic, so the file is either wholly the
    // old content or wholly the new one.
    //
    // NO SHELL VARIABLES HERE, and that is not a style choice. `wsl.exe`
    // substitutes `$NAME` in the command line it is GIVEN, before bash ever sees
    // it, so a script written as `T=…; … "$T"` arrives at bash with `$T` already
    // replaced by nothing — the redirect target is empty and the write fails.
    // (Verified: `wsl … bash -c 'X=hello; echo "[$X]"'` prints `[]`, while the
    // same string piped in as base64 prints `[hello]`. That is exactly why every
    // multi-line script in this file goes through runInWslScript.) The temp name
    // is therefore generated HERE, in JavaScript, and both paths are literals.
    const scratch = `${fullPath}.tmp.${randomBytes(6).toString('hex')}`;
    const quotedDst = shellQuote(fullPath);
    const quotedTmp = shellQuote(scratch);
    // Two things the plain redirect used to give us for free, and a rename does
    // not, so they are restored explicitly:
    //
    //   chmod --reference  The old form wrote THROUGH the existing inode and kept
    //                      its mode. A fresh temp file is 0644, so renaming it
    //                      over a 0755 script silently drops the executable bit —
    //                      and a tutorial's `Allrun` that calls `./Allmesh` then
    //                      dies with "Permission denied" on a file the user had
    //                      only edited. It fails harmlessly when the target does
    //                      not exist yet, which is why it is followed by `|| true`.
    //   mv -T              `mv f d` where d is a DIRECTORY means "move f into d".
    //                      Without -T, writing to "system" or "0" — a plausible
    //                      mistake for the agent to make, and one no validator
    //                      rejects — would quietly succeed, parking the content at
    //                      `system/system.tmp.xxxx` and reporting it as written.
    //                      -T (--no-target-directory) makes that an error instead.
    //
    // `A && { B; C; } || { cleanup; exit 1; }` — the cleanup runs if the decode
    // fails or the rename fails, so a failed save never leaves a scratch file
    // behind, and the non-zero exit is what makes runInWslWithInput throw.
    runInWslWithInput(
      `base64 -d > ${quotedTmp} && { chmod --reference=${quotedDst} ${quotedTmp} 2>/dev/null || true; ` +
        `mv -fT -- ${quotedTmp} ${quotedDst}; } || { rm -f -- ${quotedTmp}; exit 1; }`,
      b64,
      30000,
    );
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

/**
 * Rename (or move) a file or directory inside a case.
 *
 * Both paths go through validateRelativePath, so neither can escape the case.
 * The destination is refused if it already exists — `mv` would otherwise
 * overwrite a file, or quietly move the source INSIDE the destination when the
 * destination is a directory, which is not what "rename" means to anyone.
 * Parent directories of the destination are created, so this doubles as a move.
 */
export function renamePath(caseName: string, fromPath: string, toPath: string): string {
  const safeFrom = validateRelativePath(fromPath, 'Source path');
  const safeTo = validateRelativePath(toPath, 'Destination path');
  if (safeFrom === safeTo) return safeTo;

  const casePath = getCasePath(caseName);
  const src = `${casePath}/${safeFrom}`;
  const dst = `${casePath}/${safeTo}`;
  // Every branch exits 0 and reports through stdout on purpose: a non-zero exit
  // makes runInWslScript throw the raw `wsl … | base64 -d | bash` command line,
  // and that is what the user would see instead of "already exists: 0/p".
  const b64 = Buffer.from(`
SRC=${shellQuote(src)}
DST=${shellQuote(dst)}
if [ ! -e "$SRC" ]; then echo "ERROR: not found: ${safeFrom}"; exit 0; fi
if [ -e "$DST" ]; then echo "ERROR: already exists: ${safeTo}"; exit 0; fi
mkdir -p -- "$(dirname "$DST")" || { echo "ERROR: cannot create the destination folder"; exit 0; }
mv -- "$SRC" "$DST" && echo "OK" || echo "ERROR: could not move ${safeFrom}"
`).toString('base64');

  const result = runInWslScript(b64, 30000).trim();
  if (!result.startsWith('OK')) {
    throw new Error(result.replace(/^ERROR:\s*/, '') || 'Rename failed');
  }
  return safeTo;
}

// ── Delete all timestep dirs except 0 ──
export function deleteAllTimesteps(caseName: string): { deleted: string[]; count: number } {
  const casePath = getCasePath(caseName);
  // Three things this used to get wrong:
  //  - only a folder named exactly "0" was spared, so a case that starts
  //    elsewhere (kivaTest starts at -180 and has no 0/) lost its initial
  //    conditions. The earliest time is now spared as well as 0;
  //  - processor*/<time> folders were never touched, although the Monitor's
  //    count and message promise them;
  //  - any failure was swallowed and reported as "Deleted 0 timesteps".
  //    Errors go to stderr, which is what runInWslScript reports.
  const bashScript = `
CASEPATH=${shellQuote(casePath)}
cd "$CASEPATH" || { echo "the case folder was not found" >&2; exit 1; }
isnum() { printf '%s' "$1" | grep -qE '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'; }
count=0
deleted=""
clean() {
  local dir="$1" prefix="$2" first d bn
  first=$(for d in "$dir"/*/; do bn=$(basename "$d"); isnum "$bn" && printf '%s\\n' "$bn"; done | sort -g | head -n 1)
  for d in "$dir"/*/; do
    [ -d "$d" ] || continue
    bn=$(basename "$d")
    [ "$bn" = "0" ] && continue
    [ "$bn" = "$first" ] && continue
    isnum "$bn" || continue
    rm -rf -- "$dir/$bn" || { echo "could not delete $prefix$bn" >&2; exit 1; }
    deleted="$deleted $prefix$bn"
    count=$((count + 1))
  done
}
clean "$CASEPATH" ""
for p in "$CASEPATH"/processor*/; do
  [ -d "$p" ] && clean "\${p%/}" "$(basename "$p")/"
done
echo "DELETED:$count:$deleted"
`;
  let output: RegExpMatchArray | null;
  try {
    output = runInWslScript(Buffer.from(bashScript).toString('base64'), 120000)
      .trim()
      .match(/DELETED:(\d+):(.*)/);
  } catch (e: any) {
    throw new Error(`Could not delete the timesteps: ${e.message}`);
  }
  if (!output) throw new Error('Could not delete the timesteps: the script gave no result');
  return { count: parseInt(output[1]), deleted: output[2].trim().split(/\s+/).filter(Boolean) };
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
        // Declared out here because verifyPid, below, reports on it.
        let hasRedirect = false;

        if (isBackground) {
          const inner = trimmed.slice(0, -1).trimEnd(); // remove trailing &
          const scriptId = Math.random().toString(36).substring(2, 10);
          const tmpScript = `/tmp/wslgui_bg_${scriptId}.sh`;
          pidFile = `/tmp/wslgui_bg_${scriptId}.pid`;

          // A background command gets EXACTLY the redirection the user wrote,
          // and none if they wrote none.
          //
          // It used to invent ` > log.<command> 2>&1` whenever there was no
          // redirect, which meant `foamRun &` quietly created a file the user
          // had not asked for and did not know the name of. The user asked for
          // that to stop on 2026-09-03. The consequence is real and is reported
          // rather than hidden: with nothing capturing it, the output of a
          // detached process goes nowhere and cannot be recovered afterwards,
          // so the terminal says so when it starts one. The app's own
          // background launches (Allrun, the foamRun quick command) write their
          // redirect explicitly and are unaffected.
          hasRedirect = />|>>|&>|&>>/.test(inner);
          const outputRedirect = '';

          // The PID is written FIRST, before the ~2.6 s OpenFOAM bashrc source.
          // Sourcing it took longer than the launcher's poll window, so the pid
          // never appeared in time and a background command was reported as
          // failed to start. exec preserves the pid, so writing it up here keeps
          // it valid once the real command replaces this shell.
          const scriptContent = `#!/bin/bash
echo $$ > "${pidFile}"
${src}
cd ${shellQuote(casePath)} 2>/dev/null || exit 1
exec ${inner}${outputRedirect}
`;
          const workerB64 = Buffer.from(scriptContent).toString('base64');

          const launcherContent = `#!/bin/bash
# Delete this script now, while bash still holds an open descriptor on it.
# Unlinking an open file is safe on Linux — the inode outlives the name — and
# doing it FIRST means the scratch file is gone whatever happens below, including
# the failure paths. The caller cannot do it: it would have to run a command
# after this one, and the exit status of this launcher is what the caller
# reports to the user.
rm -f "/tmp/wslgui_launch_${scriptId}.sh" 2>/dev/null || true
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
# Both scratch files have done their job by here: the pid has been read, and the
# worker is already running with its own descriptor open on the script. Unlinking
# a file a running bash still holds open is safe on Linux — the inode outlives the
# name — so this is the last moment at which they can be removed at all, because
# the worker ends in exec and nothing of ours survives it to clean up after.
# Without this every background run left two files in /tmp for ever.
rm -f "${tmpScript}" "${pidFile}" 2>/dev/null || true
# And a swept net for the runs that never reached this line — a killed wsl.exe, a
# distro shut down mid-launch. Bounded, one directory deep, only our own names,
# and only once they are a day old so a live run is never touched.
find /tmp -maxdepth 1 -name 'wslgui_*' -mmin +1440 -delete 2>/dev/null || true
`;
          const launcherB64 = Buffer.from(launcherContent).toString('base64');

          // `;` rather than `&&`, and the launcher deletes ITSELF (see the first
          // line of launcherContent above) rather than being deleted by a
          // trailing command here.
          //
          // The obvious version — `bash LAUNCH; s=$?; rm LAUNCH; exit $s` —
          // cannot work on this path: `wsl.exe` substitutes `$NAME` in the
          // command line it is given before bash sees it, so `$?` and `$s` are
          // gone by the time bash parses the line. Only text that goes through
          // base64 (the launcher itself) may use shell variables.
          //
          // Leaving the deletion to the launcher gets both properties anyway:
          // the cleanup happens on every path, including failure — which the
          // original `&&` chain skipped, so the failure case was also the one
          // that leaked — and this command's exit status is simply the
          // launcher's, with nothing swallowing it. The old trailing `|| true`
          // reported a launcher that had exited 7 as a success.
          const launchScript = `/tmp/wslgui_launch_${scriptId}.sh`;
          fullCmd = `bash -c 'echo "${launcherB64}" | base64 -d > "${launchScript}"; bash "${launchScript}"'`;
        } else {
          fullCmd = `${src}${trimmed}`;
        }

        const distro = getDistro();
        const wslArgs = ['-d', distro, '--', 'bash', '-c',
          // `cd … || exit 1;` and NOT `cd … && `: fullCmd begins with foamSource(),
          // which ends in a `;`, so `cd X && source …; blockMesh` grouped as
          // `(cd && source); blockMesh` — and bash ran the user's command after a
          // FAILED cd, in whatever directory the shell started in. That is how a
          // command aimed at a case the user had just renamed ended up executing
          // against their WSL home instead; in unrestricted mode, where the command
          // may be an `rm`, it is the difference between an error and a loss.
          // The cd's own stderr is kept (no 2>/dev/null) because "no such directory"
          // is exactly what the user needs to be told here.
          `export COLUMNS=80 LINES=24 TERM=dumb 2>/dev/null; cd ${shellQuote(casePath)} || exit 1; ${fullCmd}`,
        ];
        const proc = spawn('wsl', wslArgs, {
          env: { ...process.env, TERM: 'dumb', COLUMNS: '80', LINES: '24' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let resolved = false;
        // Set from the launcher's one control line, and kept out of what the
        // user sees — see the stdout handler.
        let capturedBgPid: string | null = null;

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
          if (isBackground) {
            // A background launcher's ONLY stdout is the control line
            // "BG_PID=<pid>". Capture the pid and show the user none of it.
            const m = str.match(/BG_PID=(\d+)/);
            if (m) capturedBgPid = m[1];
            return;
          }
          appendOutput(str);
          onLog?.(str);
        });

        proc.stderr.on('data', (data: Buffer) => {
          const str = data.toString();
          appendOutput(str);
          onLog?.(str);
        });

        proc.on('close', (code) => {
          if (isBackground) {
            if (capturedBgPid) {
              finish(0, hasRedirect
                ? `Started in the background — PID ${capturedBgPid}. Follow it in the Monitor tab.`
                : `Started in the background — PID ${capturedBgPid}. Nothing is capturing its ` +
                  `output; add \` > log.<name> 2>&1\` before the & to keep it. Follow it in the Monitor tab.`);
            } else {
              finish(0,
                'Started in the background, but its PID could not be confirmed — WSL may still be ' +
                'starting up. Check the Monitor tab to see whether it is running.');
            }
            return;
          }
          finish(code || 0, output);
        });

        proc.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
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
grep -E "foamRun|decomposePar|reconstructPar|simpleFoam|icoFoam|pimpleFoam|snappyHexMesh|blockMesh|checkMesh|wslgui_bg_" |
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
  // Always `tail`, never `cat`.
  //
  // The old form switched to `cat` at safeTail >= 50000 — which is precisely
  // what the residual chart asks for on every refresh (monitor.tsx sends
  // maxLines=50000). On a solve that has been running for hours the log is
  // hundreds of MB, so each refresh read the WHOLE file, synchronously, blocking
  // every other request in the server; and once the file passed runInWsl's 50 MiB
  // maxBuffer, execFileSync threw and the catch below turned that into
  // "Log not found: …" — the chart stopped working and blamed a missing file.
  //
  // `tail -n N` returns exactly the same bytes as `cat` for any log with at most
  // N lines, and the correct last N for a longer one, so nothing is lost. The
  // trailing `tail -c` bounds the pathological case of 50000 very long lines,
  // keeping the result comfortably inside maxBuffer.
  const MAX_LOG_BYTES = 40 * 1024 * 1024;
  // The missing-file case is an explicit `test`, not a `|| echo` after the
  // pipeline: a pipeline's status is its LAST command's, and the trailing
  // `tail -c` succeeds even when the first tail found nothing to read — so the
  // fallback would never have fired, and a missing log would have come back as
  // an empty string instead of a message.
  const quotedLog = shellQuote(logPath);
  const cmd =
    `if [ -f ${quotedLog} ]; then tail -n ${safeTail} -- ${quotedLog} 2>/dev/null | tail -c ${MAX_LOG_BYTES};` +
    ` else echo ${shellQuote(`Log not found: ${safeLogName}`)}; fi`;
  try {
    return runInWsl(cmd, safeTail > 1000 ? 120000 : 30000);
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
  // Errors go to stderr: runInWslScript reports only that, so an "ERROR: …"
  // echoed to stdout used to reach the user as the raw wsl command line. The
  // folder is made with plain `mkdir` (atomic, fails if it exists) and every
  // copy is checked — a `cp` that failed used to leave a clone without, say,
  // controlDict and still report "cloned". A failed copy removes the half-made
  // clone, which this call created and nothing else owns.
  const b64 = Buffer.from(`
SRC=${shellQuote(srcPath)}
DST=${shellQuote(dstPath)}
if [ -e "$DST" ]; then echo "a case with this name already exists" >&2; exit 1; fi
mkdir -- "$DST" || { echo "the new case folder could not be created" >&2; exit 1; }
for d in 0 system constant; do
  if [ -d "$SRC/$d" ]; then
    cp -r -- "$SRC/$d" "$DST/" || { rm -rf -- "$DST"; echo "$d/ could not be copied, so nothing was cloned" >&2; exit 1; }
  fi
done
echo "OK: cloned"
`).toString('base64');
  try {
    return runInWslScript(b64, 30000).trim();
  } catch (e: any) {
    throw new Error(`Clone failed: ${e.message}`);
  }
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
if [ ! -d "$SRC" ]; then echo "the case was not found" >&2; exit 1; fi
if [ -e "$DST" ]; then echo "a case with this name already exists" >&2; exit 1; fi
mv -- "$SRC" "$DST" || { echo "the folder could not be moved" >&2; exit 1; }
echo "OK: renamed"
`).toString('base64');
  // Refusals are written to stderr, the stream runInWslScript reports; on
  // stdout they reached the user as the raw wsl command line instead.
  let result: string;
  try {
    result = runInWslScript(b64, 30000).trim();
  } catch (e: any) {
    throw new Error(`Rename failed: ${e.message}`);
  }
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
  /** False when there was no mesh to check the patches against. */
  meshChecked?: boolean;
}

/**
 * Everything a boundaryField key can be, and what it matches.
 *
 * The check used to compare each key against the list of patch names, with a
 * scanner that read a key as `[\w.]+`. That is wrong for most of the ways
 * OpenFOAM lets you name a boundary, and it failed on a real case: a key
 * written `"splitter.*"` — six of the nine patches of a combustor — was read as
 * the name `splitter.`, matched nothing, and was reported as an error, while
 * the six patches it covers were reported as missing. Thirteen false errors on
 * a case that runs.
 *
 * The survey, and what each one needs:
 *
 *   "splitter.*"        A QUOTED REGULAR EXPRESSION. This is the normal way to
 *   ".*"                write one, and quotes are what tell OpenFOAM's
 *   "(inlet|outlet)"    dictionary that the key is a pattern. The scanner has
 *                       to read the quotes, and the pattern is anchored to the
 *                       WHOLE patch name — "wall" does not match "outerWalls".
 *
 *   splitter.*          Unquoted, with metacharacters. OpenFOAM treats this as
 *                       a literal key and it silently matches nothing; people
 *                       write it anyway. Matched as a pattern here, because
 *                       reporting "no such patch" would be true and useless.
 *
 *   wall / walls        A PATCH GROUP. Every wall patch is automatically in the
 *                       group "wall", and snappyHexMesh writes explicit
 *                       inGroups lists — over six lines, which is what the old
 *                       single-line regex for it missed.
 *
 *   #include "…"        PREPROCESSOR DIRECTIVES. They stand where a key would
 *   #includeEtc         stand and bring in entries this code never sees. Read
 *   #includeIfPresent   as directives and reported as "not checked" instead of
 *   #remove             being parsed as a patch called "#include".
 *
 *   $internalField      A MACRO used as a whole entry. Same treatment.
 *   ${…}
 *
 *   // …  /* … *\/      COMMENTS, including the banner every OpenFOAM file
 *                       opens with. Stripped before anything else: a commented
 *                       block was being read as real, and a brace inside a
 *                       comment threw the brace counting off for the rest of
 *                       the file.
 *
 *   value uniform 0;    A plain keyword sitting in boundaryField, with no
 *                       block after it. Skipped to its semicolon — the old
 *                       scanner desynchronised here and misread everything
 *                       that followed.
 *
 * Multi-region cases are handled in the caller: they have one mesh per region,
 * and checking a field against all of them at once reports every other
 * region's patches as missing.
 */

/** OpenFOAM comments, out before any structural parsing. Quoted strings are
 *  left alone, so a `//` inside "…" is not mistaken for a comment. */
function stripFoamComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '"' && text[i - 1] !== '\\') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;   // the newline itself is kept
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface MeshPatch {
  name: string;
  /** `type` from the boundary file: patch, wall, empty, symmetry, … */
  type: string;
  /** Groups this patch belongs to, its type included. */
  groups: string[];
}

/**
 * `inGroups List<word> 2(walls wall);`
 *
 * snappyHexMesh writes the same thing over six lines, with the count, the
 * parentheses and each word on their own — which is why this looks for the
 * parenthesised list anywhere between the keyword and its semicolon rather
 * than expecting `2(` to be adjacent. The old single-line pattern found
 * nothing on any snappy-generated mesh.
 */
function parseInGroups(body: string): string[] {
  const m = body.match(/\binGroups\s+List<word>([\s\S]*?);/);
  if (!m) return [];
  const list = m[1].match(/\(([\s\S]*?)\)/);
  if (!list) return [];
  return list[1].split(/\s+/).map(s => s.trim()).filter(Boolean);
}

/** The patches of `constant/polyMesh/boundary`, with their groups. */
export function parsePolyMeshBoundary(text: string): MeshPatch[] {
  const clean = stripFoamComments(text);
  const patches: MeshPatch[] = [];
  // A patch name is any word OpenFOAM accepts: everything up to whitespace, a
  // brace, a semicolon, a bracket or a quote. snappyHexMesh names patches after
  // the surface regions (`motorBike_frt-fairing:001%1`), and an identifier-only
  // pattern skipped every one of them — so their groups were then reported as
  // "not a patch or group of this mesh".
  const re = /([^\s{};()"]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const body = extractBraceBlock(clean, open);
    if (body === null) continue;
    re.lastIndex = open + body.length + 2;
    if (name === 'FoamFile') continue;

    const type = (body.match(/\btype\s+([A-Za-z][A-Za-z0-9_]*)\s*;/) || [])[1] || '';
    const groups = parseInGroups(body);
    // A wall patch is in the group "wall" whether or not inGroups says so —
    // OpenFOAM's own patch classes put their type in the group list. Adding it
    // here is what makes a `wall { }` entry resolve on a blockMesh case, which
    // writes no inGroups at all.
    if (type && !groups.includes(type)) groups.push(type);
    patches.push({ name, type, groups });
  }
  return patches;
}

type EntryKind = 'name' | 'regex';

interface BoundaryEntry {
  key: string;
  kind: EntryKind;
  /** The `type` inside the block, or null when it has none. */
  type: string | null;
}

/** One pass over a boundaryField block. See the survey above for what it has
 *  to survive. */
function parseBoundaryFieldEntries(block: string): { entries: BoundaryEntry[]; directives: string[] } {
  const clean = stripFoamComments(block);
  const entries: BoundaryEntry[] = [];
  const directives: string[] = [];
  let i = 0;

  const skipSpace = () => { while (i < clean.length && /\s/.test(clean[i])) i++; };
  const skipToSemicolonOrEol = (): string => {
    const start = i;
    while (i < clean.length && clean[i] !== ';' && clean[i] !== '\n') i++;
    const text = clean.slice(start, i).trim();
    if (i < clean.length) i++;
    return text;
  };

  while (i < clean.length) {
    skipSpace();
    if (i >= clean.length) break;
    const ch = clean[i];

    // A preprocessor directive or a macro standing where a key would stand.
    if (ch === '#' || ch === '$') {
      const text = skipToSemicolonOrEol();
      if (text) directives.push(text.split(/\s+/).slice(0, 2).join(' '));
      continue;
    }

    let key = '';
    let kind: EntryKind;
    if (ch === '"') {
      const end = clean.indexOf('"', i + 1);
      if (end === -1) break;              // unterminated: nothing further is trustworthy
      key = clean.slice(i + 1, end);
      kind = 'regex';
      i = end + 1;
    } else {
      const start = i;
      while (i < clean.length && !/[\s{};]/.test(clean[i])) i++;
      if (i === start) { i++; continue; }
      key = clean.slice(start, i);
      // Unquoted metacharacters: OpenFOAM reads the key literally and it
      // matches nothing, but it is plainly meant as a pattern, so it is
      // resolved as one and the panel says which patches it covers.
      kind = /[*?|()[\]+^$]/.test(key) ? 'regex' : 'name';
    }

    skipSpace();
    if (i >= clean.length) break;
    if (clean[i] !== '{') {
      // `key value;` — a keyword, not a boundary. Skip the whole statement so
      // the scanner stays aligned with the block.
      skipToSemicolonOrEol();
      continue;
    }

    const body = extractBraceBlock(clean, i);
    if (body === null) break;
    i += body.length + 2;
    const type = (body.match(/\btype\s+([^;\s]+)\s*;/) || [])[1] || null;
    entries.push({ key, kind, type: type ? type.replace(/;$/, '') : null });
  }

  return { entries, directives };
}

interface MatchedEntry {
  index: number;
  how: 'name' | 'group' | 'regex';
}

/**
 * The entry OpenFOAM would use for this patch.
 *
 * Its order: the patch's own name, then a group it belongs to, then a regular
 * expression — and among regular expressions the LAST one written wins, which
 * is why that search runs backwards. It matters in the case this was written
 * for: `splitterRear` has an entry of its own AND is matched by
 * `"splitter.*"`, and the exact one is what the solver uses.
 */
function resolveEntryForPatch(patch: MeshPatch, entries: BoundaryEntry[]): MatchedEntry | null {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind === 'name' && entries[i].key === patch.name) return { index: i, how: 'name' };
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind === 'name' && patch.groups.includes(entries[i].key)) return { index: i, how: 'group' };
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'regex') continue;
    // Anchored on both ends: OpenFOAM matches a pattern against the whole patch
    // name, so "wall" does not cover "outerWalls".
    let re: RegExp;
    try { re = new RegExp(`^(?:${e.key})$`); } catch { continue; }
    if (re.test(patch.name)) return { index: i, how: 'regex' };
  }
  return null;
}

/**
 * The entries of a field written in BINARY, read by OpenFOAM rather than by us.
 *
 * `format binary;` writes each patch's values as raw bytes inside
 * `nonuniform List<scalar> 62720(…)` — half a megabyte of arbitrary bytes,
 * braces and quotes included, sitting between one patch entry and the next. No
 * text scanner survives that, and this one did not: on a snappyHexMesh case the
 * 0/thickness and 0/thicknessFraction fields lost every patch after the first
 * blob and reported six of nine as missing, on a case that runs.
 *
 * So for those files the question goes to `foamDictionary`, which is OpenFOAM's
 * own parser and reads binary natively. Only the KEYWORDS are asked for, and
 * then one type per keyword: asking for the sub-dictionary itself would bring
 * the 691 KB of data back with it.
 *
 * All of it in one WSL call for the whole case — see the note in foam-index.ts
 * on why that matters. The `cd` to a Linux directory is the usual requirement:
 * an OpenFOAM binary aborts when the working directory is a Windows mount whose
 * path contains a space.
 */
function binaryFieldEntries(casePath: string, fields: string[]): Map<string, BoundaryEntry[]> {
  const out = new Map<string, BoundaryEntry[]>();
  if (!fields.length) return out;

  const MARK = '@@BCFIELD@@';
  const blocks = fields.map(f => {
    const q = shellQuote(`${casePath}/0/${f}`);
    return `
echo "${MARK}${f}"
KEYS=$(foamDictionary -entry boundaryField -keywords ${q} 2>/dev/null)
for k in $KEYS; do
  T=$(foamDictionary -entry "boundaryField/$k/type" -value ${q} 2>/dev/null | tr -d ' \\n')
  echo "$k|$T"
done`;
  }).join('\n');

  const script = `#!/bin/bash
${foamSource()}
cd /tmp || cd /
${blocks}
`;

  let raw = '';
  try {
    raw = runInWslScript(Buffer.from(script).toString('base64'), 60000);
  } catch {
    return out;   // the caller falls back to the text scan and its warning
  }

  let current: string | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(MARK)) {
      current = trimmed.slice(MARK.length).trim();
      out.set(current, []);
      continue;
    }
    if (!current) continue;
    const bar = trimmed.indexOf('|');
    if (bar <= 0) continue;
    // foamDictionary prints a pattern keyword with its quotes; the shell has
    // usually stripped them by the time it reaches us, so the kind is decided
    // the same way it is for the text scan — by whether the key carries
    // metacharacters.
    const key = trimmed.slice(0, bar).replace(/^"|"$/g, '');
    const type = trimmed.slice(bar + 1).trim();
    out.get(current)!.push({
      key,
      kind: /[*?|()[\]+^$]/.test(key) ? 'regex' : 'name',
      type: type || null,
    });
  }
  return out;
}

export function validateBoundaryConditions(caseName: string): BCValidationResult {
  const casePath = getCasePath(caseName);
  const result: BCValidationResult = { success: false, fields: [], meshPatches: [], warnings: [] };

  try {
    // ── 1. The mesh's own patches ──
    let boundaryFile = '';
    try {
      boundaryFile = runInWsl(`cat -- ${shellQuote(`${casePath}/constant/polyMesh/boundary`)} 2>/dev/null`).trim();
    } catch { /* fall through to the search below */ }

    if (!boundaryFile) {
      // A multi-region case has one boundary file per region, and concatenating
      // them would mix patch names that belong to different meshes — every
      // patch of region A would then look "missing" from region B's fields.
      // Read them one at a time and say so rather than merging.
      let found: string[] = [];
      try {
        found = runInWsl(
          `find ${shellQuote(`${casePath}/constant`)} -path '*polyMesh/boundary' -type f 2>/dev/null`
        ).trim().split('\n').map(s => s.trim()).filter(Boolean);
      } catch { /* no mesh at all */ }

      if (found.length === 1) {
        try { boundaryFile = runInWsl(`cat -- ${shellQuote(found[0])} 2>/dev/null`).trim(); } catch { /* */ }
      } else if (found.length > 1) {
        result.warnings.push(
          `This case has ${found.length} meshes (a multi-region case). Patch checking is skipped: ` +
          `the regions have different patches, and checking a field against all of them at once ` +
          `would report every other region's patches as missing.`
        );
      }
    }

    const meshPatches = boundaryFile ? parsePolyMeshBoundary(boundaryFile) : [];
    result.meshPatches = meshPatches.map(p => p.name);
    result.meshChecked = meshPatches.length > 0;
    // No boundary file at all — before blockMesh, or a case that only has
    // processor* meshes. Every entry used to come back valid with no word about
    // it, and the panel said "All BCs are valid". (A multi-region case has
    // already said why it skips.)
    if (!boundaryFile && result.warnings.length === 0) {
      result.warnings.push(
        'Patches not checked: this case has no mesh yet — run blockMesh (or reconstructPar for a decomposed case).'
      );
    }

    // ── 2. The fields ──
    const zeroDir = runInWsl(
      `find ${shellQuote(`${casePath}/0`)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null`
    ).trim();
    const allZeroFiles = zeroDir.split('\n').map(f => f.trim()).filter(f => f && f !== '.' && f !== '..');
    // Only the physical fields — see isPhysicalFieldFile for what the mesher
    // leaves in here that is not one.
    const fieldFiles = allZeroFiles.filter(isPhysicalFieldFile);

    if (allZeroFiles.length === 0) {
      result.warnings.push('Directory 0/ empty or nonexistent');
      result.success = true;
      return result;
    }

    if (fieldFiles.length === 0) {
      // The directory has content, but none of it is a field to check. Say which
      // it was, so "nothing to validate" does not look like a failure to read.
      result.warnings.push(
        `0/ contains no physical fields to check — only mesh bookkeeping written by the mesher `
        + `(${allZeroFiles.slice(0, 6).join(', ')}${allZeroFiles.length > 6 ? ', …' : ''}).`
      );
      result.success = true;
      return result;
    }

    // A binary field is unreadable as text; ask OpenFOAM for those. The header
    // is ASCII in both formats, so this is decided by reading it, not guessed.
    const contents = new Map<string, string>();
    const binaryFields: string[] = [];
    for (const fieldFile of fieldFiles) {
      let content = '';
      try {
        content = runInWsl(`cat -- ${shellQuote(`${casePath}/0/${fieldFile}`)} 2>/dev/null`).trim();
      } catch { continue; }
      if (!content) continue;
      contents.set(fieldFile, content);
      if (/\bformat\s+binary\s*;/.test(content.slice(0, 2000))) binaryFields.push(fieldFile);
    }
    const binaryEntries = binaryFieldEntries(casePath, binaryFields);

    for (const fieldFile of fieldFiles) {
      const content = contents.get(fieldFile);
      if (!content) continue;

      // Comments come out FIRST. The banner at the top of every OpenFOAM file
      // is a block comment, a commented-out patch block would otherwise be read
      // as a real one, and a `//` line containing a brace would throw the brace
      // counting off for the rest of the file.
      const clean = stripFoamComments(content);
      const binaryList = binaryEntries.get(fieldFile);

      const bfIdx = clean.indexOf('boundaryField');
      if (bfIdx === -1) {
        result.warnings.push(`${fieldFile}: no boundaryField found`);
        continue;
      }
      let pos = bfIdx + 'boundaryField'.length;
      while (pos < clean.length && /\s/.test(clean[pos])) pos++;
      if (pos >= clean.length || clean[pos] !== '{') {
        result.warnings.push(`${fieldFile}: boundaryField without opening brace`);
        continue;
      }
      // Brace counting over a binary blob returns nonsense or nothing; when
      // foamDictionary has already answered for this field, that is fine.
      const bfBlock = extractBraceBlock(clean, pos);
      if (bfBlock === null && !(binaryList && binaryList.length)) {
        result.warnings.push(`${fieldFile}: unable to extract boundaryField`);
        continue;
      }

      const { entries, directives } = binaryList && binaryList.length
        ? { entries: binaryList, directives: [] as string[] }
        : parseBoundaryFieldEntries(bfBlock || '');
      if (directives.length) {
        result.warnings.push(
          `${fieldFile}: ${directives.length} entr${directives.length === 1 ? 'y is' : 'ies are'} ` +
          `built by the preprocessor (${directives.slice(0, 3).join(', ')}` +
          `${directives.length > 3 ? ', …' : ''}) — whatever they bring in was not checked here.`
        );
      }

      const patches: { patch: string; type: string; valid: boolean; note?: string }[] = [];

      // No mesh to check against: report what the file says and nothing more.
      if (meshPatches.length === 0) {
        for (const e of entries) {
          patches.push({ patch: e.key, type: e.type || '(no type)', valid: true });
        }
        if (patches.length) result.fields.push({ name: fieldFile, patches });
        continue;
      }

      // ── 3. Which entry covers which patch ──
      //
      // OpenFOAM resolves a patch against boundaryField in this order: the
      // patch's own name, then a group it belongs to, then a regular
      // expression — and among regular expressions the LAST one written wins.
      // Following the same order is what makes the answer here the answer the
      // solver will give.
      const coverage = new Map<string, MatchedEntry>();
      for (const patch of meshPatches) {
        const match = resolveEntryForPatch(patch, entries);
        if (match) coverage.set(patch.name, match);
      }

      const usedEntries = new Set<number>();
      for (const patch of meshPatches) {
        const match = coverage.get(patch.name);
        if (!match) {
          patches.push({
            patch: patch.name,
            type: 'MISSING',
            valid: false,
            note: 'no entry in boundaryField matches this patch',
          });
          continue;
        }
        usedEntries.add(match.index);
        const e = entries[match.index];
        patches.push({
          patch: patch.name,
          type: e.type || '(no type)',
          valid: true,
          note: match.how === 'name' ? undefined
            : match.how === 'group' ? `via the group "${e.key}"`
            : `via the pattern "${e.key}"`,
        });
      }

      // An entry that covers nothing is the other half of the check: a typo in
      // a patch name, or a pattern that no longer matches anything after the
      // mesh was rebuilt, is silently ignored by OpenFOAM — the field simply
      // has no condition there and the run fails later, somewhere else.
      entries.forEach((e, i) => {
        if (usedEntries.has(i)) return;
        patches.push({
          patch: e.kind === 'regex' ? `"${e.key}"` : e.key,
          type: e.type || '(no type)',
          valid: false,
          note: e.kind === 'regex'
            ? 'this pattern matches none of the mesh patches'
            : 'not a patch or group of this mesh',
        });
      });

      if (patches.length > 0) result.fields.push({ name: fieldFile, patches });
    }

    result.success = true;
  } catch (e: unknown) {
    result.warnings.push(e instanceof Error ? e.message : String(e));
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
# Solver from controlDict.
#
# "application icoFoam;" is the v9/v10 spelling. From v11 the solvers became
# modules and the key is "solver incompressibleFluid;", so looking only for
# application reported an empty solver on every modern case. Both are read,
# newest first.
SOLVER=$(grep -E '^solver\\s+' "$CASE/system/controlDict" 2>/dev/null | awk '{print $2}' | tr -d ';')
if [ -z "$SOLVER" ]; then
  SOLVER=$(grep -E '^application\\s+' "$CASE/system/controlDict" 2>/dev/null | awk '{print $2}' | tr -d ';')
fi
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
# Mesh cells.
#
# The count is in the note of constant/polyMesh/owner, which every mesh writer
# fills in:
#     note  "nPoints: 882 nCells: 400 nFaces: 1640 nInternalFaces: 760";
# It was being looked for in boundary, which does not carry it, and the
# fallback counted lines beginning with an open bracket in faces - a file that
# has exactly one. Every case therefore reported a mesh of 1 cell.
CELLS=$(sed -n 's/.*nCells:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$CASE/constant/polyMesh/owner" 2>/dev/null | head -1)
if [ -z "$CELLS" ]; then
  CELLS=$(sed -n 's/.*nCells:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$CASE/constant/polyMesh/neighbour" 2>/dev/null | head -1)
fi
echo "CELLS:$CELLS"
# Patch names.
#
# The name and its opening brace are on SEPARATE lines in a boundary file:
#
#     movingWall
#     {
#         type  wall;
#
# The old pattern required both on one line, so it matched nothing: the count
# was always 0 and the name list beside it always empty. Remember the previous
# non-blank line and emit it when a lone brace follows, skipping the FoamFile
# header, which opens the same way. The count is then just how many came back.
PATCHNAMES=$(awk '{
  line = $0
  gsub(/^[ \\t]+|[ \\t]+$/, "", line)
  if (line == "{" && prev ~ /^[A-Za-z][A-Za-z0-9_.:-]*$/ && prev != "FoamFile") print prev
  if (line != "") prev = line
}' "$CASE/constant/polyMesh/boundary" 2>/dev/null | head -50 | paste -sd, -)
echo "PATCHNAMES:$PATCHNAMES"
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

    // Through the base64 runner, not `runInWsl`. This script is multi-line and
    // full of shell variables, which is exactly the case the banner on
    // runInWslScript exists for: passed as a `bash -c` argument, the awk
    // program below arrived mangled and quietly produced nothing.
    const output = runInWslScript(Buffer.from(script).toString('base64'), 30000).trim();
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

    // Names and count come from the one call above, so they cannot disagree.
    const patchList = get('PATCHNAMES').split(',').map(name => name.trim()).filter(Boolean);

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
  // Through the script runner, with checkMesh's exit status captured inside the
  // script and `exit 0` at the end: runInWsl returns stdout only on success, so
  // a checkMesh that stopped with a FOAM FATAL reached the panel as the bare
  // wsl command line, next to a "Mesh issues detected" banner about a check
  // that had never run. The report itself is read by parseCheckMeshOutput.
  const script = `cd ${shellQuote(casePath)} || { echo "the case folder was not found" >&2; exit 1; }
${foamSource()}checkMesh 2>&1
echo "__CHECKMESH_EXIT__$?"
exit 0
`;
  let out: string;
  try {
    out = runInWslScript(Buffer.from(script).toString('base64'), 60000);
  } catch (e: any) {
    const timedOut = /ETIMEDOUT|timed out/i.test(String(e.message));
    return {
      success: false,
      raw: timedOut ? 'checkMesh did not finish within 60 s.' : e.message,
      overallStats: [], failedChecks: [], meshOk: false,
    };
  }
  const exitCode = Number((out.match(/__CHECKMESH_EXIT__(\d+)/) || [])[1] ?? 0);
  const raw = out.replace(/\n?__CHECKMESH_EXIT__\d+\s*$/, '').trimEnd();
  const report = parseCheckMeshOutput(raw);
  if (!report.verdictFound && exitCode !== 0) {
    // It stopped before judging the mesh; the reason is in `raw`.
    return { success: false, raw, overallStats: [], failedChecks: [], meshOk: false };
  }
  return { success: true, raw, overallStats: report.overallStats, failedChecks: report.failedChecks, meshOk: report.meshOk };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-processing: the function-object output, and the catalogue that makes it
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything here reads or produces `postProcessing/`. The parsing lives in
// `./postprocess`, which is pure and unit-tested; this half is the WSL access
// it needs.
//
// One trap decided the shape of both scripts below. On this installation
// `etc/caseDicts/postProcessing` is a SYMLINK to `etc/caseDicts/functions`, and
// `find` does not follow symlinks unless told to: `find <link> -type f` reports
// the link itself and nothing else. Without `-L` the catalogue came back with
// zero entries — a feature that silently finds nothing, on the machine it was
// written for. Every find in this section is `find -L`.

/** One place OpenFOAM looks for configured function objects. */
interface FunctionEtcDir {
  /** The `etc` directory itself, without the `caseDicts/...` tail. */
  path: string;
  /** Who put it there: what the panel tells the user about the entry. */
  source: 'user' | 'site' | 'installation';
}

/**
 * Every directory this installation searches for function-object templates.
 *
 * `findEtcDirs` in `etcFiles.H` gives the order, and `-list` reports the union
 * of all of them — so reading only `$WM_PROJECT_DIR/etc` was narrower than the
 * installation itself. A function object the user had written into
 * `~/.OpenFOAM/14/caseDicts/postProcessing` was listed by OpenFOAM, absent from
 * this catalogue, and then REFUSED by the name check as "not available in this
 * OpenFOAM installation" — the one message that could not have been more wrong.
 *
 * Earlier entries win, exactly as `findConfigFile` resolves them, so a user's
 * override of a shipped template is the one the run will use and the one shown.
 */
function getFunctionEtcDirs(): FunctionEtcDir[] {
  const env = getFoamEnv();
  const dirs: FunctionEtcDir[] = [];
  const version = env.WM_PROJECT_VERSION || '';
  const home = env.HOME || '';

  if (home) {
    if (version) dirs.push({ path: `${home}/.OpenFOAM/${version}`, source: 'user' });
    dirs.push({ path: `${home}/.OpenFOAM`, source: 'user' });
  }
  const site = env.WM_PROJECT_SITE
    || (env.WM_PROJECT_INST_DIR ? `${env.WM_PROJECT_INST_DIR}/site` : '');
  if (site) {
    if (version) dirs.push({ path: `${site}/${version}/etc`, source: 'site' });
    dirs.push({ path: `${site}/etc`, source: 'site' });
  }
  if (env.WM_PROJECT_DIR) dirs.push({ path: `${env.WM_PROJECT_DIR}/etc`, source: 'installation' });
  return dirs;
}

/**
 * The name of the retroactive post-processing utility, resolved at run time.
 *
 * OpenFOAM Foundation renamed `postProcess` to `foamPostProcess`; v13 and v14
 * ship only the new name, the v9–v11 line only the old one. Which is present is
 * asked of the installation rather than derived from a version number, the same
 * way ParaView compatibility is decided by capability elsewhere in the app.
 */
const POST_PROCESS_RESOLVER =
  'if command -v foamPostProcess >/dev/null 2>&1; then PP=foamPostProcess; ' +
  'elif command -v postProcess >/dev/null 2>&1; then PP=postProcess; ' +
  'else echo "No postProcess utility in this OpenFOAM installation" >&2; exit 127; fi';

export interface PostProcessFileRef {
  /** File name inside the time directory, e.g. `volFieldValue.dat`, `line.xy`, `U`. */
  name: string;
  /** Time directories that hold a file by this name, ascending. */
  times: string[];
  /** Total bytes across those time directories. */
  bytes: number;
}

export interface PostProcessDataset {
  /** The `postProcessing/<name>` directory — OpenFOAM's own identity for the run. */
  name: string;
  files: PostProcessFileRef[];
}

/**
 * List what a case has already written under `postProcessing/`.
 *
 * One WSL call for the whole tree. Files nested deeper than
 * `<function>/<time>/<file>` — the surface writers put a directory in between —
 * keep their remaining path in the file name, so nothing is hidden and nothing
 * is mistaken for a sibling.
 */
export function listPostProcessing(caseName: string): PostProcessDataset[] {
  const casePath = getCasePath(caseName);
  const root = `${casePath}/${POST_PROCESSING_DIR}`;
  // A cap, because a long transient with per-timestep surface output can hold
  // tens of thousands of files and none of them would fit on screen anyway.
  const MAX_ENTRIES = 20000;
  const script = `
if [ ! -d ${shellQuote(root)} ]; then exit 0; fi
find -L ${shellQuote(root)} -mindepth 3 -type f -printf '%P\\t%s\\n' 2>/dev/null | head -n ${MAX_ENTRIES}
`;
  let output: string;
  try {
    output = runInWslScript(Buffer.from(script).toString('base64'), 30000);
  } catch {
    return [];
  }

  const datasets = new Map<string, Map<string, { times: Set<string>; bytes: number }>>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [relative, size] = line.split('\t');
    if (!relative) continue;
    const segments = relative.split('/');
    if (segments.length < 3) continue;
    const [datasetName, time, ...rest] = segments;
    const fileName = rest.join('/');
    if (!isTabularOutput(fileName)) continue;

    let files = datasets.get(datasetName);
    if (!files) {
      files = new Map();
      datasets.set(datasetName, files);
    }
    let entry = files.get(fileName);
    if (!entry) {
      entry = { times: new Set(), bytes: 0 };
      files.set(fileName, entry);
    }
    entry.times.add(time);
    entry.bytes += Number(size) || 0;
  }

  return Array.from(datasets.entries())
    .map(([name, files]) => ({
      name,
      files: Array.from(files.entries())
        .map(([fileName, entry]) => ({
          name: fileName,
          times: Array.from(entry.times).sort((a, b) => Number(a) - Number(b)),
          bytes: entry.bytes,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One time directory's copy of a dataset file, as text. */
export interface PostProcessSlice {
  startTime: string;
  content: string;
  truncated: boolean;
}

/**
 * Read every time directory's copy of one dataset file.
 *
 * The slices come back base64-encoded, one per line, rather than concatenated
 * behind a delimiter. A delimiter would have to be a string that can never
 * occur in OpenFOAM output, and "can never occur" is the kind of assumption
 * that produces a corrupted chart months later; base64 has no such assumption
 * in it.
 */
export function readPostProcessDataset(
  caseName: string,
  datasetName: string,
  fileName: string,
): PostProcessSlice[] {
  const casePath = getCasePath(caseName);
  // `validateRelativePath` accepts the parentheses, commas and equals signs
  // OpenFOAM puts in these directory names, and refuses traversal, absolute
  // paths and NUL/newline — which is exactly the boundary needed here.
  const safeDataset = validateRelativePath(datasetName, 'Dataset');
  const safeFile = validateRelativePath(fileName, 'File');
  if (safeDataset.includes('/')) throw new WslInputError('Dataset invalid');

  const base = `${casePath}/${POST_PROCESSING_DIR}/${safeDataset}`;
  // 8 MB is about 200 000 rows of a scalar series, which is already past what
  // the parser keeps and far past what a chart can show. Truncation is reported
  // rather than hidden.
  const MAX_SLICE_BYTES = 8 * 1024 * 1024;
  const MAX_SLICES = 200;
  const script = `
base=${shellQuote(base)}
name=${shellQuote(safeFile)}
find -L "$base" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | sort -g | head -n ${MAX_SLICES} |
while IFS= read -r t; do
  f="$base/$t/$name"
  [ -f "$f" ] || continue
  size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
  printf '%s\\t%s\\t' "$t" "$size"
  head -c ${MAX_SLICE_BYTES} -- "$f" | base64 -w0
  printf '\\n'
done
`;
  const output = runInWslScript(Buffer.from(script).toString('base64'), 120000);

  const slices: PostProcessSlice[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf('\t');
    const second = line.indexOf('\t', separator + 1);
    if (separator === -1 || second === -1) continue;
    const startTime = line.slice(0, separator);
    const size = Number(line.slice(separator + 1, second)) || 0;
    const encoded = line.slice(second + 1);
    slices.push({
      startTime,
      content: Buffer.from(encoded, 'base64').toString('utf-8'),
      truncated: size > MAX_SLICE_BYTES,
    });
  }
  return slices;
}

export interface CatalogEntry {
  name: string;
  /** The directory OpenFOAM files it under — `forces`, `graphs`, `probes`, … */
  category: string;
  description: string;
  /** The Description block with its paragraphs and list items kept apart. */
  descriptionParagraphs: string[];
  args: FunctionArg[];
  /**
   * Entries the template or its configuration writes out commented: legal,
   * documented, and off unless the call adds them.
   */
  optional: FunctionArg[];
  /** The function object class behind it, from the configuration it includes. */
  type: string;
  /** The libraries the entry loads, from the same configuration. */
  libs: string[];
  /** Entries that already have a value and can be overridden in the call. */
  defaults: FunctionDefault[];
  /** How the installed tutorials call it. */
  examples: string[];
  /** Which of the installation's search paths this template came from. */
  source: 'user' | 'site' | 'installation';
  /** The template's own path, so the panel can say where the reference is. */
  file: string;
}

let cachedCatalog: { key: string; entries: CatalogEntry[] } | null = null;

/**
 * The function objects this installation offers, with their arguments.
 *
 * Read from `caseDicts/postProcessing/**` under every etc directory this
 * installation searches, not from a table written here: on OpenFOAM 14 the
 * shipped one holds 127 templates and `foamPostProcess -list` reports the same
 * 127, while v13 has 119. Reading the files instead of running the utility
 * costs no OpenFOAM startup, needs no case to be open, and gives the argument
 * list and help text in the same call — the templates declare their own
 * parameters as `<placeholder>` entries with the comment that explains them.
 */
export function listFunctionCatalog(refresh = false): CatalogEntry[] {
  const dirs = getFunctionEtcDirs();
  if (!dirs.length) return [];
  const tutorials = getTutorialDirectory();
  const key = dirs.map(dir => dir.path).join(':');
  if (!refresh && cachedCatalog && cachedCatalog.key === key) return cachedCatalog.entries;

  // Three sections in ONE call: the templates, the configurations they include
  // (which carry the class and the overridable defaults a template hides), and
  // the way the installed tutorials call each function. The last is the best
  // documentation there is and cannot go stale, because it is read from the
  // version in use.
  //
  // Each directory is read in the order OpenFOAM searches them, and the first
  // copy of a name is the one that counts, both here and in the run.
  const readDir = (dir: FunctionEtcDir, index: number) => `
if [ -d ${shellQuote(`${dir.path}/caseDicts/postProcessing`)} ]; then
  find -L ${shellQuote(`${dir.path}/caseDicts/postProcessing`)} -type f -not -name '*.cfg' -printf '%P\\n' 2>/dev/null | sort |
  while IFS= read -r rel; do
    printf 'T\\t${index}\\t%s\\t' "$rel"
    base64 -w0 < ${shellQuote(`${dir.path}/caseDicts/postProcessing`)}/"$rel"
    printf '\\n'
  done
fi
if [ -d ${shellQuote(`${dir.path}/caseDicts/functions`)} ]; then
  find -L ${shellQuote(`${dir.path}/caseDicts/functions`)} -name '*.cfg' -printf '%P\\n' 2>/dev/null | sort |
  while IFS= read -r rel; do
    printf 'C\\t${index}\\tcaseDicts/functions/%s\\t' "$rel"
    base64 -w0 < ${shellQuote(`${dir.path}/caseDicts/functions`)}/"$rel"
    printf '\\n'
  done
fi`;

  const script = `${dirs.map(readDir).join('\n')}
if [ -d ${shellQuote(tutorials)} ]; then
  printf 'X\\t0\\t-\\t'
  grep -rhs 'includeFunc' ${shellQuote(tutorials)} 2>/dev/null | head -n 2000 | base64 -w0
  printf '\\n'
fi
`;
  let output: string;
  try {
    output = runInWslScript(Buffer.from(script).toString('base64'), 60000);
  } catch {
    return [];
  }

  const templates: { relative: string; content: string; dir: FunctionEtcDir }[] = [];
  const configs: Record<string, string> = {};
  let tutorialLines: string[] = [];

  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [kind, index, relative] = parts;
    const content = Buffer.from(parts.slice(3).join('\t'), 'base64').toString('utf-8');
    if (kind === 'X') { tutorialLines = content.split('\n'); continue; }
    const dir = dirs[Number(index)];
    if (!dir) continue;
    // Earlier directories win, which is how `findConfigFile` resolves a name.
    if (kind === 'C') { if (!(relative in configs)) configs[relative] = content; }
    else if (kind === 'T') templates.push({ relative, content, dir });
  }

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const { relative, content, dir } of templates) {
    const segments = relative.split('/');
    const name = segments.pop() || '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const template = parseFunctionTemplate(content);
    const extras = resolveTemplateExtras(content, configs);
    entries.push({
      name,
      category: segments.join('/') || 'general',
      description: template.description,
      descriptionParagraphs: template.descriptionParagraphs,
      // The commented entries are documented options rather than arguments;
      // they are listed on their own so the default call never carries one.
      args: template.args.filter(arg => !arg.commented),
      optional: optionalTemplateEntries(content, configs),
      type: extras.type,
      libs: extras.libs,
      defaults: extras.defaults,
      examples: tutorialExamplesFor(name, tutorialLines),
      source: dir.source,
      file: `${dir.path}/caseDicts/postProcessing/${relative}`,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length) cachedCatalog = { key, entries };
  return entries;
}

export interface PostProcessUtility {
  /** `foamPostProcess` or `postProcess`, whichever this installation has. */
  name: string;
  /**
   * The options its own `-help` reports, `-solver` included or not.
   *
   * Asked rather than derived from a version number, for the same reason the
   * name is: `-solver` is what makes the transport and thermophysical models
   * exist during a replay, it is absent from the older line, and passing an
   * option `argList` does not know is fatal.
   */
  options: string[];
}

let cachedUtility: { key: string; utility: PostProcessUtility } | null = null;

/**
 * Which retroactive utility this installation has, and what it accepts.
 *
 * Asked once and remembered, only so the panel can SHOW the right command.
 * The run itself resolves the name again inside the script, because that is
 * the answer that has to be right even if this cache is stale.
 */
export function postProcessUtility(): PostProcessUtility {
  const key = findBashrc() || 'none';
  if (cachedUtility && cachedUtility.key === key) return cachedUtility.utility;
  const script = `
${foamSource()}
${POST_PROCESS_RESOLVER}
echo "OFSTUDIO_UTILITY=$PP"
"$PP" -help 2>&1 | sed -n 's/^  \\(-[A-Za-z]*\\).*/OFSTUDIO_OPTION=\\1/p'
`;
  try {
    const output = runInWslScript(Buffer.from(script).toString('base64'), 30000);
    const name = output.match(/OFSTUDIO_UTILITY=(\S+)/)?.[1] ?? '';
    if (name === 'foamPostProcess' || name === 'postProcess') {
      const options = Array.from(new Set(
        Array.from(output.matchAll(/OFSTUDIO_OPTION=(-[A-Za-z]+)/g)).map(match => match[1]),
      ));
      const utility = { name, options };
      cachedUtility = { key, utility };
      return utility;
    }
  } catch { /* the default below is the modern one */ }
  // No options rather than a guessed list: an empty list means "unknown", and
  // the command parser then checks only its own allowlist.
  return { name: 'foamPostProcess', options: [] };
}

/** The utility's name alone, for the callers that only show the command. */
export function postProcessUtilityName(): string {
  return postProcessUtility().name;
}

export interface PostProcessRunResult {
  exitCode: number;
  output: string;
  /** The utility that actually ran, for the activity line the UI shows. */
  command: string;
}

/**
 * Run one function object over the times a case has already written.
 *
 * The specification is composed and validated by `buildFunctionSpec`, checked
 * against this installation's own catalogue, and then quoted as a single
 * argument. `-time` is bounded to the same character set for the same reason.
 *
 * Deliberately NOT a general command runner: the Commands tab already is one.
 * This exists so the tab can produce the dataset it is about to plot.
 */
export function runPostProcessFunction(
  caseName: string,
  spec: string,
  options: {
    time?: string; fields?: string[]; region?: string; solver?: string;
    latestTime?: boolean; noZero?: boolean; constant?: boolean;
  } = {},
): PostProcessRunResult {
  const casePath = getCasePath(caseName);
  if (!FUNCTION_SPEC_SAFE.test(spec) || spec.length > 1024) {
    throw new WslInputError('Function specification is not valid');
  }

  const args = [`-func ${shellQuote(spec)}`];
  if (options.time) {
    if (!/^[0-9.,:\-+eE ]{1,120}$/.test(options.time)) throw new WslInputError('Time range is not valid');
    args.push(`-time ${shellQuote(options.time)}`);
  }
  if (options.fields?.length) {
    for (const field of options.fields) {
      if (!/^[A-Za-z][\w.]{0,63}$/.test(field)) throw new WslInputError(`Field name is not valid: ${field}`);
    }
    args.push(`-fields ${shellQuote(`(${options.fields.join(' ')})`)}`);
  }
  if (options.region) {
    if (!/^[A-Za-z][\w.]{0,63}$/.test(options.region)) throw new WslInputError('Region name is not valid');
    args.push(`-region ${shellQuote(options.region)}`);
  }
  if (options.solver) {
    if (!/^[A-Za-z][\w.]{0,63}$/.test(options.solver)) throw new WslInputError('Solver name is not valid');
    // Refused rather than passed on when this OpenFOAM has no such option:
    // `argList` treats an unknown option as fatal and answers with its usage
    // screen, which says nothing about what the panel actually did wrong.
    if (!postProcessUtility().options.includes('-solver')) {
      throw new WslInputError('This OpenFOAM\'s postProcess has no -solver option');
    }
    args.push(`-solver ${shellQuote(options.solver)}`);
  }
  // Switches, not values: nothing of the caller's reaches the command line.
  if (options.latestTime) args.push('-latestTime');
  if (options.noZero) args.push('-noZero');
  if (options.constant) args.push('-constant');

  // An OpenFOAM binary must never run with the Windows-mounted project path as
  // its working directory — the space in the Windows user name makes it abort —
  // so the cd into the Linux-side case is not optional, and `|| exit 1` binds to
  // the cd alone for the reason documented on foamExec.
  // The script ends `exit 0` and reports the utility's status in a marker line
  // instead of letting it become the script's own. A failing OpenFOAM run makes
  // execFileSync throw, and the thrown error carries the invocation — the whole
  // base64 blob — where the useful text should be; the user was shown the
  // command line that failed instead of the "Essential value for keyword 'rhoInf'
  // not set" that says what to fix. Succeeding always keeps the diagnosis.
  const script = `
${foamSource()}
cd ${shellQuote(casePath)} || exit 1
${POST_PROCESS_RESOLVER}
echo "OFSTUDIO_UTILITY=$PP"
"$PP" ${args.join(' ')} 2>&1
echo "OFSTUDIO_EXIT=$?"
exit 0
`;
  try {
    const output = runInWslScript(Buffer.from(script).toString('base64'), 600000);
    const status = output.match(/OFSTUDIO_EXIT=(\d+)/);
    return {
      exitCode: status ? Number(status[1]) : 0,
      output: stripMarkers(output),
      command: readUtilityMarker(output),
    };
  } catch (e: any) {
    // Only the paths that never reached the marker land here: WSL itself
    // unreachable, the distro down, a failed `cd`.
    return { exitCode: 1, output: String(e?.message ?? 'postProcess could not be started'), command: 'postProcess' };
  }
}

/** Same allowlist `buildFunctionSpec` enforces, applied again at the WSL edge. */
const FUNCTION_SPEC_SAFE = /^[A-Za-z0-9_.,:+\-*/()=|"[\] ]*$/;

function readUtilityMarker(output: string): string {
  const match = output.match(/OFSTUDIO_UTILITY=(\S+)/);
  return match ? match[1] : 'postProcess';
}

function stripMarkers(output: string): string {
  return output
    .replace(/^OFSTUDIO_UTILITY=\S+\n?/m, '')
    .replace(/^OFSTUDIO_EXIT=\d+\n?/m, '')
    .trimEnd();
}

// ── The class documentation behind a configured function object ──

/** `Foam::functionObjects::yPlus` → the header file that declares it. */
let cachedClassIndex: { key: string; index: Map<string, string> } | null = null;

/**
 * Where each documented class lives in this installation's own source.
 *
 * Built from the `Class` line of every header, which is the one place the
 * fully qualified name is written down. Matching on the FILE name instead
 * looked cheaper and was wrong: `boundaryProbes` resolves to the class `sets`,
 * and `sets.H` in this installation is a topoSet source that has nothing to do
 * with sampling. A qualified name cannot be confused that way.
 *
 * A missing entry is a normal outcome — some function objects are registered
 * under a name their header does not carry — and the panel then shows the
 * template's own reference alone rather than another class's.
 */
function getClassIndex(): Map<string, string> {
  const env = getFoamEnv();
  const src = env.FOAM_SRC || (env.WM_PROJECT_DIR ? `${env.WM_PROJECT_DIR}/src` : '');
  if (!src) return new Map();
  const applications = env.WM_PROJECT_DIR ? `${env.WM_PROJECT_DIR}/applications` : '';
  const key = `${src}:${applications}`;
  if (cachedClassIndex && cachedClassIndex.key === key) return cachedClassIndex.index;

  // `lnInclude` is a directory of symlinks to the same headers; keeping it
  // would double every entry and point at a path that reads as a duplicate.
  // `-n` is not decoration: without a line number a context line comes back as
  // `path.H-    Foam::x`, and the pattern below — which anchors on the
  // `-<line>-` separator to tell the path from the class — then matches
  // nothing at all, so every function silently had no documentation.
  const script = `
grep -rns --include='*.H' -A1 '^Class$' ${shellQuote(src)}${applications ? ` ${shellQuote(applications)}` : ''} 2>/dev/null |
  grep -v '/lnInclude/' |
  sed -n 's|^\\(.*\\.H\\)-[0-9]\\{1,\\}-[[:space:]]*\\(Foam::[A-Za-z0-9_:]*\\)$|\\2\\t\\1|p'
`;
  const index = new Map<string, string>();
  try {
    const output = runInWslScript(Buffer.from(script).toString('base64'), 60000);
    for (const line of output.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const className = line.slice(0, tab).trim();
      const file = line.slice(tab + 1).trim();
      if (className && file && !index.has(className)) index.set(className, file);
    }
  } catch {
    return new Map();
  }
  if (index.size) cachedClassIndex = { key, index };
  return index;
}

export interface FunctionClassDoc extends ClassDocumentation {
  /** The header the documentation was read from, for the panel to cite. */
  file: string;
}

const cachedClassDocs = new Map<string, FunctionClassDoc | null>();

/**
 * The installation's own reference for one function object class.
 *
 * The configured template is four lines and one sentence; the class header
 * carries the property table, the allowed values of each enumeration and a
 * complete dictionary example — the documentation OpenFOAM ships for the
 * version that is installed. Nothing of it is written here, so it is right for
 * v13 and v14 alike and will be right for the next one.
 *
 * Returns null when the class cannot be identified with certainty. That is the
 * deliberate outcome: a reference for the wrong class would be worse than none,
 * and the panel is complete without it.
 */
export function readFunctionClassDoc(type: string): FunctionClassDoc | null {
  if (!/^[A-Za-z][A-Za-z0-9_.:]{0,63}$/.test(type)) return null;
  const cached = cachedClassDocs.get(type);
  if (cached !== undefined) return cached;

  const index = getClassIndex();
  // `functionObjects` first, then any other namespace, then the bare name. The
  // qualified forms are what a function object actually declares —
  // `Foam::functionObjects::fieldValues::volFieldValue` has two of them.
  const candidates = Array.from(index.keys()).filter(name => name.endsWith(`::${type}`));
  const preferred = candidates.find(name => name.startsWith('Foam::functionObjects::'))
    ?? candidates.find(name => name === `Foam::${type}`)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  const file = preferred ? index.get(preferred) : undefined;
  if (!file) { cachedClassDocs.set(type, null); return null; }

  try {
    // Only the header comment is needed, and it is always at the top. Reading
    // 200 lines instead of the file keeps a 4000-line header out of the wire.
    const script = `head -n 200 ${shellQuote(file)} 2>/dev/null | base64 -w0`;
    const encoded = runInWslScript(Buffer.from(script).toString('base64'), 30000).trim();
    const parsed = parseClassDocumentation(Buffer.from(encoded, 'base64').toString('utf-8'));
    const doc = parsed ? { ...parsed, file } : null;
    cachedClassDocs.set(type, doc);
    return doc;
  } catch {
    return null;
  }
}

// ── What the open case can answer about itself ──

export interface PostProcessContext extends CaseContext {
  /** `solver` in a v11+ controlDict, `application` in the older layout. */
  solver: string;
  /** Times already written, so a `-time` range can name one that exists. */
  times: string[];
}

/**
 * The case's own vocabulary, for the example values and the default command.
 *
 * One WSL call, all of it cheap: names out of `constant/polyMesh/boundary`,
 * `cellZones` and `faceZones`, the fields written at the latest time, the
 * solver from `controlDict`, and the bounding box from `constant/polyMesh/
 * points` when that file is ASCII. The box is what turns `start=(0 0 0),
 * end=(0 0 0)` — a line of zero length that no graph function can sample —
 * into a line that crosses this mesh.
 */
export function getPostProcessContext(caseName: string): PostProcessContext {
  const casePath = getCasePath(caseName);
  const empty: PostProcessContext = {
    solver: '', times: [], patches: [], fields: [], cellZones: [], faceZones: [],
  };

  const script = `
CASE=${shellQuote(casePath)}
SOLVER=$(sed -n 's/^solver[[:space:]]\\{1,\\}\\([A-Za-z][A-Za-z0-9_.]*\\);.*/\\1/p' "$CASE/system/controlDict" 2>/dev/null | head -1)
if [ -z "$SOLVER" ]; then
  SOLVER=$(sed -n 's/^application[[:space:]]\\{1,\\}\\([A-Za-z][A-Za-z0-9_.]*\\);.*/\\1/p' "$CASE/system/controlDict" 2>/dev/null | head -1)
fi
echo "SOLVER:$SOLVER"

# Zone and patch names all sit above a lone brace, the way the boundary file
# writes them; the same awk reads all three files.
names() {
  awk '{
    line = $0
    gsub(/^[ \\t]+|[ \\t]+$/, "", line)
    if (line == "{" && prev ~ /^[A-Za-z][A-Za-z0-9_.:-]*$/ && prev != "FoamFile") print prev
    if (line != "") prev = line
  }' "$1" 2>/dev/null | head -n 200 | paste -sd, -
}
echo "PATCHES:$(names "$CASE/constant/polyMesh/boundary")"
echo "CELLZONES:$(names "$CASE/constant/polyMesh/cellZones")"
echo "FACEZONES:$(names "$CASE/constant/polyMesh/faceZones")"

TIMES=$(
  for d in "$CASE"/*/; do
    [ -d "$d" ] || continue
    bn=\${d%/}; bn=\${bn##*/}
    case "$bn" in system|constant|processor*|postProcessing|dynamicCode) continue ;; esac
    printf '%s\\n' "$bn"
  done | grep -E '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' | sort -gu
)
echo "TIMES:$(printf '%s\\n' "$TIMES" | grep -v '^$' | paste -sd, -)"

# Fields as written at the latest time, falling back to 0/ for a case that has
# not been run: those are the names a function object can actually be given.
LAST=$(printf '%s\\n' "$TIMES" | grep -v '^$' | tail -1)
FIELDDIR="$CASE/$LAST"
if [ -z "$LAST" ] || [ ! -d "$FIELDDIR" ]; then FIELDDIR="$CASE/0"; fi
echo "FIELDS:$(ls -1 "$FIELDDIR" 2>/dev/null | grep -E '^[A-Za-z][A-Za-z0-9_.]*$' | grep -v -E '^(uniform|polyMesh)$' | head -n 100 | paste -sd, -)"

# The bounding box, only when the points are ASCII — a binary file would be
# scanned as noise, and no example is better than a wrong one.
POINTS="$CASE/constant/polyMesh/points"
if [ -f "$POINTS" ] && head -c 4096 "$POINTS" | grep -q 'format[[:space:]]*ascii'; then
  echo "BOUNDS:$(awk '
    /^\\(-?[0-9.eE+-]+ -?[0-9.eE+-]+ -?[0-9.eE+-]+\\)$/ {
      x = substr($1, 2) + 0; y = $2 + 0; z = substr($3, 1, length($3) - 1) + 0
      if (n++ == 0) { x0 = x1 = x; y0 = y1 = y; z0 = z1 = z }
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
      if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    END { if (n > 0) printf "%.10g,%.10g,%.10g,%.10g,%.10g,%.10g", x0, y0, z0, x1, y1, z1 }
  ' "$POINTS" 2>/dev/null)"
fi
`;

  let output: string;
  try {
    output = runInWslScript(Buffer.from(script).toString('base64'), 60000);
  } catch {
    return empty;
  }

  const read = (prefix: string) => {
    const line = output.split('\n').find(entry => entry.startsWith(`${prefix}:`));
    return line ? line.slice(prefix.length + 1).trim() : '';
  };
  const list = (prefix: string) => read(prefix).split(',').map(item => item.trim()).filter(Boolean);

  const rawBounds = list('BOUNDS').map(Number);
  const bounds = rawBounds.length === 6 && rawBounds.every(Number.isFinite)
    ? (rawBounds as [number, number, number, number, number, number])
    : undefined;

  return {
    solver: read('SOLVER'),
    times: list('TIMES'),
    patches: list('PATCHES'),
    fields: list('FIELDS'),
    cellZones: list('CELLZONES'),
    faceZones: list('FACEZONES'),
    bounds,
  };
}

// ── Reset all caches (called when the distro changes or on manual refresh) ──
export function resetCache() {
  cachedCatalog = null;
  // The catalogue, the utility and the class documentation all belong to ONE
  // installation, so they go together — RULES calls this out, and a class
  // reference kept from the previous version is exactly the kind of stale
  // answer that reads as authoritative.
  cachedUtility = null;
  cachedClassIndex = null;
  cachedClassDocs.clear();
  cachedBashrc = null;
  cachedRunDir = null;
  cachedTutDir = null;
  cachedFoamEnv = null;
  cachedVersion = null;
  cachedInstallationIdentity = null;
  // The list of installed OpenFOAMs belongs to a DISTRO, and resetCache's only
  // caller that matters is setDistro. Leaving it behind meant the Settings
  // version dropdown went on offering the previous distro's installations after
  // a switch — and picking one set selectedBashrc to a path that does not exist
  // in the new distro, so every command then failed to source anything.
  cachedFoamVersions = null;
  foamVersionsFailedAt = 0;
  // NOTE: selectedBashrc is deliberately NOT cleared here. It is the user's
  // explicit version choice, and keeping it across a cache reset is the whole
  // point of the v1.4 fix that stopped a transient WSL failure from silently
  // re-detecting a different OpenFOAM (and with it a different run directory,
  // which makes the user's cases appear to vanish). Only setDistro clears it,
  // because only a distro change makes the path meaningless.
  runDirVerified = false;
  tutDirVerified = false;
  // An explicit refresh must never be answered out of a remembered failure —
  // "Retry" has to actually retry.
  clearNegativeCaches();
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


// ── Boundary surface extraction (for the 3D mesh viewer) ────────────────────
//
// surfaceMeshTriangulate writes the case's boundary patches as an ASCII STL.
// Two things about it drive the design here:
//
//  - It resolves the output path RELATIVE TO THE CASE DIRECTORY, even when
//    given an absolute one (it prepends the case path and then fails). So the
//    file is necessarily written inside the case; we use a dotted, unmistakable
//    name and delete it as soon as it has been read.
//  - ASCII STL keeps one `solid <patchName>` block per patch, so patch names
//    and grouping survive. The binary format is ~4x smaller but flat — it loses
//    the patch names, which the viewer needs — so ASCII it is, and we compact
//    the data ourselves before sending it to the browser.

/** Temp file surfaceMeshTriangulate writes into the case directory. */
const SURFACE_STL_NAME = '.openfoam-studio-viewer.stl';

export interface SurfaceExtraction {
  /** Windows-visible path to the STL, e.g. \\wsl.localhost\Ubuntu\home\... */
  windowsPath: string;
  /** Patch names in the order surfaceMeshTriangulate reported them. */
  patchNames: string[];
}

/**
 * Translate a POSIX path inside the active WSL distro into a path Windows can
 * open directly. Reading through this is far faster than piping the file
 * through `wsl.exe` and base64 (measured ~70-120 MB/s vs. a full buffer copy),
 * and it avoids the 50 MB maxBuffer ceiling entirely.
 */
export function wslPathToWindows(posixPath: string): string {
  const distro = getDistro();
  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, '\\')}`;
}

/**
 * Run surfaceMeshTriangulate on a case and return where to read the result.
 * Throws if the case has no mesh yet (no constant/polyMesh).
 */
export async function extractCaseSurface(caseName: string, timeout = 120000): Promise<SurfaceExtraction> {
  const casePath = getCasePath(caseName);
  const src = foamSource();

  // The markers and the final `exit 0` are there so their text reaches the
  // checks below: a script that exits non-zero hands back stderr, which here
  // is nothing but the command line (a 375-character base64 blob on screen).
  // Asynchronous because surfaceMeshTriangulate can run for up to two minutes
  // on a large case, and the synchronous runner froze every other request of
  // the server — Monitor, Dashboard, all of it — for that whole time.
  const script = `
${src}cd ${shellQuote(casePath)} 2>/dev/null || { echo "__NO_CASE__"; exit 0; }
[ -d constant/polyMesh ] || { echo "__NO_MESH__"; exit 0; }
rm -f ${shellQuote(SURFACE_STL_NAME)}
surfaceMeshTriangulate ${shellQuote(SURFACE_STL_NAME)} 2>&1
exit 0
`;
  const out = await runInWslScriptAsync(Buffer.from(script).toString('base64'), timeout);

  if (out.includes('__NO_CASE__')) throw new Error(`Case not found: ${caseName}`);
  if (out.includes('__NO_MESH__')) {
    throw new Error('This case has no mesh yet — run blockMesh first.');
  }
  if (/FOAM FATAL/.test(out)) {
    // The reason is the line after "FOAM FATAL ERROR"; the first line of the
    // output is OpenFOAM's banner.
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    const fatal = lines.findIndex(l => /FOAM FATAL/.test(l));
    const detail = (fatal >= 0 && lines[fatal + 1]) || 'unknown error';
    throw new Error(`surfaceMeshTriangulate failed: ${detail}`);
  }

  // "surfZone 0 : movingWall" — the patch list, in write order.
  const patchNames = [...out.matchAll(/^surfZone\s+\d+\s*:\s*(\S+)/gm)].map(m => m[1]);

  return {
    windowsPath: wslPathToWindows(`${casePath}/${SURFACE_STL_NAME}`),
    patchNames,
  };
}

/**
 * About how many triangles the boundary surface will have, read from the
 * mesh's own `constant/polyMesh/boundary` before anything is extracted, or null
 * when that file cannot be read. Two per face: blockMesh and snappyHexMesh
 * faces are mostly quads. Processor patches are not part of the surface.
 *
 * It lets the Mesh tab ask about a large mesh BEFORE the minutes of
 * extraction, instead of after them.
 */
export function estimateBoundaryTriangles(caseName: string): number | null {
  let text = '';
  try {
    text = runInWsl(`cat -- ${shellQuote(`${getCasePath(caseName)}/constant/polyMesh/boundary`)} 2>/dev/null`, 10000);
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  const clean = stripFoamComments(text);
  const re = /([^\s{};()"]+)\s*\{/g;
  let faces = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const open = m.index + m[0].length - 1;
    const body = extractBraceBlock(clean, open);
    if (body === null) continue;
    re.lastIndex = open + body.length + 2;
    if (m[1] === 'FoamFile' || /\btype\s+processor(Cyclic)?\s*;/.test(body)) continue;
    faces += Number((body.match(/\bnFaces\s+(\d+)\s*;/) || [])[1] || 0);
  }
  return faces * 2;
}

/** Delete the temp STL. Safe to call even if extraction failed. */
export function cleanupCaseSurface(caseName: string): void {
  try {
    const casePath = getCasePath(caseName);
    runInWsl(`rm -f ${shellQuote(`${casePath}/${SURFACE_STL_NAME}`)}`, 10000);
  } catch { /* best effort */ }
}

export interface ParaFoamMarker {
  /** POSIX path inside WSL. */
  linuxPath: string;
  /** The same file through WSL's Windows UNC share, for native ParaView. */
  windowsPath: string;
}

/**
 * Ask OpenFOAM's own paraFoam wrapper to create/update the case marker.
 *
 * The marker is intentionally retained: it is the normal tiny `paraFoam
 * -touch` artefact, can be reused by ParaView itself, and contains no generated
 * mesh data. Unlike the Mesh tab's temporary STL, there is nothing bulky to
 * clean up.
 */
export function createParaFoamMarker(caseName: string): ParaFoamMarker {
  const casePath = getCasePath(caseName);
  const src = foamSource();
  const script = `
${src}cd ${shellQuote(casePath)} 2>/dev/null || { echo "__NO_CASE__"; exit 0; }
[ -d constant/polyMesh ] || { echo "__NO_MESH__"; exit 0; }
paraFoam -touch 2>&1 || { echo "__PARAFOAM_FAILED__"; exit 0; }
find . -maxdepth 1 -type f -name '*.OpenFOAM' -printf '__MARKER__%f\n' | head -1
`;
  // The markers above exit 0 on purpose: runInWslScript returns stdout only on
  // success, and throws with stderr (here, nothing but the command line)
  // otherwise — so with `exit 1` the checks below never saw their marker.
  const out = runInWslScript(Buffer.from(script).toString('base64'), 30_000);
  if (out.includes('__NO_CASE__')) throw new Error(`Case not found: ${caseName}`);
  if (out.includes('__NO_MESH__')) throw new Error('This case has no mesh yet — run blockMesh first.');
  if (out.includes('__PARAFOAM_FAILED__')) {
    throw new Error('paraFoam -touch failed. Check that paraFoam is available in the selected OpenFOAM installation.');
  }
  const match = out.match(/^__MARKER__([^\r\n]+\.OpenFOAM)$/m);
  if (!match || !/^[^/\\\0\r\n]+\.OpenFOAM$/.test(match[1])) {
    throw new Error('paraFoam -touch did not create a valid .OpenFOAM marker.');
  }
  const linuxPath = `${casePath}/${match[1]}`;
  return { linuxPath, windowsPath: wslPathToWindows(linuxPath) };
}
