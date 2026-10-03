import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ParaViewDataTable } from './pvplots';
import { WORKSPACE_PARAMETER_SCHEMA, parseParaViewWorkspace, type ParaViewWorkspace } from './paraview-workspace';
import { probeRequest, findDataRequest, diagnosticRequest, diagnosticSettings, selectionRecipe, resampleRequest, volumeSettings, type ProbeResult, type FindDataResult, type VolumeSettings, type SelectionRecipe, type DiagnosticSettings } from './paraview-analysis';
import {
  benchmarkFrames, buildVideoPlan, estimateRenderSeconds, videoConfirmation, videoFileName,
  type VideoFormat, type VideoPlan, type VideoRequest,
} from './paraview-video';

export interface ParaViewInstallation {
  found: boolean;
  pvpythonPath?: string;
  version?: string;
  source?: string;
  searched: string[];
  error?: string;
}

type Candidate = { executable: string; source: string };
type Layout = { plausible: boolean; version: string };

// A cold `pvpython.exe --version` loads hundreds of megabytes of Qt, VTK and
// Python DLLs: measured at 107 s on a first run against 3.5 s once Windows has
// the files cached. Detection therefore reads the installation LAYOUT instead
// of executing anything, and only falls back to running the binary for a
// pvpython that sits outside a recognisable ParaView tree — with a timeout a
// cold start can actually meet.
const PROBE_TIMEOUT_MS = 150_000;
const MAX_EXECUTED_PROBES = 3;
const NEGATIVE_CACHE_MS = 30_000;
/** Directories that never hold pvpython.exe, skipped while scanning a tree. */
const SKIPPED_DIRECTORIES = /^(share|lib|lib64|libs|doc|docs|examples|materials|translations|include|python\d*|site-packages|plugins|resources|drivers|licenses|proj|fonts|kernels[-_].*|\..*)$/i;
const EXECUTABLE_BASENAMES = new Set([
  'pvpython.exe', 'pvpython', 'paraview.exe', 'paraview',
  'pvbatch.exe', 'pvbatch', 'pvserver.exe', 'pvserver',
]);

let cachedInstallation: ParaViewInstallation | null = null;
let cachedKey = '';
let cachedAt = 0;
let searchInFlight: { key: string; promise: Promise<ParaViewInstallation> } | null = null;

function execFileText(file: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolve(String(stdout || stderr || '').trim());
    });
  });
}

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function isDirectory(dir: string): Promise<boolean> {
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

async function readDirectory(dir: string): Promise<Dirent[]> {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** Accept what a user actually pastes: quotes, %VARIABLES% and trailing slashes. */
export function normalizeParaViewPath(value: string): string {
  const expanded = String(value || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
    .trim();
  // A bare drive must keep its separator: `C:` alone means that drive's
  // current directory, which is not the same folder as `C:\`.
  return expanded.length > 3 ? expanded.replace(/[\\/]+$/, '') : expanded;
}

/** Turn a user/registry/PATH result into the plausible pvpython executables it represents. */
export function paraViewExecutableCandidates(value: string): string[] {
  const clean = normalizeParaViewPath(value);
  if (!clean) return [];
  const base = path.basename(clean).toLowerCase();
  const executable = EXECUTABLE_BASENAMES.has(base) || base.endsWith('.exe');
  const dir = executable ? path.dirname(clean) : clean;
  const out: string[] = [];
  if (base === 'pvpython.exe' || base === 'pvpython') out.push(clean);
  out.push(
    path.join(dir, 'pvpython.exe'),
    path.join(dir, 'bin', 'pvpython.exe'),
    // A path pointing one level too deep, such as the install's share folder.
    path.join(dir, '..', 'bin', 'pvpython.exe'),
  );
  return [...new Set(out.map(p => path.resolve(p)))];
}

/** Compare dotted versions without treating 5.12 as older than 5.9. */
export function compareParaViewVersions(a: string, b: string): number {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const delta = (aa[i] || 0) - (bb[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

/**
 * Read the version a ParaView tree advertises through its own folder names:
 * `ParaView-6.2.0`, `ParaView 5.13`, `share/paraview-6.2`, `lib/paraview-5.11`.
 * The install folder is the more precise of the two when they agree, because it
 * carries the patch level that the resource folder drops.
 */
export function paraViewVersionFromNames(rootName: string, resourceNames: string[]): string {
  const resource = resourceNames
    .map(name => /^paraview[-_ ]?(\d+\.\d+(?:\.\d+)?)$/i.exec(name)?.[1] || '')
    .filter(Boolean)
    .sort(compareParaViewVersions)
    .pop() || '';
  const root = /(?:^|[^\d.])(\d+\.\d+(?:\.\d+)?)/.exec(rootName)?.[1] || '';
  if (root && resource) {
    const series = (value: string) => value.split('.').slice(0, 2).join('.');
    const richer = root.split('.').length >= resource.split('.').length;
    return series(root) === series(resource) && richer ? root : resource;
  }
  return root || resource;
}

/** Decide from the files around pvpython.exe whether this is a real install. */
async function inspectLayout(executable: string): Promise<Layout> {
  const binDir = path.dirname(executable);
  const root = path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : binDir;
  const [siblings, share, lib] = await Promise.all([
    Promise.all(['paraview.exe', 'pvbatch.exe', 'pvserver.exe'].map(name => isFile(path.join(binDir, name)))),
    readDirectory(path.join(root, 'share')),
    readDirectory(path.join(root, 'lib')),
  ]);
  const resources = [...share, ...lib].filter(entry => entry.isDirectory()).map(entry => entry.name);
  return {
    plausible: siblings.some(Boolean) || resources.some(name => /^paraview[-_ ]?\d/i.test(name)),
    version: paraViewVersionFromNames(path.basename(root), resources),
  };
}

function installationFrom(candidate: Candidate, version: string): ParaViewInstallation {
  return {
    found: true,
    pvpythonPath: path.resolve(candidate.executable),
    version: version || 'unknown',
    source: candidate.source,
    searched: [],
  };
}

async function executedVersion(executable: string): Promise<string> {
  const output = await execFileText(executable, ['--version'], PROBE_TIMEOUT_MS);
  return output.match(/(?:ParaView[^\d]*)?(\d+\.\d+(?:\.\d+)?)/i)?.[1] || '';
}

/**
 * Validate a batch of candidates: the layout for every one of them, and only
 * then, for the few that exist without a recognisable tree around them, the
 * expensive `--version` call — sequentially, so a cold machine never pays for
 * several ParaView start-ups at once.
 */
async function probeCandidates(candidates: Candidate[]): Promise<ParaViewInstallation[]> {
  const present = (await Promise.all(candidates.map(async candidate => (
    await isFile(candidate.executable) ? candidate : null
  )))).filter((value): value is Candidate => Boolean(value));
  if (!present.length) return [];

  const layouts = await Promise.all(present.map(candidate => inspectLayout(candidate.executable)));
  const accepted = present
    .map((candidate, index) => ({ candidate, layout: layouts[index] }))
    .filter(entry => entry.layout.plausible)
    .map(entry => installationFrom(entry.candidate, entry.layout.version));
  if (accepted.length) return accepted;

  const results: ParaViewInstallation[] = [];
  for (const candidate of present.slice(0, MAX_EXECUTED_PROBES)) {
    try {
      const version = await executedVersion(candidate.executable);
      if (version) results.push(installationFrom(candidate, version));
    } catch { /* not a working pvpython */ }
  }
  return results;
}

/**
 * Locate pvpython.exe inside an installation tree. The two standard locations
 * answer instantly; the pruned breadth-first walk exists for portable layouts
 * that nest the install a folder or two below what the user pointed at.
 */
async function findPvpythonBelow(root: string, maxDepth: number): Promise<string[]> {
  for (const relative of ['pvpython.exe', path.join('bin', 'pvpython.exe')]) {
    const direct = path.join(root, relative);
    if (await isFile(direct)) return [direct];
  }
  const found: string[] = [];
  let visited = 0;
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length && visited < 400; depth++) {
    const listings = await Promise.all(level.map(readDirectory));
    visited += level.length;
    const next: string[] = [];
    for (let index = 0; index < level.length; index++) {
      for (const entry of listings[index]) {
        const full = path.join(level[index], entry.name);
        if (entry.isFile()) {
          if (entry.name.toLowerCase() === 'pvpython.exe') found.push(full);
        } else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.test(entry.name)) {
          next.push(full);
        }
      }
    }
    if (found.length) return found;
    level = next;
  }
  return found;
}

async function pathResults(): Promise<string[]> {
  const outputs = await Promise.all(['pvpython.exe', 'paraview.exe'].map(
    name => execFileText('where.exe', [name], 5_000).catch(() => ''),
  ));
  return outputs.flatMap(output => output.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

async function registryResults(): Promise<string[]> {
  const uninstallRoots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const appPaths = ['HKLM', 'HKCU'].map(
    hive => `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\paraview.exe`,
  );
  const [uninstall, apps] = await Promise.all([
    Promise.all(uninstallRoots.map(root => execFileText('reg.exe', ['query', root, '/s'], 12_000).catch(() => ''))),
    Promise.all(appPaths.map(key => execFileText('reg.exe', ['query', key, '/ve'], 5_000).catch(() => ''))),
  ]);
  const results: string[] = [];
  for (const output of uninstall) {
    for (const block of output.split(/\r?\n\r?\n/).filter(block => /ParaView/i.test(block))) {
      for (const match of block.matchAll(/^\s*(?:InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/gmi)) {
        results.push(match[1].trim().replace(/,\d+$/, ''));
      }
    }
  }
  for (const output of apps) {
    const match = output.match(/REG_\w+\s+(.+)$/mi);
    if (match) results.push(match[1].trim());
  }
  return results;
}

/** Folders where installers and portable archives realistically land. */
async function standardInstallResults(): Promise<string[]> {
  const home = process.env.USERPROFILE || os.homedir();
  const roots = [...new Set([
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramData,
    process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\',
    'D:\\',
    home,
    home && path.join(home, 'Desktop'),
    home && path.join(home, 'Downloads'),
  ].filter((value): value is string => Boolean(value)))];
  const listings = await Promise.all(roots.map(readDirectory));
  const trees = listings.flatMap((entries, index) => entries
    .filter(entry => entry.isDirectory() && /paraview/i.test(entry.name))
    .map(entry => path.join(roots[index], entry.name)));
  const found = await Promise.all(trees.map(tree => findPvpythonBelow(tree, 3)));
  return found.flat();
}

async function expandCandidate(value: string, source: string, recursive: boolean): Promise<Candidate[]> {
  const out = paraViewExecutableCandidates(value).map(executable => ({ executable, source }));
  const clean = normalizeParaViewPath(value);
  if (recursive && await isDirectory(clean)) {
    for (const executable of await findPvpythonBelow(clean, 3)) out.push({ executable, source });
  }
  return out;
}

type SearchStep = { source: string; values: string[]; recursive: boolean };

/**
 * Sources in cost order, each one able to end the search. The custom path wins
 * whenever it holds a usable ParaView, so saving it from the Dashboard is never
 * refused because a machine-wide scan happened to answer first.
 */
function searchSteps(customPath: string): (() => Promise<SearchStep>)[] {
  const steps: (() => Promise<SearchStep>)[] = [];
  if (customPath) {
    steps.push(async () => ({ source: 'Custom path', values: [customPath], recursive: true }));
  }
  if (process.env.OFSTUDIO_PARAVIEW_PATH) {
    const value = process.env.OFSTUDIO_PARAVIEW_PATH;
    steps.push(async () => ({ source: 'OFSTUDIO_PARAVIEW_PATH', values: [value], recursive: true }));
  }
  steps.push(async () => ({ source: 'Standard install folders', values: await standardInstallResults(), recursive: false }));
  steps.push(async () => ({ source: 'PATH', values: await pathResults(), recursive: false }));
  steps.push(async () => ({ source: 'Windows registry', values: await registryResults(), recursive: true }));
  return steps;
}

async function runSearch(customPath: string): Promise<ParaViewInstallation> {
  const searched: string[] = [];
  const seen = new Set<string>();

  for (const step of searchSteps(customPath)) {
    const { source, values, recursive } = await step();
    const candidates: Candidate[] = [];
    for (const value of values) {
      for (const candidate of await expandCandidate(value, source, recursive)) {
        const key = candidate.executable.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
        searched.push(candidate.executable);
      }
    }
    if (!candidates.length) continue;
    const valid = await probeCandidates(candidates);
    valid.sort((a, b) => compareParaViewVersions(b.version || '0', a.version || '0'));
    if (valid[0]) return { ...valid[0], searched };
  }

  return {
    found: false,
    searched,
    error: customPath
      ? 'The selected path is not usable and no other ParaView installation was found.'
      : 'ParaView was not found. Install it or enter its folder or pvpython.exe path.',
  };
}

/** Find the newest usable ParaView, regardless of its versioned folder name. */
export async function findParaView(customPath = '', refresh = false): Promise<ParaViewInstallation> {
  const clean = normalizeParaViewPath(customPath);
  const key = clean.toLowerCase();
  // A failed search is worth repeating soon: it now costs a few directory
  // reads, and ParaView may have been installed since the app started.
  const fresh = cachedInstallation?.found || Date.now() - cachedAt < NEGATIVE_CACHE_MS;
  if (!refresh && cachedInstallation && cachedKey === key && fresh) return cachedInstallation;
  // Dashboard and workbench often ask at the same moment; one scan answers both.
  if (searchInFlight && searchInFlight.key === key) return searchInFlight.promise;

  const promise = runSearch(clean).then(result => {
    cachedInstallation = result;
    cachedKey = key;
    cachedAt = Date.now();
    return result;
  }).finally(() => {
    if (searchInFlight?.promise === promise) searchInFlight = null;
  });
  searchInFlight = { key, promise };
  return promise;
}

/**
 * Replace the layout-derived version with the one the running engine reports.
 * Reading it from the session costs nothing and is exact, including the
 * release suffixes a folder name never carries.
 */
export function recordParaViewVersion(pvpythonPath: string, version: string): void {
  if (!cachedInstallation?.found || !version) return;
  if (path.resolve(cachedInstallation.pvpythonPath || '') !== path.resolve(pvpythonPath)) return;
  cachedInstallation = { ...cachedInstallation, version };
}

export interface ParaViewArrayInfo {
  name: string;
  association: 'CELLS' | 'POINTS';
  components: number;
  range: [number, number];
}

export type ParaViewNodeType =
  | 'OpenFOAMReader'
  | 'CaseFileReader'
  | 'Slice'
  | 'Clip'
  | 'Contour'
  | 'CellDatatoPointData'
  | 'PointDatatoCellData'
  | 'Threshold'
  | 'StreamTracer'
  | 'Tube'
  | 'ExtractSurface'
  | 'CellCenters'
  | 'Calculator'
  | 'Gradient'
  | 'Glyph'
  | 'WarpByVector'
  | 'WarpByScalar'
  | 'Transform'
  | 'Reflect'
  | 'ExtractEdges'
  | 'Connectivity'
  | 'Shrink'
  | 'IntegrateVariables'
  | 'PlotOverLine'
  | 'TemporalStatistics'
  | 'CFDGradient'
  | 'Selection'
  | 'ResampleToImage';

export interface ParaViewReaderState {
  caseType: string;
  caseTypes: string[];
  decomposedAvailable: boolean;
  processorCount: number;
  regions: string[];
  selectedRegions: string[];
  hasTimeSteps: boolean;
  bounds: [number, number, number, number, number, number];
}

export interface ParaViewViewState {
  orientationAxes: boolean;
  centerAxes: boolean;
  parallelProjection: boolean;
  background: string;
}

export interface ParaViewPipelineNode {
  id: string;
  label: string;
  type: ParaViewNodeType;
  parent: string | null;
  visible: boolean;
  renderable?: boolean;
  representation: string;
  /** Representations this item's display offers (Feature Edges where the build has it). */
  representations?: string[];
  opacity: number;
  lineWidth: number;
  pointSize: number;
  color: { association: 'SOLID' | 'BLOCKS' | 'CELLS' | 'POINTS'; name: string; preset: string; legend: boolean };
  filePath?: string;
  origin?: [number, number, number];
  normal?: [number, number, number];
  invert?: boolean;
  contour?: { association: 'CELLS' | 'POINTS'; name: string; value: number };
  threshold?: { association: 'CELLS' | 'POINTS'; name: string; lower: number; upper: number };
  streamTracer?: {
    name: string;
    seedType: 'Point Cloud' | 'Line';
    center: [number, number, number];
    radius: number;
    points: number;
    point1: [number, number, number];
    point2: [number, number, number];
    resolution: number;
    direction: 'FORWARD' | 'BACKWARD' | 'BOTH';
    maximumLength: number;
  };
  tube?: { radius: number; sides: number };
  calculator?: { association: 'CELLS' | 'POINTS'; expression: string; resultName: string };
  gradient?: { association: 'CELLS' | 'POINTS'; name: string; resultName: string };
  glyph?: { name: string; scaleFactor: number; maxPoints: number };
  warp?: {
    association: 'CELLS' | 'POINTS';
    name: string;
    scaleFactor: number;
    normal?: [number, number, number];
    useNormal?: boolean;
  };
  transform?: { translate: [number, number, number]; rotate: [number, number, number]; scale: [number, number, number] };
  reflect?: { origin: [number, number, number]; normal: [number, number, number]; copyInput: boolean };
  shrink?: { factor: number };
  plotOverLine?: { point1: [number, number, number]; point2: [number, number, number]; resolution: number };
  diagnostic?: DiagnosticSettings;
  selection?: SelectionRecipe;
  resample?: { dimensions: [number, number, number] };
  volume?: VolumeSettings;
  volumeCapabilities?: { supported: boolean; scalarArrays: { name: string; association: 'CELLS' | 'POINTS'; range: [number, number] }[]; reason?: string };
  manipulatorAvailable: boolean;
  manipulatorVisible: boolean;
}

export interface ParaViewWorkbenchState {
  caseName: string;
  version: string;
  selectedId: string;
  dataRevision: number;
  pipeline: ParaViewPipelineNode[];
  arrays: ParaViewArrayInfo[];
  times: number[];
  time: number;
  points: number;
  cells: number;
  bounds: [number, number, number, number, number, number];
  presets: string[];
  availableFilters: ParaViewNodeType[];
  reader: ParaViewReaderState;
  view: ParaViewViewState;
  /** Movie writers this ParaView build has ('mp4' through Media Foundation on Windows). */
  videoFormats?: VideoFormat[];
  analysisCapabilities?: { probe: boolean; findData: boolean; cfd: boolean; resample: boolean };
}

// A persistent pvpython process owns the ParaView pipeline. The browser can
// request only these app-defined operations; no Python or arbitrary property
// names ever cross the API boundary.
const WORKER_SCRIPT = String.raw`
import json, math, os, sys, traceback
from collections import OrderedDict

# Loading paraview.simple is the long pole of a cold start: hundreds of
# megabytes of VTK and Qt libraries, minutes on a first run. Announcing each
# phase before entering it is what lets the workbench show real progress
# instead of a spinner that cannot say whether anything is happening.
def stage(name):
    sys.stdout.write('__OFSTUDIO_JSON__' + json.dumps({'id': -1, 'stage': name}) + '\n')
    sys.stdout.flush()

stage('interpreter')
from paraview.simple import *
stage('engine')

PREFIX = '__OFSTUDIO_JSON__'
marker, output_dir, case_name, pv_version = sys.argv[1:5]
try:
    from paraview import servermanager as _servermanager
    _manager = _servermanager.vtkSMProxyManager
    pv_version = '%d.%d.%d' % (_manager.GetVersionMajor(), _manager.GetVersionMinor(), _manager.GetVersionPatch())
except Exception:
    pass
case_root = os.path.realpath(os.path.dirname(marker))
nodes = OrderedDict()
guides = {}
legend_bars = {}
data_revision = 0
selected_id = 'reader'
current_time = 0.0
next_filter = 1
background_name = 'ParaView Dark'
manipulator_visible = False

SUPPORTED_CASE_FILE_EXTENSIONS = {
    '.stl', '.obj', '.ply', '.vtk', '.vtp', '.vtu', '.vti', '.vtr', '.vts',
    '.pvd', '.vtm', '.vtmb', '.xmf', '.xdmf', '.case', '.csv', '.foam',
    '.openfoam', '.ex2', '.e',
}

# The display representations the workbench offers, in menu order. Each item
# offers only those its own display lists as available (Feature Edges draws
# the silhouette and sharp edges of a surface, as in ParaView's own menu).
DISPLAY_REPRESENTATIONS = ('Surface', 'Surface With Edges', 'Wireframe', 'Feature Edges', 'Points', 'Outline', 'Volume')

def representations_for(display):
    try:
        available = [str(value) for value in list(display.GetProperty('Representation').Available)]
    except Exception:
        available = []
    offered = [name for name in DISPLAY_REPRESENTATIONS if name in available]
    return offered or [name for name in DISPLAY_REPRESENTATIONS if name not in ('Feature Edges', 'Volume')]

BACKGROUNDS = {
    'ParaView Dark': [0.18, 0.20, 0.24],
    'Midnight': [0.025, 0.045, 0.085],
    'Slate': [0.30, 0.34, 0.40],
    'White': [1.0, 1.0, 1.0],
}

PRESETS = [
    'Cool to Warm', 'Viridis (matplotlib)', 'Plasma (matplotlib)',
    'Rainbow Desaturated', 'Blue to Red Rainbow', 'Black-Body Radiation',
    'X Ray', 'Fast'
]

def emit(identifier, ok, result=None, error=None):
    payload = {'id': identifier, 'ok': ok}
    if result is not None: payload['result'] = result
    if error is not None: payload['error'] = error
    sys.stdout.write(PREFIX + json.dumps(payload, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def clean_number(value, fallback=0.0):
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except Exception:
        return fallback

def vector(value, fallback):
    if not isinstance(value, list) or len(value) != 3:
        return list(fallback)
    return [clean_number(value[i], fallback[i]) for i in range(3)]

def resolve_case_file(relative_path):
    requested = str(relative_path or '')
    if not requested or len(requested) > 1024 or '\\' in requested or requested.startswith('/'):
        raise RuntimeError('Choose a file inside the active case.')
    parts = requested.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise RuntimeError('The file path must remain inside the active case.')
    candidate = os.path.realpath(os.path.join(case_root, *parts))
    try:
        inside = os.path.normcase(os.path.commonpath([case_root, candidate])) == os.path.normcase(case_root)
    except Exception:
        inside = False
    if not inside or not os.path.isfile(candidate):
        raise RuntimeError('The selected file is not inside the active case.')
    extension = os.path.splitext(candidate)[1].lower()
    if extension not in SUPPORTED_CASE_FILE_EXTENSIONS:
        raise RuntimeError('That file type is not supported by the ParaView workbench.')
    return candidate, '/'.join(parts)

def list_case_files():
    result = []
    marker_real = os.path.normcase(os.path.realpath(marker))
    for directory, directory_names, file_names in os.walk(case_root, followlinks=False):
        directory_names[:] = [name for name in directory_names if not os.path.islink(os.path.join(directory, name))]
        for name in file_names:
            candidate = os.path.join(directory, name)
            extension = os.path.splitext(name)[1].lower()
            if extension not in SUPPORTED_CASE_FILE_EXTENSIONS: continue
            try:
                resolved = os.path.realpath(candidate)
                if os.path.normcase(resolved) == marker_real: continue
                if os.path.normcase(os.path.commonpath([case_root, resolved])) != os.path.normcase(case_root): continue
                if not os.path.isfile(resolved): continue
                relative = os.path.relpath(candidate, case_root).replace(os.sep, '/')
                result.append({'path': relative, 'name': name, 'extension': extension[1:].upper(), 'size': int(os.path.getsize(resolved))})
            except Exception:
                continue
            if len(result) >= 5000: break
        if len(result) >= 5000: break
    return sorted(result, key=lambda item: item['path'].lower())

def available_values(proxy, property_name):
    try:
        return [str(value) for value in list(proxy.GetProperty(property_name).Available)]
    except Exception:
        try: return [str(value) for value in list(getattr(proxy, property_name).Available)]
        except Exception: return []

def property_value(proxy, property_name, fallback=None):
    try:
        value = getattr(proxy, property_name)
        values = list(value)
        return values[0] if len(values) == 1 else values
    except Exception:
        try: return getattr(proxy, property_name)
        except Exception: return fallback

def set_if_supported(proxy, property_name, value):
    try:
        setattr(proxy, property_name, value)
        return True
    except Exception:
        return False

def reader_metadata():
    case_types = available_values(reader, 'CaseType')
    current = property_value(reader, 'CaseType', 'Reconstructed Case')
    if not isinstance(current, str): current = str(current)
    regions = available_values(reader, 'MeshRegions')
    selected = property_value(reader, 'MeshRegions', [])
    if isinstance(selected, str): selected = [selected]
    selected = [str(value) for value in (selected or [])]
    case_dir = os.path.dirname(marker)
    try:
        processor_count = sum(1 for name in os.listdir(case_dir) if name.startswith('processor') and name[9:].isdigit() and os.path.isdir(os.path.join(case_dir, name)))
        decomposed = processor_count > 0
    except Exception:
        decomposed = False
        processor_count = 0
    return {
        'caseType': current,
        'caseTypes': case_types or [current],
        'decomposedAvailable': decomposed,
        'processorCount': processor_count,
        'regions': regions,
        'selectedRegions': selected,
        # OpenFOAM readers commonly expose the initial 0 directory as a time.
        # It is input data, not a solver result, so mesh-only cases should not
        # present animation controls as if a transient result existed.
        'hasTimeSteps': any(abs(value) > 1e-12 for value in raw_times),
        'bounds': bounds_for(reader),
    }

def view_metadata():
    return {
        'orientationAxes': bool(property_value(view, 'OrientationAxesVisibility', True)),
        'centerAxes': bool(property_value(view, 'CenterAxesVisibility', False)),
        'parallelProjection': bool(property_value(view, 'CameraParallelProjection', False)),
        'background': background_name,
    }

def bounds_for(proxy):
    try:
        values = list(proxy.GetDataInformation().GetBounds())
        if len(values) == 6 and all(math.isfinite(float(v)) for v in values):
            return [float(v) for v in values]
    except Exception:
        pass
    return [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]

def arrays_for(proxy):
    result = []
    try:
        info = proxy.GetDataInformation()
        for association, getter in [('CELLS', info.GetCellDataInformation), ('POINTS', info.GetPointDataInformation)]:
            attrs = getter()
            for index in range(attrs.GetNumberOfArrays()):
                array = attrs.GetArrayInformation(index)
                if array is None or not array.GetName(): continue
                components = int(array.GetNumberOfComponents())
                component = -1 if components > 1 else 0
                lo, hi = array.GetComponentRange(component)
                result.append({
                    'name': str(array.GetName()), 'association': association,
                    'components': components,
                    'range': [clean_number(lo), clean_number(hi)],
                })
    except Exception:
        pass
    return result

def local_data(proxy):
    algorithm = proxy.GetClientSideObject()
    output = algorithm.GetOutputDataObject(0) if algorithm is not None else None
    if output is None: raise RuntimeError('This local ParaView source does not expose numerical data.')
    return output

def data_blocks(output):
    if not output.IsA('vtkCompositeDataSet'):
        return [(0, 'Output', output)], False
    from vtkmodules.vtkCommonDataModel import vtkCompositeDataSet
    iterator = output.NewIterator()
    iterator.SkipEmptyNodesOn()
    if hasattr(iterator, 'VisitOnlyLeavesOn'): iterator.VisitOnlyLeavesOn()
    result = []
    iterator.InitTraversal()
    while not iterator.IsDoneWithTraversal():
        block = iterator.GetCurrentDataObject()
        if block is not None and not block.IsA('vtkCompositeDataSet'):
            if len(result) >= 256: return result, True
            index = int(iterator.GetCurrentFlatIndex())
            metadata = iterator.GetCurrentMetaData()
            name = metadata.Get(vtkCompositeDataSet.NAME()) if metadata and metadata.Has(vtkCompositeDataSet.NAME()) else None
            result.append((index, str(name or ('Block ' + str(index)))[:120], block))
        iterator.GoToNextItem()
    return result, False

def data_attributes(block, association):
    if association == 'ROWS' and block.IsA('vtkTable'): return block.GetRowData(), int(block.GetNumberOfRows())
    if association == 'POINTS' and block.IsA('vtkDataSet'): return block.GetPointData(), int(block.GetNumberOfPoints())
    if association == 'CELLS' and block.IsA('vtkDataSet'): return block.GetCellData(), int(block.GetNumberOfCells())
    raise RuntimeError('That data association is not available on this block.')

def data_columns(block, association):
    attributes, count = data_attributes(block, association)
    columns = [{'index': 0, 'label': 'Row index', 'name': 'Row index', 'kind': 'index', 'component': 0}]
    accessors = [(None, 0, 'index')]
    if association == 'POINTS':
        for component, axis in enumerate(('X', 'Y', 'Z')):
            columns.append({'index': len(columns), 'label': 'Coordinate ' + axis, 'name': 'Coordinate ' + axis, 'kind': 'coordinate', 'component': component})
            accessors.append((None, component, 'coordinate'))
    skipped = 0
    limited = False
    for index in range(attributes.GetNumberOfArrays()):
        if len(columns) >= 128:
            limited = True
            break
        array = attributes.GetAbstractArray(index)
        if array is None or not array.IsA('vtkDataArray'):
            skipped += 1
            continue
        components = int(array.GetNumberOfComponents())
        name = str(array.GetName() or ('Array ' + str(index)))[:160]
        offered = list(range(min(components, 16))) + ([-1] if 1 < components <= 16 else [])
        if components > 16: limited = True
        for component in offered:
            if len(columns) >= 128:
                limited = True
                break
            label = name if components == 1 else name + (' (Magnitude)' if component == -1 else ' [' + str(component) + ']')
            columns.append({'index': len(columns), 'label': label, 'name': name, 'kind': 'array', 'component': component})
            accessors.append((array, component, 'array'))
    return columns, accessors, count, limited, skipped

def data_integer(value, name, maximum=2147483647):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > maximum:
        raise RuntimeError('Invalid data ' + name + '.')
    return value

def data_table(data):
    identifier = str(data.get('id', ''))
    if identifier not in nodes: raise RuntimeError('The pipeline output has changed. Refresh its data.')
    if data_integer(data.get('revision'), 'revision') != data_revision or data.get('time') != current_time:
        raise RuntimeError('The pipeline data has changed. Refresh its data.')
    mode = data.get('mode')
    if mode not in ('schema', 'page', 'chart', 'export'): raise RuntimeError('Unsupported data mode.')
    proxy = nodes[identifier]['proxy']
    update_node_output(identifier)
    blocks, blocks_limited = data_blocks(local_data(proxy))
    if not blocks: raise RuntimeError('The selected output has no data blocks.')
    requested_block = data_integer(data.get('block', blocks[0][0]), 'block')
    chosen = next((item for item in blocks if item[0] == requested_block), None)
    if chosen is None: raise RuntimeError('That data block is no longer available.')
    block = chosen[2]
    associations = ['ROWS'] if block.IsA('vtkTable') else ['POINTS', 'CELLS'] if block.IsA('vtkDataSet') else []
    if not associations: raise RuntimeError('This block has no supported numeric table.')
    default_association = associations[0]
    if 'POINTS' in associations and 'CELLS' in associations:
        point_arrays = block.GetPointData()
        has_point_values = any(point_arrays.GetAbstractArray(i).IsA('vtkDataArray') and
            point_arrays.GetAbstractArray(i).GetName() != 'vtkValidPointMask' for i in range(point_arrays.GetNumberOfArrays()))
        cell_arrays = block.GetCellData()
        has_cell_values = any(cell_arrays.GetAbstractArray(i).IsA('vtkDataArray') for i in range(cell_arrays.GetNumberOfArrays()))
        if not has_point_values and has_cell_values: default_association = 'CELLS'
    association = data.get('association', default_association)
    if association not in associations: raise RuntimeError('Unsupported data association for this block.')
    columns, accessors, total, columns_limited, skipped = data_columns(block, association)
    requested = data.get('columns', list(range(min(12, len(columns)))))
    if not isinstance(requested, list) or not 1 <= len(requested) <= 16: raise RuntimeError('Choose between 1 and 16 numeric columns.')
    requested = list(dict.fromkeys(data_integer(value, 'column', len(columns)-1) for value in requested))
    offset = data_integer(data.get('offset', 0), 'offset')
    row_limit = 200 if mode == 'page' else 20000 if mode == 'chart' else 200000 if mode == 'export' else 0
    row_limit = min(row_limit, 1000000 // len(requested))
    attributes, _ = data_attributes(block, association)
    mask = attributes.GetArray('vtkValidPointMask') if association == 'POINTS' else None
    rows, invalid_rows, nonfinite = [], 0, 0
    byte_count = 0
    for index in range(min(offset, total), min(total, offset + row_limit)):
        invalid = mask is not None and (index >= mask.GetNumberOfTuples() or mask.GetComponent(index, 0) != 1)
        row_nonfinite = 0
        row = []
        for column in requested:
            array, component, kind = accessors[column]
            if kind == 'index': value = index
            elif kind == 'coordinate': value = block.GetPoint(index)[component]
            elif index >= array.GetNumberOfTuples() or (invalid and columns[column]['name'] not in ('arc_length', 'vtkValidPointMask')):
                value = None
            else:
                if component == -1:
                    value = math.hypot(*(array.GetComponent(index, i) for i in range(array.GetNumberOfComponents())))
                else: value = array.GetComponent(index, component)
            if value is not None and not math.isfinite(value):
                row_nonfinite += 1
                value = None
            row.append(value)
        byte_count += len(json.dumps(row, separators=(',', ':')))
        if byte_count > 4000000: break
        rows.append(row)
        if invalid: invalid_rows += 1
        nonfinite += row_nonfinite
    return {
        'id': identifier, 'revision': data_revision, 'time': current_time,
        'block': chosen[0], 'blocks': [{'index': item[0], 'label': item[1]} for item in blocks], 'blocksLimited': blocks_limited,
        'association': association, 'associations': associations, 'columns': columns,
        'columnsLimited': columns_limited, 'nonNumericColumns': skipped, 'selectedColumns': requested,
        'rows': rows, 'totalRows': total, 'offset': min(offset, total),
        'limited': mode != 'schema' and (offset > 0 or len(rows) < total),
        'invalidRows': invalid_rows, 'nonFiniteValues': nonfinite, 'rowLimit': row_limit,
    }

ANALYSIS_SCAN_LIMIT = 200000
SELECTION_EXTRACT_LIMIT = 20000

def analysis_source(data, require_selected=True):
    identifier = data.get('id')
    if identifier not in nodes or (require_selected and identifier != selected_id): raise RuntimeError('The selected pipeline item changed. Refresh the analysis.')
    if data.get('revision') != data_revision or data.get('time') != current_time: raise RuntimeError('The pipeline or timestep changed. Refresh the analysis.')
    update_node_output(identifier)
    return identifier, nodes[identifier]['proxy']

def analysis_block(proxy, index):
    blocks, limited = data_blocks(local_data(proxy))
    item = next((block for block in blocks if block[0] == index), None)
    if item is None or not item[2].IsA('vtkDataSet'): raise RuntimeError('Choose a geometric data block.')
    return item[2]

def analysis_probe(data):
    identifier, proxy = analysis_source(data)
    block = analysis_block(proxy, data['block'])
    association = data['association']
    attributes, _ = data_attributes(block, association)
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkFiltersCore import vtkProbeFilter
    source = block.NewInstance(); source.ShallowCopy(block)
    # Explicitly select the interpolation semantics. Point arrays interpolate;
    # cell arrays keep the containing cell's value, never an invented average.
    if association == 'POINTS': source.GetCellData().Initialize()
    else: source.GetPointData().Initialize()
    points = vtkPoints(); points.SetDataTypeToDouble(); points.InsertNextPoint(*data['position'])
    cloud = vtkPolyData(); cloud.SetPoints(points)
    probe = vtkProbeFilter(); probe.SetInputData(cloud); probe.SetSourceData(source); probe.Update()
    output = probe.GetOutput().GetPointData()
    mask = output.GetArray('vtkValidPointMask')
    inside = mask is not None and mask.GetNumberOfTuples() > 0 and mask.GetComponent(0, 0) == 1
    values, limited = [], False
    for index in range(attributes.GetNumberOfArrays()):
        original = attributes.GetArray(index)
        if original is None or not original.GetName() or original.GetName() == 'vtkValidPointMask': continue
        if len(values) >= 16 or original.GetNumberOfComponents() > 16: limited = True; continue
        array = output.GetArray(original.GetName())
        numbers = [array.GetComponent(0, component) if inside and array is not None and array.GetNumberOfTuples() else None for component in range(original.GetNumberOfComponents())]
        numbers = [value if value is not None and math.isfinite(value) else None for value in numbers]
        magnitude = math.hypot(*numbers) if numbers and all(value is not None for value in numbers) else None
        if magnitude is not None and not math.isfinite(magnitude): magnitude = None
        values.append({'name': original.GetName(), 'components': numbers, 'magnitude': magnitude})
    return {'id': identifier, 'revision': data_revision, 'time': current_time, 'block': data['block'], 'association': association,
        'position': data['position'], 'inside': inside, 'values': values, 'limited': limited,
        'note': 'Point values are interpolated within the source cell.' if association == 'POINTS' else 'Cell values belong to the containing cell; no point interpolation is applied.'}

def matching_selection(proxy, settings, include_ids=False):
    block = analysis_block(proxy, settings['block'])
    attributes, total = data_attributes(block, settings['association'])
    array = attributes.GetArray(settings['name'])
    if array is None or not array.IsA('vtkDataArray'): raise RuntimeError('That numeric array is unavailable in this block.')
    components = array.GetNumberOfComponents(); component = settings['component']
    if component < -1 or component >= components or components > 16: raise RuntimeError('That component is unavailable.')
    mask = attributes.GetArray('vtkValidPointMask') if settings['association'] == 'POINTS' else None
    rows, matches, scanned, ids = [], 0, min(total, ANALYSIS_SCAN_LIMIT), []
    for index in range(scanned):
        if index >= array.GetNumberOfTuples() or (mask is not None and (index >= mask.GetNumberOfTuples() or mask.GetComponent(index, 0) != 1)): continue
        value = math.hypot(*(array.GetComponent(index, i) for i in range(components))) if component == -1 else array.GetComponent(index, component)
        if not math.isfinite(value) or value < settings['lower'] or value > settings['upper']: continue
        matches += 1
        if include_ids and len(ids) < SELECTION_EXTRACT_LIMIT: ids.append(index)
        if len(rows) < 200:
            if settings['association'] == 'POINTS': coordinate = block.GetPoint(index)
            else:
                # Compute only displayed cell centers, never a full CellCenters
                # dataset for millions of input cells during a bounded scan.
                from vtkmodules.vtkCommonCore import reference
                cell = block.GetCell(index); parametric = [0.0, 0.0, 0.0]; coordinate = [0.0, 0.0, 0.0]
                sub_id = reference(cell.GetParametricCenter(parametric))
                if cell.GetNumberOfPoints() > 10000: coordinate = [None, None, None]
                else: cell.EvaluateLocation(sub_id, parametric, coordinate, [0.0] * cell.GetNumberOfPoints())
            coordinate = [value if value is not None and math.isfinite(value) else None for value in coordinate]
            rows.append({'index': index, 'coordinate': coordinate, 'value': value})
    if include_ids and (scanned < total or matches > SELECTION_EXTRACT_LIMIT): raise RuntimeError('Narrow the selection: extraction requires a complete scan of at most 200,000 tuples and at most 20,000 matches.')
    return block, ids, {'rows': rows, 'matched': matches, 'scanned': scanned, 'total': total, 'limited': scanned < total or matches > len(rows), 'scanLimited': scanned < total}

def find_data(data):
    identifier, proxy = analysis_source(data)
    _, _, result = matching_selection(proxy, data)
    return dict(data, **result)

def selection_output(parent_id, settings):
    block, ids, _ = matching_selection(nodes[parent_id]['proxy'], settings, True)
    from vtkmodules.vtkCommonCore import vtkIdTypeArray
    from vtkmodules.vtkCommonDataModel import vtkSelection, vtkSelectionNode
    from vtkmodules.vtkFiltersExtraction import vtkExtractSelection
    array = vtkIdTypeArray()
    for identifier in ids: array.InsertNextValue(identifier)
    item = vtkSelectionNode(); item.SetContentType(vtkSelectionNode.INDICES)
    item.SetFieldType(vtkSelectionNode.POINT if settings['association'] == 'POINTS' else vtkSelectionNode.CELL)
    item.SetSelectionList(array); selection = vtkSelection(); selection.AddNode(item)
    extract = vtkExtractSelection(); extract.SetInputData(0, block); extract.SetInputData(1, selection); extract.Update()
    output = extract.GetOutput().NewInstance(); output.ShallowCopy(extract.GetOutput())
    return output

def update_node_output(identifier, visited=None):
    if visited is None: visited = set()
    if identifier in visited: return
    node = nodes[identifier]
    if node['parent'] is not None: update_node_output(node['parent'], visited)
    if node['type'] == 'Selection': node['proxy'].GetClientSideObject().SetOutput(selection_output(node['parent'], node['selection']))
    node['proxy'].UpdatePipeline(time=current_time)
    visited.add(identifier)

def create_selection(settings):
    parent_id = selected_id
    output = selection_output(parent_id, settings)
    proxy = TrivialProducer(registrationName='Selected Data')
    try:
        proxy.GetClientSideObject().SetOutput(output)
        register_filter('Selection', proxy, parent_id, {'selection': settings})
    except Exception:
        try: Delete(proxy)
        except Exception: pass
        raise

def apply_diagnostic(proxy, parent_id, settings):
    chosen = next((array for array in arrays_for(nodes[parent_id]['proxy']) if array['association'] == settings['association'] and array['name'] == settings['name'] and array['components'] == 3), None)
    if chosen is None: raise RuntimeError('CFD diagnostics require a three-component vector from the chosen association.')
    required = ('ScalarArray', 'ComputeGradient', 'ComputeVorticity', 'ComputeDivergence', 'ComputeQCriterion', 'ResultArrayName', 'VorticityArrayName', 'DivergenceArrayName', 'QCriterionArrayName')
    if any(name not in proxy.ListProperties() for name in required): raise RuntimeError('This ParaView Gradient filter does not expose the requested vector diagnostics.')
    proxy.ScalarArray = [settings['association'], settings['name']]
    proxy.ComputeGradient = 1; proxy.ComputeVorticity = 1; proxy.ComputeDivergence = 1; proxy.ComputeQCriterion = 1
    proxy.ResultArrayName = settings['prefix'] + 'Gradient'; proxy.VorticityArrayName = settings['prefix'] + 'Vorticity'
    proxy.DivergenceArrayName = settings['prefix'] + 'Divergence'; proxy.QCriterionArrayName = settings['prefix'] + 'QCriterion'
    proxy.UpdatePipeline(time=current_time)
    names = {array['name'] for array in arrays_for(proxy)}
    if any(settings['prefix'] + suffix not in names for suffix in ('Gradient', 'Vorticity', 'Divergence', 'QCriterion')): raise RuntimeError('ParaView could not compute all vector diagnostics for this input.')

def create_diagnostic(settings):
    parent_id = selected_id
    proxy = make_filter(('Gradient', 'GradientOfUnstructuredDataSet'), {'registrationName': 'CFD Diagnostics', 'Input': nodes[parent_id]['proxy']})
    try:
        apply_diagnostic(proxy, parent_id, settings)
        register_filter('CFDGradient', proxy, parent_id, {'diagnostic': settings})
    except Exception:
        try: Delete(proxy)
        except Exception: pass
        raise

def create_resample(dimensions):
    parent_id = selected_id
    bounds = bounds_for(nodes[parent_id]['proxy'])
    if any(bounds[i+1] <= bounds[i] for i in (0, 2, 4)): raise RuntimeError('Resampling requires nonzero XYZ bounds.')
    proxy = make_filter(('ResampleToImage',), {'registrationName': 'Resample to Image', 'Input': nodes[parent_id]['proxy']})
    try:
        proxy.UseInputBounds = 1; proxy.SamplingDimensions = dimensions
        register_filter('ResampleToImage', proxy, parent_id, {'resample': {'dimensions': dimensions}})
    except Exception:
        try: Delete(proxy)
        except Exception: pass
        raise

def validate_volume(raw):
    if not isinstance(raw, dict) or set(raw) != {'opacityPoints', 'unitDistance'}: raise RuntimeError('Invalid volume opacity settings.')
    distance = raw['unitDistance']; points = raw['opacityPoints']
    if not isinstance(distance, (float, int)) or isinstance(distance, bool) or not math.isfinite(distance) or not 1e-12 <= distance <= 1e15: raise RuntimeError('Opacity unit distance must be positive.')
    if not isinstance(points, list) or not 2 <= len(points) <= 16: raise RuntimeError('Use between two and sixteen opacity points.')
    last = -float('inf')
    for point in points:
        if not isinstance(point, list) or len(point) != 2 or any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) for value in point): raise RuntimeError('Invalid opacity point.')
        if point[0] <= last or abs(point[0]) > 1e15 or not 0 <= point[1] <= 1: raise RuntimeError('Opacity points must increase with opacity between zero and one.')
        last = point[0]
    return raw

def capture_volume(node):
    settings = node.get('volume')
    if settings is None: return None
    try:
        values = list(node['display'].ScalarOpacityFunction.Points)
        distance = float(node['display'].ScalarOpacityUnitDistance)
        return validate_volume({'opacityPoints': [[values[index], values[index+1]] for index in range(0, len(values), 4)], 'unitDistance': distance})
    except Exception:
        return settings

def volume_capabilities(node):
    scalars = [array for array in arrays_for(node['proxy']) if array['components'] == 1 and array['name'] != 'vtkValidPointMask']
    supported = node['display'] is not None and 'Volume' in representations_for(node['display'])
    if supported:
        blocks, _ = data_blocks(local_data(node['proxy']))
        supported = any(block.IsA('vtkDataSet') and any(block.GetCell(index).GetCellDimension() == 3 for index in range(min(32, block.GetNumberOfCells()))) for _, _, block in blocks)
    return {'supported': supported, 'scalarArrays': scalars, 'reason': '' if supported else 'Volume requires a supported three-dimensional cell dataset. Try the volume mesh or Resample to Image.'}

def changed_state():
    global data_revision
    data_revision += 1
    return state()

def node_state(identifier, node):
    state = {
        'id': identifier, 'label': node['label'], 'type': node['type'],
        'parent': node['parent'], 'visible': node['visible'],
        'renderable': node['display'] is not None,
        'representation': node['representation'], 'opacity': node['opacity'],
        'lineWidth': node['lineWidth'], 'pointSize': node['pointSize'],
        'color': node['color'],
        'representations': representations_for(node['display']) if node['display'] is not None else [],
        'manipulatorAvailable': node['type'] in ('Slice', 'Clip', 'StreamTracer', 'PlotOverLine'),
        'manipulatorVisible': manipulator_visible and identifier == selected_id,
    }
    if node.get('filePath'): state['filePath'] = node['filePath']
    for name in ('diagnostic', 'selection', 'resample'):
        if name in node: state[name] = node[name]
    if 'volume' in node: state['volume'] = capture_volume(node)
    state['volumeCapabilities'] = volume_capabilities(node)
    proxy = node['proxy']
    if node['type'] == 'Slice':
        state['origin'] = list(proxy.SliceType.Origin)
        state['normal'] = list(proxy.SliceType.Normal)
    elif node['type'] == 'Clip':
        state['origin'] = list(proxy.ClipType.Origin)
        state['normal'] = list(proxy.ClipType.Normal)
        state['invert'] = bool(proxy.Invert)
    elif node['type'] == 'Contour':
        state['contour'] = node['contour']
    elif node['type'] == 'Threshold':
        state['threshold'] = node['threshold']
    elif node['type'] == 'StreamTracer':
        state['streamTracer'] = node['streamTracer']
    elif node['type'] == 'Tube':
        state['tube'] = node['tube']
    elif node['type'] == 'Calculator':
        state['calculator'] = node['calculator']
    elif node['type'] == 'Gradient':
        state['gradient'] = node['gradient']
    elif node['type'] == 'Glyph':
        state['glyph'] = node['glyph']
    elif node['type'] in ('WarpByVector', 'WarpByScalar'):
        state['warp'] = node['warp']
    elif node['type'] == 'Transform':
        state['transform'] = node['transform']
    elif node['type'] == 'Reflect':
        state['reflect'] = node['reflect']
    elif node['type'] == 'Shrink':
        state['shrink'] = node['shrink']
    elif node['type'] == 'PlotOverLine':
        state['plotOverLine'] = node['plotOverLine']
    return state

def state():
    active = nodes[selected_id]['proxy']
    update_node_output(selected_id)
    sync_legends()
    info = active.GetDataInformation()
    return {
        'caseName': case_name, 'version': pv_version, 'selectedId': selected_id,
        'dataRevision': data_revision,
        'pipeline': [node_state(identifier, node) for identifier, node in nodes.items()],
        'arrays': arrays_for(active), 'times': times, 'time': current_time,
        'points': int(info.GetNumberOfPoints()), 'cells': int(info.GetNumberOfCells()),
        'bounds': bounds_for(active), 'presets': available_presets,
        'availableFilters': filter_capabilities(),
        'reader': reader_metadata(), 'view': view_metadata(),
        'videoFormats': supported_video_formats,
        'analysisCapabilities': {'probe': True, 'findData': True, 'cfd': any(globals().get(name) is not None for name in ('Gradient', 'GradientOfUnstructuredDataSet')), 'resample': globals().get('ResampleToImage') is not None},
    }

def sync_legends():
    # A colour map is shared by its displays. Keep its bar if any visible
    # display requests it, and hide tracked bars whose arrays were replaced.
    wanted = set()
    for node in nodes.values():
        color = node['color']
        if not node['visible'] or not color['legend'] or color['association'] not in ('CELLS', 'POINTS') or not color['name']:
            continue
        if not any(a['association'] == color['association'] and a['name'] == color['name'] for a in arrays_for(node['proxy'])):
            continue
        try:
            lut = node['display'].LookupTable
            if lut is None: continue
            wanted.add(lut)
            if lut not in legend_bars:
                node['display'].SetScalarBarVisibility(view, True)
                legend_bars[lut] = GetScalarBar(lut, view)
        except Exception:
            continue
    for lut, bar in legend_bars.items():
        set_if_supported(bar, 'Visibility', 1 if lut in wanted else 0)

def apply_display(node):
    display = node['display']
    if display is None: return
    display.Representation = node['representation']
    display.Opacity = node['opacity']
    display.Visibility = 1 if node['visible'] else 0
    set_if_supported(display, 'LineWidth', node['lineWidth'])
    set_if_supported(display, 'PointSize', node['pointSize'])
    set_if_supported(display, 'EdgeColor', [0.08, 0.08, 0.08])
    color = node['color']
    if node['representation'] == 'Volume':
        if not volume_capabilities(node)['supported']: raise RuntimeError('Volume rendering is unavailable for this geometry.')
        if not any(array['name'] == color['name'] and array['association'] == color['association'] and array['components'] == 1 for array in arrays_for(node['proxy'])): raise RuntimeError('Volume rendering requires an available scalar field.')
    if 'volume' in node and not set_if_supported(display, 'UseSeparateColorMap', 1): raise RuntimeError('This ParaView display does not support independent volume transfer functions.')
    if color['association'] == 'SOLID' or not color['name']:
        # ParaView 6 raises "invalid association NONE" from ColorBy(None) for
        # OpenFOAM meshes without result arrays. Setting ColorArrayName is the
        # cross-version equivalent and keeps all representations available.
        try: display.ColorArrayName = [None, '']
        except Exception:
            try: ColorBy(display, None)
            except Exception: pass
        return
    if color['association'] == 'BLOCKS':
        try: ColorBy(display, ('FIELD', 'vtkBlockColors'))
        except Exception:
            try: display.ColorArrayName = [None, '']
            except Exception: pass
        return
    ColorBy(display, (color['association'], color['name']))
    try:
        display.RescaleTransferFunctionToDataRange(True, False)
        lut = display.LookupTable or GetColorTransferFunction(color['name'])
        if color['preset'] in available_presets: lut.ApplyPreset(color['preset'], True)
    except Exception:
        pass
    if 'volume' in node:
        settings = validate_volume(node['volume'])
        opacity = GetOpacityTransferFunction(color['name'], display, separate=True)
        opacity.Points = [value for point in settings['opacityPoints'] for value in (point[0], point[1], 0.5, 0.0)]
        display.ScalarOpacityFunction = opacity
        if not set_if_supported(display, 'ScalarOpacityUnitDistance', settings['unitDistance']): raise RuntimeError('This display does not support volume opacity distance.')

def render(identifier, width, height, quality=92):
    sync_legends()
    width = max(320, min(1920, int(width or 1000)))
    height = max(240, min(1200, int(height or 700)))
    quality = max(35, min(95, int(quality or 92)))
    view.ViewSize = [width, height]
    filename = os.path.join(output_dir, 'render_' + str(identifier) + '.jpg')
    # SaveScreenshot performs the render itself. Calling Render immediately
    # before it doubles the work and is especially noticeable while dragging.
    try: SaveScreenshot(filename, view, ImageResolution=[width, height], Quality=quality)
    except TypeError: SaveScreenshot(filename, view, ImageResolution=[width, height])
    return filename

def set_time(value):
    global current_time
    if not times: return
    target = clean_number(value, current_time)
    current_time = min(times, key=lambda item: abs(item - target))
    scene.AnimationTime = current_time
    view.ViewTime = current_time
    visited = set()
    for identifier in nodes: update_node_output(identifier, visited)
    for node in nodes.values(): apply_display(node)
    sync_legends()

def refresh_reader(follow_latest=True):
    global times, current_time, raw_times
    try: reader.Refresh()
    except Exception: pass
    reader.UpdatePipelineInformation()
    for property_name in ('CellArrays', 'PointArrays'):
        values = available_values(reader, property_name)
        if values: set_if_supported(reader, property_name, values)
    raw_times = [float(v) for v in list(reader.TimestepValues)]
    times = raw_times if raw_times else [0.0]
    # Follow a newly written solver result, which is the useful meaning of
    # Refresh in a post-processing workbench.
    set_time(times[-1] if follow_latest else current_time)
    scene.UpdateAnimationUsingDataTimeSteps()

def update_reader(data):
    global current_time
    reset_camera = False
    if 'caseType' in data:
        requested = str(data.get('caseType', ''))
        available = available_values(reader, 'CaseType')
        if requested not in available:
            raise RuntimeError('This ParaView build does not support that OpenFOAM case mode.')
        if requested == 'Decomposed Case' and not reader_metadata()['decomposedAvailable']:
            raise RuntimeError('No processor directories were found for the decomposed case.')
        reader.CaseType = requested
        reader.UpdatePipelineInformation()
        reset_camera = True
    available_regions = available_values(reader, 'MeshRegions')
    if 'regions' in data:
        requested_regions = data.get('regions') if isinstance(data.get('regions'), list) else []
        selected_regions = [str(value) for value in requested_regions if str(value) in available_regions]
        if not selected_regions:
            raise RuntimeError('Select at least one mesh region or patch.')
        reader.MeshRegions = selected_regions
        reset_camera = True
    refresh_reader(False)
    if reset_camera: ResetCamera(view)

def update_view(data):
    global background_name
    if 'orientationAxes' in data:
        set_if_supported(view, 'OrientationAxesVisibility', 1 if data['orientationAxes'] else 0)
    if 'centerAxes' in data:
        set_if_supported(view, 'CenterAxesVisibility', 1 if data['centerAxes'] else 0)
    if 'parallelProjection' in data:
        set_if_supported(view, 'CameraParallelProjection', 1 if data['parallelProjection'] else 0)
    if 'background' in data:
        requested = str(data['background'])
        if requested not in BACKGROUNDS: raise RuntimeError('Unsupported background preset.')
        background_name = requested
        set_if_supported(view, 'UseColorPaletteForBackground', 0)
        view.Background = BACKGROUNDS[requested]

def selected_node():
    return nodes[selected_id]

def vec_add(a, b): return [a[i] + b[i] for i in range(3)]
def vec_sub(a, b): return [a[i] - b[i] for i in range(3)]
def vec_scale(a, scale): return [a[i] * scale for i in range(3)]
def vec_dot(a, b): return sum(a[i] * b[i] for i in range(3))
def vec_cross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

def vec_normalize(value, fallback=(1.0, 0.0, 0.0)):
    length = math.sqrt(vec_dot(value, value))
    return [component / length for component in value] if length > 1e-15 else list(fallback)

def rotate_vector(value, axis, degrees):
    axis = vec_normalize(axis)
    radians = math.radians(degrees)
    cosine, sine = math.cos(radians), math.sin(radians)
    return vec_add(vec_add(vec_scale(value, cosine), vec_scale(vec_cross(axis, value), sine)), vec_scale(axis, vec_dot(axis, value) * (1.0 - cosine)))

def camera_basis():
    cam = view.GetActiveCamera()
    position, focal = list(cam.GetPosition()), list(cam.GetFocalPoint())
    forward = vec_normalize(vec_sub(focal, position), (0.0, 0.0, -1.0))
    right = vec_normalize(vec_cross(forward, list(cam.GetViewUp())), (1.0, 0.0, 0.0))
    up = vec_normalize(vec_cross(right, forward), (0.0, 1.0, 0.0))
    return right, up, forward, math.sqrt(vec_dot(vec_sub(focal, position), vec_sub(focal, position)))

def screen_shift(dx, dy, height):
    right, up, unused, distance = camera_basis()
    cam = view.GetActiveCamera()
    if bool(property_value(view, 'CameraParallelProjection', False)):
        world_per_pixel = 2.0 * clean_number(cam.GetParallelScale(), 1.0) / max(240.0, clean_number(height, 700.0))
    else:
        world_per_pixel = 2.0 * max(distance, 1e-9) * math.tan(math.radians(cam.GetViewAngle()) / 2.0) / max(240.0, clean_number(height, 700.0))
    return vec_add(vec_scale(right, clean_number(dx) * world_per_pixel), vec_scale(up, -clean_number(dy) * world_per_pixel))

def delete_guide(identifier):
    guide = guides.pop(identifier, None)
    if guide:
        try: Delete(guide['proxy'])
        except Exception: pass

def hide_guides():
    for guide in guides.values():
        try: guide['display'].Visibility = 0
        except Exception: pass

def guide_kind(node):
    if node['type'] in ('Slice', 'Clip'): return 'plane'
    if node['type'] == 'StreamTracer': return 'sphere' if node['streamTracer']['seedType'] == 'Point Cloud' else 'line'
    if node['type'] == 'PlotOverLine': return 'line'
    return ''

def ensure_guide(identifier):
    hide_guides()
    if not manipulator_visible or identifier not in nodes: return
    node = nodes[identifier]
    kind = guide_kind(node)
    if not kind: return
    guide = guides.get(identifier)
    if guide and guide['kind'] != kind:
        delete_guide(identifier); guide = None
    if not guide:
        if kind == 'plane': proxy = Plane(registrationName='3D plane manipulator')
        elif kind == 'sphere': proxy = Sphere(registrationName='3D seed manipulator')
        else: proxy = Line(registrationName='3D line manipulator')
        display = Show(proxy, view)
        display.Visibility = 1
        set_if_supported(display, 'Pickable', 0)
        if kind == 'plane':
            display.Representation = 'Surface With Edges'; display.Opacity = 0.28
            set_if_supported(display, 'DiffuseColor', [0.05, 0.85, 1.0]); set_if_supported(display, 'EdgeColor', [1.0, 0.78, 0.08]); set_if_supported(display, 'LineWidth', 2.5)
        elif kind == 'sphere':
            display.Representation = 'Wireframe'; display.Opacity = 0.9
            set_if_supported(display, 'DiffuseColor', [1.0, 0.55, 0.05]); set_if_supported(display, 'LineWidth', 3.0)
        else:
            display.Representation = 'Surface'; display.Opacity = 1.0
            set_if_supported(display, 'DiffuseColor', [1.0, 0.55, 0.05]); set_if_supported(display, 'LineWidth', 5.0)
        guide = {'proxy': proxy, 'display': display, 'kind': kind}
        guides[identifier] = guide
    guide['display'].Visibility = 1
    proxy = guide['proxy']
    if kind == 'plane':
        target = node['proxy'].SliceType if node['type'] == 'Slice' else node['proxy'].ClipType
        center, normal = list(target.Origin), vec_normalize(list(target.Normal))
        bounds = bounds_for(nodes[node['parent']]['proxy'])
        diagonal = math.sqrt((bounds[1]-bounds[0])**2 + (bounds[3]-bounds[2])**2 + (bounds[5]-bounds[4])**2) or 1.0
        reference = [0.0, 0.0, 1.0] if abs(normal[2]) < 0.88 else [0.0, 1.0, 0.0]
        axis1 = vec_normalize(vec_cross(normal, reference)); axis2 = vec_normalize(vec_cross(normal, axis1))
        half = diagonal * 0.55
        proxy.Origin = vec_sub(vec_sub(center, vec_scale(axis1, half)), vec_scale(axis2, half))
        proxy.Point1 = vec_add(proxy.Origin, vec_scale(axis1, half * 2.0))
        proxy.Point2 = vec_add(proxy.Origin, vec_scale(axis2, half * 2.0))
    elif kind == 'sphere':
        settings = node['streamTracer']; proxy.Center = settings['center']; proxy.Radius = max(settings['radius'], 1e-12)
        set_if_supported(proxy, 'ThetaResolution', 24); set_if_supported(proxy, 'PhiResolution', 16)
    else:
        settings = node['streamTracer'] if node['type'] == 'StreamTracer' else node['plotOverLine']
        proxy.Point1 = settings['point1']; proxy.Point2 = settings['point2']
        set_if_supported(proxy, 'Resolution', max(1, min(200, int(settings['resolution']))))
    proxy.UpdatePipeline()

def set_manipulator(enabled):
    global manipulator_visible
    manipulator_visible = bool(enabled) and guide_kind(selected_node()) != ''
    ensure_guide(selected_id)

def manipulate(data):
    node = selected_node()
    if not manipulator_visible or not guide_kind(node): raise RuntimeError('Select a filter with an enabled 3D manipulator first.')
    mode = str(data.get('mode', 'translate'))
    dx, dy = clean_number(data.get('dx')), clean_number(data.get('dy'))
    shift = screen_shift(dx, dy, data.get('height'))
    right, up, unused, unused_distance = camera_basis()
    if node['type'] in ('Slice', 'Clip'):
        target = node['proxy'].SliceType if node['type'] == 'Slice' else node['proxy'].ClipType
        if mode == 'translate': target.Origin = vec_add(list(target.Origin), shift)
        elif mode == 'rotate': target.Normal = vec_normalize(rotate_vector(rotate_vector(list(target.Normal), up, -dx * 0.45), right, -dy * 0.45))
        else: raise RuntimeError('Unsupported plane manipulator mode.')
    elif node['type'] == 'StreamTracer':
        settings = dict(node['streamTracer'])
        if settings['seedType'] == 'Point Cloud':
            if mode == 'translate': settings['center'] = vec_add(settings['center'], shift)
            elif mode == 'scale': settings['radius'] = max(1e-12, settings['radius'] * math.exp((dx - dy) * 0.01))
            else: raise RuntimeError('Unsupported sphere manipulator mode.')
        else:
            if mode == 'translate':
                settings['point1'] = vec_add(settings['point1'], shift); settings['point2'] = vec_add(settings['point2'], shift)
            elif mode == 'point1': settings['point1'] = vec_add(settings['point1'], shift)
            elif mode == 'point2': settings['point2'] = vec_add(settings['point2'], shift)
            else: raise RuntimeError('Unsupported line manipulator mode.')
        node['streamTracer'] = settings; apply_stream(node['proxy'], settings)
    elif node['type'] == 'PlotOverLine':
        settings = dict(node['plotOverLine'])
        if mode == 'translate':
            settings['point1'] = vec_add(settings['point1'], shift); settings['point2'] = vec_add(settings['point2'], shift)
        elif mode == 'point1': settings['point1'] = vec_add(settings['point1'], shift)
        elif mode == 'point2': settings['point2'] = vec_add(settings['point2'], shift)
        else: raise RuntimeError('Unsupported line manipulator mode.')
        node['plotOverLine'] = settings; node['proxy'].Point1 = settings['point1']; node['proxy'].Point2 = settings['point2']
    node['proxy'].UpdatePipeline(time=current_time)
    apply_display(node); ensure_guide(selected_id)

FILTER_LABELS = {
    'CellDatatoPointData': 'Cell Data to Point Data',
    'PointDatatoCellData': 'Point Data to Cell Data',
    'StreamTracer': 'Stream Tracer',
    'ExtractSurface': 'Extract Surface',
    'CellCenters': 'Cell Centers',
    'WarpByVector': 'Warp By Vector',
    'WarpByScalar': 'Warp By Scalar',
    'ExtractEdges': 'Extract Edges',
    'IntegrateVariables': 'Integrate Variables',
    'PlotOverLine': 'Plot Over Line',
    'TemporalStatistics': 'Temporal Statistics',
}

def register_filter(kind, proxy, parent_id, extra=None, hide_parent=True):
    global selected_id, next_filter
    identifier = 'filter-' + str(next_filter)
    label = FILTER_LABELS.get(kind, kind) + str(next_filter)
    next_filter += 1
    proxy.UpdatePipeline(time=current_time)
    parent = nodes[parent_id]
    if hide_parent:
        Hide(parent['proxy'], view)
        parent['visible'] = False
        if parent['display'] is not None: parent['display'].Visibility = 0
    display = Show(proxy, view)
    line_width = 3.0 if kind in ('StreamTracer', 'PlotOverLine', 'ExtractEdges') else 1.0
    representation = 'Points' if kind in ('CellCenters', 'IntegrateVariables') else 'Surface'
    node = {
        'proxy': proxy, 'display': display, 'label': label, 'type': kind,
        'parent': parent_id, 'visible': True, 'representation': representation,
        'opacity': 1.0, 'lineWidth': line_width, 'pointSize': 3.0,
        'color': {'association': 'SOLID', 'name': '', 'preset': available_presets[0] if available_presets else '', 'legend': False},
    }
    if extra: node.update(extra)
    nodes[identifier] = node
    selected_id = identifier
    apply_display(node)
    ensure_guide(identifier)
    return identifier

def open_case_file(relative_path):
    global selected_id, next_filter
    full_path, safe_relative = resolve_case_file(relative_path)
    previous_selected = selected_id
    try:
        proxy = OpenDataFile(full_path)
    except Exception:
        raise RuntimeError('ParaView could not find a compatible reader for that file.')
    if isinstance(proxy, (list, tuple)):
        if len(proxy) != 1: raise RuntimeError('ParaView returned an unexpected reader group for that file.')
        proxy = proxy[0]
    if proxy is None: raise RuntimeError('ParaView could not find a reader for that file.')
    label = os.path.basename(safe_relative)
    identifier = None
    try:
        RenameSource(label, proxy)
    except Exception:
        pass
    try:
        proxy.UpdatePipelineInformation()
        proxy.UpdatePipeline(time=current_time)
        table_only = local_data(proxy).IsA('vtkTable')
        display = None if table_only else Show(proxy, view)
        identifier = 'source-' + str(next_filter)
        next_filter += 1
        nodes[identifier] = {
            'proxy': proxy, 'display': display, 'label': label,
            'type': 'CaseFileReader', 'parent': None, 'filePath': safe_relative,
            'visible': not table_only, 'representation': 'Surface', 'opacity': 1.0,
            'lineWidth': 1.0, 'pointSize': 3.0,
            'color': {'association': 'SOLID', 'name': '', 'preset': available_presets[0] if available_presets else '', 'legend': False},
        }
        selected_id = identifier
        set_manipulator(False)
        apply_display(nodes[identifier])
        if display is not None: ResetCamera(view)
    except Exception:
        if identifier in nodes: del nodes[identifier]
        selected_id = previous_selected
        try: Delete(proxy)
        except Exception: pass
        raise RuntimeError('ParaView could not open that case file with a compatible reader.')

def point_vector_for(parent_id, auto_convert):
    candidates = [a for a in arrays_for(nodes[parent_id]['proxy']) if a['association'] == 'POINTS' and a['components'] >= 2]
    if candidates: return parent_id, candidates[0]
    cells = [a for a in arrays_for(nodes[parent_id]['proxy']) if a['association'] == 'CELLS' and a['components'] >= 2]
    if not cells or not auto_convert:
        raise RuntimeError('This filter needs a point-vector field. Add Cell Data to Point Data first.')
    proxy = CellDatatoPointData(registrationName='Cell Data to Point Data', Input=nodes[parent_id]['proxy'])
    converted_id = register_filter('CellDatatoPointData', proxy, parent_id)
    converted = [a for a in arrays_for(proxy) if a['association'] == 'POINTS' and a['components'] >= 2]
    if not converted: raise RuntimeError('No point-vector field is available after conversion.')
    return converted_id, converted[0]

def point_scalar_for(parent_id, auto_convert):
    candidates = [a for a in arrays_for(nodes[parent_id]['proxy']) if a['association'] == 'POINTS' and a['components'] == 1]
    if candidates: return parent_id, candidates[0]
    cells = [a for a in arrays_for(nodes[parent_id]['proxy']) if a['association'] == 'CELLS' and a['components'] == 1]
    if not cells or not auto_convert:
        raise RuntimeError('This filter needs a scalar point field. Add Cell Data to Point Data first.')
    proxy = CellDatatoPointData(registrationName='Cell Data to Point Data', Input=nodes[parent_id]['proxy'])
    converted_id = register_filter('CellDatatoPointData', proxy, parent_id)
    converted = [a for a in arrays_for(proxy) if a['association'] == 'POINTS' and a['components'] == 1]
    if not converted: raise RuntimeError('No scalar point field is available after conversion.')
    matching = next((a for a in converted if a['name'] == cells[0]['name']), converted[0])
    return converted_id, matching

def select_stream_seed(proxy, seed_type):
    aliases = ('Point Cloud', 'Point Source', 'PointCloud') if seed_type == 'Point Cloud' else ('Line', 'High Resolution Line Source')
    for alias in aliases:
        try:
            proxy.SeedType = alias
            return
        except Exception:
            pass
    raise RuntimeError('This ParaView build does not expose the requested stream-tracer seed type.')

def apply_threshold(proxy, settings):
    proxy.Scalars = [settings['association'], settings['name']]
    if hasattr(proxy, 'LowerThreshold') and hasattr(proxy, 'UpperThreshold'):
        proxy.LowerThreshold = settings['lower']
        proxy.UpperThreshold = settings['upper']
    elif hasattr(proxy, 'ThresholdRange'):
        proxy.ThresholdRange = [settings['lower'], settings['upper']]

def apply_stream(proxy, settings):
    proxy.Vectors = ['POINTS', settings['name']]
    select_stream_seed(proxy, settings['seedType'])
    seed = proxy.SeedType
    if settings['seedType'] == 'Point Cloud':
        set_if_supported(seed, 'Center', settings['center'])
        set_if_supported(seed, 'Radius', settings['radius'])
        set_if_supported(seed, 'NumberOfPoints', settings['points'])
    else:
        set_if_supported(seed, 'Point1', settings['point1'])
        set_if_supported(seed, 'Point2', settings['point2'])
        set_if_supported(seed, 'Resolution', settings['resolution'])
    set_if_supported(proxy, 'IntegrationDirection', settings['direction'])
    set_if_supported(proxy, 'MaximumStreamlineLength', settings['maximumLength'])

def make_filter(names, kwargs):
    for name in names:
        constructor = globals().get(name)
        if constructor is not None: return constructor(**kwargs)
    raise RuntimeError('This ParaView build does not expose ' + names[0] + '.')

def filter_capabilities():
    candidates = OrderedDict([
        ('Slice', ('Slice',)), ('Clip', ('Clip',)), ('Contour', ('Contour',)),
        ('CellDatatoPointData', ('CellDatatoPointData',)), ('PointDatatoCellData', ('PointDatatoCellData',)),
        ('Threshold', ('Threshold',)), ('StreamTracer', ('StreamTracer',)), ('Tube', ('Tube',)),
        ('ExtractSurface', ('ExtractSurface',)), ('CellCenters', ('CellCenters',)),
        ('Calculator', ('Calculator',)), ('Gradient', ('Gradient', 'GradientOfUnstructuredDataSet')),
        ('Glyph', ('Glyph',)), ('WarpByVector', ('WarpByVector',)), ('WarpByScalar', ('WarpByScalar',)),
        ('Transform', ('Transform',)), ('Reflect', ('Reflect',)), ('ExtractEdges', ('ExtractEdges',)),
        ('Connectivity', ('Connectivity',)), ('Shrink', ('Shrink',)), ('IntegrateVariables', ('IntegrateVariables',)),
        ('PlotOverLine', ('PlotOverLine',)), ('TemporalStatistics', ('TemporalStatistics',)),
    ])
    return [kind for kind, names in candidates.items() if any(globals().get(name) is not None for name in names)]

def add_filter(kind):
    global selected_id
    allowed = (
        'Slice', 'Clip', 'Contour', 'CellDatatoPointData', 'PointDatatoCellData',
        'Threshold', 'StreamTracer', 'Tube', 'ExtractSurface', 'CellCenters',
        'Calculator', 'Gradient', 'Glyph', 'WarpByVector', 'WarpByScalar',
        'Transform', 'Reflect', 'ExtractEdges', 'Connectivity', 'Shrink',
        'IntegrateVariables', 'PlotOverLine', 'TemporalStatistics',
    )
    if kind not in allowed: raise RuntimeError('Unsupported ParaView filter: ' + str(kind))
    parent_id = selected_id
    parent = nodes[parent_id]
    if kind == 'Tube' and parent['type'] not in ('StreamTracer', 'PlotOverLine', 'ExtractEdges', 'Contour'):
        raise RuntimeError('Tube needs a line-producing input such as Stream Tracer, Plot Over Line, Extract Edges or Contour.')
    kwargs = {'registrationName': FILTER_LABELS.get(kind, kind), 'Input': parent['proxy']}
    extra = {}
    if kind == 'Slice': proxy = Slice(**kwargs)
    elif kind == 'Clip': proxy = Clip(**kwargs)
    elif kind == 'CellDatatoPointData': proxy = CellDatatoPointData(**kwargs)
    elif kind == 'PointDatatoCellData': proxy = PointDatatoCellData(**kwargs)
    elif kind == 'ExtractSurface': proxy = ExtractSurface(**kwargs)
    elif kind == 'Contour':
        parent_id, chosen = point_scalar_for(parent_id, True)
        parent = nodes[parent_id]
        kwargs = {'registrationName': 'Contour', 'Input': parent['proxy']}
        proxy = Contour(**kwargs)
        value = (chosen['range'][0] + chosen['range'][1]) / 2.0
        proxy.ContourBy = ['POINTS', chosen['name']]
        proxy.Isosurfaces = [value]
        extra['contour'] = {'association': 'POINTS', 'name': chosen['name'], 'value': value}
    elif kind == 'Threshold':
        candidates = [a for a in arrays_for(parent['proxy']) if a['components'] == 1]
        if not candidates: raise RuntimeError('Threshold needs a scalar field.')
        chosen = candidates[0]
        settings = {'association': chosen['association'], 'name': chosen['name'], 'lower': chosen['range'][0], 'upper': chosen['range'][1]}
        proxy = Threshold(**kwargs)
        apply_threshold(proxy, settings)
        extra['threshold'] = settings
    elif kind == 'StreamTracer':
        parent_id, chosen = point_vector_for(parent_id, True)
        parent = nodes[parent_id]
        kwargs = {'registrationName': 'Stream Tracer', 'Input': parent['proxy']}
        b = bounds_for(parent['proxy'])
        center = [(b[0]+b[1])/2, (b[2]+b[3])/2, (b[4]+b[5])/2]
        diagonal = math.sqrt((b[1]-b[0])**2 + (b[3]-b[2])**2 + (b[5]-b[4])**2) or 1.0
        settings = {
            'name': chosen['name'], 'seedType': 'Point Cloud', 'center': center,
            'radius': diagonal * 0.15, 'points': 50,
            'point1': [b[0], center[1], center[2]], 'point2': [b[1], center[1], center[2]],
            'resolution': 50, 'direction': 'BOTH', 'maximumLength': diagonal * 8.0,
        }
        proxy = StreamTracer(**kwargs)
        apply_stream(proxy, settings)
        extra['streamTracer'] = settings
    elif kind == 'Tube':
        b = bounds_for(parent['proxy'])
        diagonal = math.sqrt((b[1]-b[0])**2 + (b[3]-b[2])**2 + (b[5]-b[4])**2) or 1.0
        settings = {'radius': diagonal * 0.005, 'sides': 8}
        proxy = Tube(**kwargs)
        set_if_supported(proxy, 'Radius', settings['radius'])
        set_if_supported(proxy, 'NumberofSides', settings['sides'])
        extra['tube'] = settings
    elif kind == 'CellCenters':
        proxy = make_filter(('CellCenters',), kwargs); set_if_supported(proxy, 'VertexCells', 1)
    elif kind == 'Calculator':
        candidates = arrays_for(parent['proxy'])
        if not candidates: raise RuntimeError('Calculator needs at least one data array.')
        chosen = candidates[0]
        settings = {'association': chosen['association'], 'expression': chosen['name'], 'resultName': chosen['name'] + '_calculated'}
        proxy = make_filter(('Calculator',), kwargs)
        set_if_supported(proxy, 'AttributeType', 'Point Data' if chosen['association'] == 'POINTS' else 'Cell Data')
        proxy.Function = settings['expression']; proxy.ResultArrayName = settings['resultName']
        extra['calculator'] = settings
    elif kind == 'Gradient':
        parent_id, chosen = point_scalar_for(parent_id, True); parent = nodes[parent_id]
        kwargs = {'registrationName': 'Gradient', 'Input': parent['proxy']}
        settings = {'association': 'POINTS', 'name': chosen['name'], 'resultName': chosen['name'] + 'Gradient'}
        proxy = make_filter(('Gradient', 'GradientOfUnstructuredDataSet'), kwargs)
        set_if_supported(proxy, 'ScalarArray', ['POINTS', chosen['name']]); set_if_supported(proxy, 'ResultArrayName', settings['resultName'])
        extra['gradient'] = settings
    elif kind == 'Glyph':
        parent_id, chosen = point_vector_for(parent_id, True); parent = nodes[parent_id]
        kwargs = {'registrationName': 'Glyph', 'Input': parent['proxy']}
        b = bounds_for(parent['proxy']); diagonal = math.sqrt((b[1]-b[0])**2 + (b[3]-b[2])**2 + (b[5]-b[4])**2) or 1.0
        settings = {'name': chosen['name'], 'scaleFactor': diagonal * 0.05, 'maxPoints': 1200}
        proxy = make_filter(('Glyph',), kwargs)
        set_if_supported(proxy, 'OrientationArray', ['POINTS', chosen['name']]); set_if_supported(proxy, 'ScaleArray', ['POINTS', chosen['name']])
        set_if_supported(proxy, 'ScaleFactor', settings['scaleFactor']); set_if_supported(proxy, 'MaximumNumberOfSamplePoints', settings['maxPoints'])
        extra['glyph'] = settings
    elif kind == 'WarpByVector':
        parent_id, chosen = point_vector_for(parent_id, True); parent = nodes[parent_id]
        kwargs = {'registrationName': 'Warp By Vector', 'Input': parent['proxy']}
        settings = {'association': 'POINTS', 'name': chosen['name'], 'scaleFactor': 1.0}
        proxy = make_filter(('WarpByVector',), kwargs); set_if_supported(proxy, 'Vectors', ['POINTS', chosen['name']]); set_if_supported(proxy, 'ScaleFactor', 1.0)
        extra['warp'] = settings
    elif kind == 'WarpByScalar':
        parent_id, chosen = point_scalar_for(parent_id, True); parent = nodes[parent_id]
        kwargs = {'registrationName': 'Warp By Scalar', 'Input': parent['proxy']}
        settings = {'association': 'POINTS', 'name': chosen['name'], 'scaleFactor': 1.0, 'normal': [0.0, 0.0, 1.0], 'useNormal': False}
        proxy = make_filter(('WarpByScalar',), kwargs); set_if_supported(proxy, 'Scalars', ['POINTS', chosen['name']]); set_if_supported(proxy, 'ScaleFactor', 1.0)
        extra['warp'] = settings
    elif kind == 'Transform':
        settings = {'translate': [0.0, 0.0, 0.0], 'rotate': [0.0, 0.0, 0.0], 'scale': [1.0, 1.0, 1.0]}
        proxy = make_filter(('Transform',), kwargs); extra['transform'] = settings
    elif kind == 'Reflect':
        b = bounds_for(parent['proxy']); settings = {'origin': [(b[0]+b[1])/2, (b[2]+b[3])/2, (b[4]+b[5])/2], 'normal': [1.0, 0.0, 0.0], 'copyInput': True}
        proxy = make_filter(('Reflect',), kwargs)
        plane = property_value(proxy, 'ReflectionPlane', None)
        if plane is not None:
            set_if_supported(plane, 'Origin', settings['origin']); set_if_supported(plane, 'Normal', settings['normal'])
        set_if_supported(proxy, 'CopyInput', 1)
        extra['reflect'] = settings
    elif kind == 'ExtractEdges': proxy = make_filter(('ExtractEdges',), kwargs)
    elif kind == 'Connectivity':
        proxy = make_filter(('Connectivity',), kwargs); set_if_supported(proxy, 'ColorRegions', 1)
    elif kind == 'Shrink':
        settings = {'factor': 0.8}; proxy = make_filter(('Shrink',), kwargs); set_if_supported(proxy, 'ShrinkFactor', settings['factor']); extra['shrink'] = settings
    elif kind == 'IntegrateVariables': proxy = make_filter(('IntegrateVariables',), kwargs)
    elif kind == 'PlotOverLine':
        b = bounds_for(parent['proxy']); settings = {'point1': [b[0], b[2], b[4]], 'point2': [b[1], b[3], b[5]], 'resolution': 200}
        proxy = make_filter(('PlotOverLine',), kwargs); proxy.Point1 = settings['point1']; proxy.Point2 = settings['point2']; set_if_supported(proxy, 'Resolution', settings['resolution']); extra['plotOverLine'] = settings
    elif kind == 'TemporalStatistics': proxy = make_filter(('TemporalStatistics',), kwargs)
    register_filter(kind, proxy, parent_id, extra)
    ResetCamera(view)

def delete_selected():
    global selected_id
    if selected_id == 'reader': raise RuntimeError('The OpenFOAM reader cannot be deleted.')
    if any(node['parent'] == selected_id for node in nodes.values()):
        raise RuntimeError('Delete child filters first.')
    identifier = selected_id
    parent_id = nodes[identifier]['parent']
    delete_guide(identifier)
    Delete(nodes[identifier]['proxy'])
    del nodes[identifier]
    selected_id = parent_id or 'reader'
    parent = nodes[selected_id]
    parent['visible'] = parent['display'] is not None
    if parent['display'] is not None: parent['display'].Visibility = 1
    ResetCamera(view)

def update_selected(data):
    node = selected_node()
    display = node['display']
    target_representation = data.get('representation', node['representation'])
    target_color = data.get('color', node['color'])
    if target_representation == 'Volume':
        if not volume_capabilities(node)['supported']: raise RuntimeError('Volume rendering is unavailable for this geometry.')
        if not isinstance(target_color, dict) or not any(array['name'] == target_color.get('name') and array['association'] == target_color.get('association') and array['components'] == 1 for array in arrays_for(node['proxy'])): raise RuntimeError('Choose a scalar field before enabling Volume.')
    if 'representation' in data:
        if data['representation'] not in representations_for(display): raise RuntimeError('Unsupported representation.')
        node['representation'] = data['representation']
    if 'opacity' in data:
        node['opacity'] = max(0.0, min(1.0, clean_number(data['opacity'], node['opacity'])))
    if 'lineWidth' in data:
        node['lineWidth'] = max(1.0, min(20.0, clean_number(data['lineWidth'], node['lineWidth'])))
    if 'pointSize' in data:
        node['pointSize'] = max(1.0, min(30.0, clean_number(data['pointSize'], node['pointSize'])))
    if 'visible' in data: node['visible'] = bool(data['visible'])
    if 'color' in data:
        color = data['color'] if isinstance(data['color'], dict) else {}
        association = color.get('association', 'SOLID')
        name = str(color.get('name', ''))
        valid = association in ('SOLID', 'BLOCKS') or any(a['association'] == association and a['name'] == name for a in arrays_for(node['proxy']))
        if not valid: raise RuntimeError('That array is not available on the selected pipeline item.')
        node['color'] = {
            'association': association, 'name': name,
            'preset': str(color.get('preset', node['color']['preset'])),
            'legend': bool(color.get('legend', node['color']['legend'])),
        }
    if 'volume' in data: node['volume'] = validate_volume(data['volume'])
    if node['type'] == 'CFDGradient' and 'diagnostic' in data:
        apply_diagnostic(node['proxy'], node['parent'], data['diagnostic']); node['diagnostic'] = data['diagnostic']
    if node['type'] == 'Selection' and 'selection' in data:
        output = selection_output(node['parent'], data['selection'])
        node['proxy'].GetClientSideObject().SetOutput(output); node['selection'] = data['selection']
    if node['type'] == 'ResampleToImage' and 'resample' in data:
        node['proxy'].SamplingDimensions = data['resample']['dimensions']; node['resample'] = data['resample']
    if node['type'] in ('Slice', 'Clip'):
        target = node['proxy'].SliceType if node['type'] == 'Slice' else node['proxy'].ClipType
        if 'origin' in data: target.Origin = vector(data['origin'], list(target.Origin))
        if 'normal' in data: target.Normal = vector(data['normal'], list(target.Normal))
        if node['type'] == 'Clip' and 'invert' in data: node['proxy'].Invert = bool(data['invert'])
    if node['type'] == 'Contour' and 'contour' in data:
        contour = data['contour'] if isinstance(data['contour'], dict) else {}
        association = contour.get('association', node['contour']['association'])
        name = str(contour.get('name', node['contour']['name']))
        valid = any(a['association'] == association and a['name'] == name for a in arrays_for(nodes[node['parent']]['proxy']))
        if not valid: raise RuntimeError('That contour array is not available.')
        value = clean_number(contour.get('value'), node['contour']['value'])
        node['proxy'].ContourBy = [association, name]
        node['proxy'].Isosurfaces = [value]
        node['contour'] = {'association': association, 'name': name, 'value': value}
    if node['type'] == 'Threshold' and 'threshold' in data:
        requested = data['threshold'] if isinstance(data['threshold'], dict) else {}
        association = requested.get('association', node['threshold']['association'])
        name = str(requested.get('name', node['threshold']['name']))
        valid_arrays = arrays_for(nodes[node['parent']]['proxy'])
        selected_array = next((a for a in valid_arrays if a['association'] == association and a['name'] == name and a['components'] == 1), None)
        if selected_array is None: raise RuntimeError('That scalar array is not available for Threshold.')
        lower = clean_number(requested.get('lower'), selected_array['range'][0])
        upper = clean_number(requested.get('upper'), selected_array['range'][1])
        if lower > upper: lower, upper = upper, lower
        node['threshold'] = {'association': association, 'name': name, 'lower': lower, 'upper': upper}
        apply_threshold(node['proxy'], node['threshold'])
    if node['type'] == 'StreamTracer' and 'streamTracer' in data:
        requested = data['streamTracer'] if isinstance(data['streamTracer'], dict) else {}
        settings = dict(node['streamTracer'])
        name = str(requested.get('name', settings['name']))
        parent_arrays = arrays_for(nodes[node['parent']]['proxy'])
        if not any(a['association'] == 'POINTS' and a['name'] == name and a['components'] >= 2 for a in parent_arrays):
            raise RuntimeError('That point-vector array is not available for Stream Tracer.')
        settings['name'] = name
        seed_type = str(requested.get('seedType', settings['seedType']))
        if seed_type not in ('Point Cloud', 'Line'): raise RuntimeError('Unsupported stream-tracer seed type.')
        settings['seedType'] = seed_type
        settings['center'] = vector(requested.get('center'), settings['center'])
        settings['radius'] = max(0.0, clean_number(requested.get('radius'), settings['radius']))
        settings['points'] = max(1, min(2000, int(clean_number(requested.get('points'), settings['points']))))
        settings['point1'] = vector(requested.get('point1'), settings['point1'])
        settings['point2'] = vector(requested.get('point2'), settings['point2'])
        settings['resolution'] = max(1, min(2000, int(clean_number(requested.get('resolution'), settings['resolution']))))
        direction = str(requested.get('direction', settings['direction']))
        if direction not in ('FORWARD', 'BACKWARD', 'BOTH'): raise RuntimeError('Unsupported integration direction.')
        settings['direction'] = direction
        settings['maximumLength'] = max(1e-12, clean_number(requested.get('maximumLength'), settings['maximumLength']))
        node['streamTracer'] = settings
        apply_stream(node['proxy'], settings)
    if node['type'] == 'Tube' and 'tube' in data:
        requested = data['tube'] if isinstance(data['tube'], dict) else {}
        settings = dict(node['tube'])
        settings['radius'] = max(1e-12, clean_number(requested.get('radius'), settings['radius']))
        settings['sides'] = max(3, min(64, int(clean_number(requested.get('sides'), settings['sides']))))
        node['tube'] = settings
        set_if_supported(node['proxy'], 'Radius', settings['radius'])
        set_if_supported(node['proxy'], 'NumberofSides', settings['sides'])
    if node['type'] == 'Calculator' and 'calculator' in data:
        requested = data['calculator'] if isinstance(data['calculator'], dict) else {}
        settings = dict(node['calculator'])
        association = str(requested.get('association', settings['association']))
        expression = str(requested.get('expression', settings['expression'])).strip()[:500]
        result_name = ''.join(character for character in str(requested.get('resultName', settings['resultName'])) if character.isalnum() or character == '_')[:80]
        if association not in ('CELLS', 'POINTS') or not expression or not result_name: raise RuntimeError('Calculator needs a valid association, expression and result array name.')
        settings = {'association': association, 'expression': expression, 'resultName': result_name}
        set_if_supported(node['proxy'], 'AttributeType', 'Point Data' if association == 'POINTS' else 'Cell Data')
        node['proxy'].Function = expression; node['proxy'].ResultArrayName = result_name; node['calculator'] = settings
    if node['type'] == 'Gradient' and 'gradient' in data:
        requested = data['gradient'] if isinstance(data['gradient'], dict) else {}
        settings = dict(node['gradient']); association = str(requested.get('association', settings['association'])); name = str(requested.get('name', settings['name']))
        parent_arrays = arrays_for(nodes[node['parent']]['proxy'])
        if not any(a['association'] == association and a['name'] == name and a['components'] == 1 for a in parent_arrays): raise RuntimeError('Gradient needs a scalar array from its input.')
        result_name = ''.join(character for character in str(requested.get('resultName', settings['resultName'])) if character.isalnum() or character == '_')[:80]
        if not result_name: raise RuntimeError('Gradient needs a result array name.')
        settings = {'association': association, 'name': name, 'resultName': result_name}
        set_if_supported(node['proxy'], 'ScalarArray', [association, name]); set_if_supported(node['proxy'], 'ResultArrayName', result_name); node['gradient'] = settings
    if node['type'] == 'Glyph' and 'glyph' in data:
        requested = data['glyph'] if isinstance(data['glyph'], dict) else {}; settings = dict(node['glyph']); name = str(requested.get('name', settings['name']))
        parent_arrays = arrays_for(nodes[node['parent']]['proxy'])
        if not any(a['association'] == 'POINTS' and a['name'] == name and a['components'] >= 2 for a in parent_arrays): raise RuntimeError('Glyph needs a point-vector array.')
        settings['name'] = name; settings['scaleFactor'] = max(0.0, clean_number(requested.get('scaleFactor'), settings['scaleFactor'])); settings['maxPoints'] = max(1, min(50000, int(clean_number(requested.get('maxPoints'), settings['maxPoints']))))
        set_if_supported(node['proxy'], 'OrientationArray', ['POINTS', name]); set_if_supported(node['proxy'], 'ScaleArray', ['POINTS', name]); set_if_supported(node['proxy'], 'ScaleFactor', settings['scaleFactor']); set_if_supported(node['proxy'], 'MaximumNumberOfSamplePoints', settings['maxPoints']); node['glyph'] = settings
    if node['type'] in ('WarpByVector', 'WarpByScalar') and 'warp' in data:
        requested = data['warp'] if isinstance(data['warp'], dict) else {}; settings = dict(node['warp'])
        association = str(requested.get('association', settings['association'])); name = str(requested.get('name', settings['name']))
        parent_arrays = arrays_for(nodes[node['parent']]['proxy'])
        if node['type'] == 'WarpByVector': valid = any(a['association'] == association and a['name'] == name and a['components'] >= 2 for a in parent_arrays)
        else: valid = any(a['association'] == association and a['name'] == name and a['components'] == 1 for a in parent_arrays)
        if not valid: raise RuntimeError('The selected warp array is not available.')
        settings['association'] = association; settings['name'] = name; settings['scaleFactor'] = clean_number(requested.get('scaleFactor'), settings['scaleFactor'])
        set_if_supported(node['proxy'], 'Vectors' if node['type'] == 'WarpByVector' else 'Scalars', [association, name]); set_if_supported(node['proxy'], 'ScaleFactor', settings['scaleFactor'])
        if node['type'] == 'WarpByScalar':
            settings['normal'] = vector(requested.get('normal'), settings.get('normal', [0.0, 0.0, 1.0])); settings['useNormal'] = bool(requested.get('useNormal', settings.get('useNormal', False)))
            set_if_supported(node['proxy'], 'Normal', settings['normal']); set_if_supported(node['proxy'], 'UseNormal', 1 if settings['useNormal'] else 0)
        node['warp'] = settings
    if node['type'] == 'Transform' and 'transform' in data:
        requested = data['transform'] if isinstance(data['transform'], dict) else {}; settings = dict(node['transform'])
        settings['translate'] = vector(requested.get('translate'), settings['translate']); settings['rotate'] = vector(requested.get('rotate'), settings['rotate']); settings['scale'] = vector(requested.get('scale'), settings['scale'])
        settings['scale'] = [value if abs(value) > 1e-12 else 1e-12 for value in settings['scale']]
        transform = node['proxy'].Transform; set_if_supported(transform, 'Translate', settings['translate']); set_if_supported(transform, 'Rotate', settings['rotate']); set_if_supported(transform, 'Scale', settings['scale']); node['transform'] = settings
    if node['type'] == 'Reflect' and 'reflect' in data:
        requested = data['reflect'] if isinstance(data['reflect'], dict) else {}; settings = dict(node['reflect'])
        settings['origin'] = vector(requested.get('origin'), settings['origin']); settings['normal'] = vec_normalize(vector(requested.get('normal'), settings['normal'])); settings['copyInput'] = bool(requested.get('copyInput', settings['copyInput']))
        plane = property_value(node['proxy'], 'ReflectionPlane', None)
        if plane is not None:
            set_if_supported(plane, 'Origin', settings['origin']); set_if_supported(plane, 'Normal', settings['normal'])
        set_if_supported(node['proxy'], 'CopyInput', 1 if settings['copyInput'] else 0); node['reflect'] = settings
    if node['type'] == 'Shrink' and 'shrink' in data:
        requested = data['shrink'] if isinstance(data['shrink'], dict) else {}; factor = max(0.0, min(1.0, clean_number(requested.get('factor'), node['shrink']['factor'])))
        node['shrink'] = {'factor': factor}; set_if_supported(node['proxy'], 'ShrinkFactor', factor)
    if node['type'] == 'PlotOverLine' and 'plotOverLine' in data:
        requested = data['plotOverLine'] if isinstance(data['plotOverLine'], dict) else {}; settings = dict(node['plotOverLine'])
        settings['point1'] = vector(requested.get('point1'), settings['point1']); settings['point2'] = vector(requested.get('point2'), settings['point2']); settings['resolution'] = max(1, min(10000, int(clean_number(requested.get('resolution'), settings['resolution']))))
        node['proxy'].Point1 = settings['point1']; node['proxy'].Point2 = settings['point2']; set_if_supported(node['proxy'], 'Resolution', settings['resolution']); node['plotOverLine'] = settings
    node['proxy'].UpdatePipeline(time=current_time)
    apply_display(node)
    ensure_guide(selected_id)

def camera(data):
    mode = data.get('mode', 'rotate')
    dx = clean_number(data.get('dx'))
    dy = clean_number(data.get('dy'))
    cam = view.GetActiveCamera()
    if mode == 'rotate':
        cam.Azimuth(-dx * 0.35)
        cam.Elevation(dy * 0.35)
        cam.OrthogonalizeViewUp()
    elif mode == 'zoom':
        cam.Dolly(math.exp(-dy * 0.006))
    elif mode == 'pan':
        position = list(cam.GetPosition()); focal = list(cam.GetFocalPoint()); up = list(cam.GetViewUp())
        direction = [focal[i] - position[i] for i in range(3)]
        distance = math.sqrt(sum(v*v for v in direction)) or 1.0
        direction = [v / distance for v in direction]
        right = [direction[1]*up[2]-direction[2]*up[1], direction[2]*up[0]-direction[0]*up[2], direction[0]*up[1]-direction[1]*up[0]]
        right_len = math.sqrt(sum(v*v for v in right)) or 1.0
        right = [v/right_len for v in right]
        scale = 2.0 * distance * math.tan(math.radians(cam.GetViewAngle())/2.0) / max(240.0, clean_number(data.get('height'), 700.0))
        shift = [right[i] * (-dx * scale) + up[i] * (dy * scale) for i in range(3)]
        cam.SetPosition(*[position[i] + shift[i] for i in range(3)])
        cam.SetFocalPoint(*[focal[i] + shift[i] for i in range(3)])
    # Render() refreshes clipping ranges for the active representation. The
    # RenderView proxy does not expose vtkRenderer.ResetCameraClippingRange.

def standard_view(direction):
    directions = {
        '+X': ([1,0,0], [0,0,1]), '-X': ([-1,0,0], [0,0,1]),
        '+Y': ([0,1,0], [0,0,1]), '-Y': ([0,-1,0], [0,0,1]),
        '+Z': ([0,0,1], [0,1,0]), '-Z': ([0,0,-1], [0,1,0]),
        'Iso': ([1,1,1], [0,0,1]),
    }
    vector_dir, up = directions.get(direction, directions['Iso'])
    b = bounds_for(selected_node()['proxy'])
    center = [(b[0]+b[1])/2, (b[2]+b[3])/2, (b[4]+b[5])/2]
    span = max(b[1]-b[0], b[3]-b[2], b[5]-b[4], 1e-6)
    length = math.sqrt(sum(v*v for v in vector_dir))
    unit = [v/length for v in vector_dir]
    cam = view.GetActiveCamera()
    cam.SetFocalPoint(*center); cam.SetPosition(*[center[i] + unit[i]*span*3 for i in range(3)])
    cam.SetViewUp(*up)
    ResetCamera(view)

# ── Video export ──
# A view snapshot is what the timeline stores: the camera and, for every
# pipeline item, what the Display section controls. Snapshots come back from the
# browser, so they are validated again (prepare_snapshot) before use, against
# the same allowlists the live commands use.

VIDEO_SIZES = ((854, 480), (1280, 720), (1920, 1080), (3840, 2160))
VIDEO_FPS = (12, 24, 25, 30, 60)
VIDEO_MAX_FRAMES = 216001

WORKSPACE_PARAMETER_SCHEMA = ${JSON.stringify(WORKSPACE_PARAMETER_SCHEMA)}

def capture_workspace():
    metadata = reader_metadata()
    pipeline = []
    for identifier, node in nodes.items():
        settings = node_state(identifier, node)
        parameters = {key: settings[key] for key in WORKSPACE_PARAMETER_SCHEMA[node['type']]}
        parameters.update({'lineWidth': node['lineWidth'], 'pointSize': node['pointSize']})
        if 'volume' in node: parameters['volume'] = settings['volume']
        item = {'id': identifier, 'type': node['type'], 'parent': node['parent'], 'parameters': parameters}
        if node['type'] == 'CaseFileReader': item['filePath'] = node['filePath']
        pipeline.append(item)
    return {
        'format': 'openfoam-studio-paraview', 'version': 1, 'caseName': case_name,
        'paraviewVersion': pv_version, 'selectedId': selected_id,
        'reader': {'caseType': metadata['caseType'], 'regions': metadata['selectedRegions']},
        'nodes': pipeline, 'view': capture_view(), 'centerAxes': view_metadata()['centerAxes'],
    }

def restore_workspace(workspace):
    global nodes, reader, selected_id, next_filter, guides, times, raw_times, current_time, manipulator_visible
    # Browser requests are validated by the shared TS parser before entering
    # this fixed command. Recheck runtime dependencies before changing the graph.
    if not isinstance(workspace, dict) or workspace.get('format') != 'openfoam-studio-paraview' or workspace.get('version') != 1:
        raise RuntimeError('Unsupported workspace format or version.')
    if workspace.get('caseName') != case_name: raise RuntimeError('Open the workspace in its original case.')
    pipeline = workspace.get('nodes')
    if not isinstance(pipeline, list) or not pipeline or len(pipeline) > 64: raise RuntimeError('Invalid workspace pipeline.')
    available = filter_capabilities()
    for item in pipeline:
        if item['type'] == 'CaseFileReader': resolve_case_file(item['filePath'])
        elif item['type'] not in ('OpenFOAMReader', 'Selection', 'CFDGradient', 'ResampleToImage') and item['type'] not in available:
            raise RuntimeError('This ParaView build does not provide the workspace filter ' + item['type'] + '.')
    for snapshot in [workspace['view']] + [segment['view'] for segment in workspace.get('video', {}).get('segments', [])]:
        for settings in snapshot['nodes'].values():
            preset = settings['color']['preset']
            if preset and preset not in available_presets: raise RuntimeError('The workspace color preset is unavailable in this ParaView build: ' + preset)
    previous = (nodes, reader, selected_id, next_filter, guides, times, raw_times, current_time, manipulator_visible)
    old_sources = set(GetSources().values())
    old_view = capture_view()
    old_center = view_metadata()['centerAxes']
    staged_reader = None
    try:
        # Keep the live proxies until every recreated source, filter and display
        # has passed validation. On failure the same live graph is restored.
        nodes = OrderedDict(); guides = {}; manipulator_visible = False
        selected_id = 'reader'; next_filter = 100000000
        staged_reader = OpenFOAMReader(registrationName='Workspace OpenFOAM', FileName=marker)
        reader = staged_reader
        set_if_supported(reader, 'SkipZeroTime', 0)
        set_if_supported(reader, 'ReadAllFilesToDetermineStructure', 1)
        reader.UpdatePipelineInformation()
        mode = workspace['reader']['caseType']
        if mode not in available_values(reader, 'CaseType'): raise RuntimeError('The saved case mode is unavailable.')
        if mode == 'Decomposed Case' and not reader_metadata()['decomposedAvailable']: raise RuntimeError('The saved decomposed case no longer has processor directories.')
        reader.CaseType = mode; reader.UpdatePipelineInformation()
        regions = workspace['reader']['regions']
        if any(region not in available_values(reader, 'MeshRegions') for region in regions): raise RuntimeError('A saved mesh region is no longer available.')
        reader.MeshRegions = regions
        for name in ('CellArrays', 'PointArrays'):
            values = available_values(reader, name)
            if values: set_if_supported(reader, name, values)
        raw_times = [float(value) for value in list(reader.TimestepValues)]
        times = raw_times if raw_times else [0.0]
        requested_time = workspace['view']['time']
        if not any(abs(value-requested_time) <= max(1.0, abs(requested_time))*1e-9 for value in times):
            raise RuntimeError('The workspace timestep is no longer available. Import a workspace for the current results.')
        current_time = min(times, key=lambda value: abs(value-requested_time))
        reader.UpdatePipeline(time=current_time)
        display = Show(reader, view)
        nodes['reader'] = {
            'proxy': reader, 'display': display, 'label': os.path.basename(marker), 'type': 'OpenFOAMReader',
            'parent': None, 'visible': True, 'representation': 'Surface', 'opacity': 1.0,
            'lineWidth': 1.0, 'pointSize': 3.0,
            'color': {'association': 'SOLID', 'name': '', 'preset': available_presets[0] if available_presets else '', 'legend': False},
        }
        scene.AnimationTime = current_time; view.ViewTime = current_time
        for item in pipeline:
            if item['type'] == 'OpenFOAMReader': selected_id = 'reader'
            else:
                before = set(nodes)
                if item['type'] == 'CaseFileReader': open_case_file(item['filePath'])
                else:
                    selected_id = item['parent']
                    if item['type'] == 'Selection': create_selection(item['parameters']['selection'])
                    elif item['type'] == 'CFDGradient': create_diagnostic(item['parameters']['diagnostic'])
                    elif item['type'] == 'ResampleToImage': create_resample(item['parameters']['resample']['dimensions'])
                    else: add_filter(item['type'])
                created = set(nodes) - before
                if len(created) != 1: raise RuntimeError('The saved filter input now requires additional conversion. Recreate that filter for the updated results.')
                generated = selected_id
                node = nodes.pop(generated)
                delete_guide(generated)
                nodes[item['id']] = node; selected_id = item['id']
            # Volume initially has no scalar color. Restore its settings only
            # after rebuilding geometry, then apply the saved display/color.
            update_selected({key: value for key, value in item['parameters'].items() if key != 'volume'})
            if 'volume' in item['parameters']: nodes[selected_id]['volume'] = item['parameters']['volume']
            if item['type'] in ('Calculator', 'Gradient'):
                settings = item['parameters']['calculator' if item['type'] == 'Calculator' else 'gradient']
                if not any(array['name'] == settings['resultName'] for array in arrays_for(nodes[selected_id]['proxy'])):
                    raise RuntimeError('The saved ' + item['type'] + ' could not produce its result array. Check the input fields and formula.')
            nodes[selected_id]['label'] = workspace['view']['nodes'][selected_id]['label']
            try: RenameSource(nodes[selected_id]['label'], nodes[selected_id]['proxy'])
            except Exception: pass
        selected_id = workspace['selectedId']
        # Validate the entire saved display before applying any of its colors.
        prepared = prepare_snapshot(workspace['view'])
        apply_snapshot(prepared, True)
        set_if_supported(view, 'CenterAxesVisibility', 1 if workspace['centerAxes'] else 0)
        for segment in workspace.get('video', {}).get('segments', []):
            if not any(abs(value-segment['until']) <= max(1.0, abs(segment['until']))*1e-9 for value in times):
                raise RuntimeError('A saved video segment timestep is no longer available.')
            prepare_snapshot(segment['view'])
        if 'video' in workspace and not any(abs(value-workspace['video']['start']) <= max(1.0, abs(workspace['video']['start']))*1e-9 for value in times):
            raise RuntimeError('The saved video start timestep is no longer available.')
        # Force data information now; errors leave the old graph available.
        state()
    except Exception:
        for identifier in list(guides): delete_guide(identifier)
        for node in reversed(list(nodes.values())):
            try: Delete(node['proxy'])
            except Exception: pass
        if staged_reader is not None and not any(node['proxy'] == staged_reader for node in nodes.values()):
            try: Delete(staged_reader)
            except Exception: pass
        # A failed filter constructor can create conversion proxies before it
        # registers its output. Clean those too, preserving all original sources.
        for proxy in reversed(list(GetSources().values())):
            if proxy not in old_sources:
                try: Delete(proxy)
                except Exception: pass
        nodes, reader, selected_id, next_filter, guides, times, raw_times, current_time, manipulator_visible = previous
        scene.AnimationTime = current_time; view.ViewTime = current_time
        apply_snapshot(prepare_snapshot(old_view), True)
        set_if_supported(view, 'CenterAxesVisibility', 1 if old_center else 0)
        ensure_guide(selected_id)
        raise
    old_nodes, _, _, _, old_guides, _, _, _, _ = previous
    for guide in old_guides.values():
        try: Delete(guide['proxy'])
        except Exception: pass
    for node in reversed(list(old_nodes.values())):
        try: Delete(node['proxy'])
        except Exception: pass
    next_filter = max([int(identifier.split('-')[-1]) for identifier in nodes if identifier != 'reader'] + [0]) + 1
    scene.UpdateAnimationUsingDataTimeSteps()
    scene.AnimationTime = current_time; view.ViewTime = current_time
    sync_legends()

def video_formats():
    formats = []
    try:
        from vtkmodules.vtkIOMovie import vtkMP4Writer
        formats.append('mp4')
    except Exception:
        pass
    try:
        from vtkmodules.vtkIOOggTheora import vtkOggTheoraWriter
        formats.append('ogv')
    except Exception:
        pass
    return formats

def lut_range(name, display=None):
    try:
        lut = display.LookupTable if display is not None else None
        points = list((lut or GetColorTransferFunction(name)).RGBPoints)
        if len(points) >= 8: return [clean_number(points[0]), clean_number(points[-4])]
    except Exception:
        pass
    return None

def capture_view():
    cam = view.GetActiveCamera()
    snapshot_nodes = {}
    for identifier, node in nodes.items():
        color = dict(node['color'])
        color['range'] = lut_range(color['name'], node['display']) if color['association'] in ('CELLS', 'POINTS') and color['name'] else None
        snapshot_nodes[identifier] = {
            'label': node['label'], 'visible': node['visible'], 'representation': node['representation'],
            'opacity': node['opacity'], 'color': color,
        }
        if 'volume' in node: snapshot_nodes[identifier]['volume'] = capture_volume(node)
    return {
        'time': current_time,
        'camera': {
            'position': list(cam.GetPosition()), 'focalPoint': list(cam.GetFocalPoint()),
            'viewUp': list(cam.GetViewUp()), 'viewAngle': clean_number(cam.GetViewAngle(), 30.0),
            'parallelScale': clean_number(cam.GetParallelScale(), 1.0),
            'parallel': bool(property_value(view, 'CameraParallelProjection', False)),
        },
        'nodes': snapshot_nodes,
        'view': {'background': background_name, 'orientationAxes': bool(property_value(view, 'OrientationAxesVisibility', True))},
    }

def prepare_snapshot(raw):
    if not isinstance(raw, dict): raise RuntimeError('A timeline view is not a captured view.')
    camera_raw = raw.get('camera') if isinstance(raw.get('camera'), dict) else {}
    cam = view.GetActiveCamera()
    camera = {
        'position': vector(camera_raw.get('position'), list(cam.GetPosition())),
        'focalPoint': vector(camera_raw.get('focalPoint'), list(cam.GetFocalPoint())),
        'viewUp': vec_normalize(vector(camera_raw.get('viewUp'), list(cam.GetViewUp())), (0.0, 1.0, 0.0)),
        'viewAngle': max(1.0, min(170.0, clean_number(camera_raw.get('viewAngle'), 30.0))),
        'parallelScale': max(1e-12, clean_number(camera_raw.get('parallelScale'), 1.0)),
        'parallel': bool(camera_raw.get('parallel')),
    }
    view_raw = raw.get('view') if isinstance(raw.get('view'), dict) else {}
    background = str(view_raw.get('background', background_name))
    prepared_nodes = {}
    nodes_raw = raw.get('nodes') if isinstance(raw.get('nodes'), dict) else {}
    for identifier, settings in nodes_raw.items():
        if identifier not in nodes or not isinstance(settings, dict): continue
        node = nodes[identifier]
        representation = str(settings.get('representation', node['representation']))
        if representation not in representations_for(node['display']): raise RuntimeError('A timeline view uses a representation ' + node['label'] + ' does not offer.')
        color_raw = settings.get('color') if isinstance(settings.get('color'), dict) else {}
        association = str(color_raw.get('association', 'SOLID'))
        name = str(color_raw.get('name', ''))
        if association not in ('SOLID', 'BLOCKS'):
            if not any(a['association'] == association and a['name'] == name for a in arrays_for(node['proxy'])):
                raise RuntimeError('A timeline view colours ' + node['label'] + ' by an array it no longer has.')
        value_range = color_raw.get('range')
        if isinstance(value_range, list) and len(value_range) == 2:
            lo, hi = clean_number(value_range[0], 0.0), clean_number(value_range[1], 1.0)
            value_range = [lo, hi] if hi > lo else None
        else:
            value_range = None
        preset = str(color_raw.get('preset', node['color']['preset']))
        prepared_nodes[identifier] = {
            'visible': bool(settings.get('visible', node['visible'])),
            'representation': representation,
            'opacity': max(0.0, min(1.0, clean_number(settings.get('opacity'), node['opacity']))),
            'color': {
                'association': association, 'name': name if association not in ('SOLID', 'BLOCKS') else '',
                'preset': preset if preset in available_presets else node['color']['preset'],
                'legend': bool(color_raw.get('legend', False)), 'range': value_range,
            },
        }
        if 'volume' in settings: prepared_nodes[identifier]['volume'] = validate_volume(settings['volume'])
    return {
        'camera': camera, 'nodes': prepared_nodes,
        'background': background if background in BACKGROUNDS else background_name,
        'orientationAxes': bool(view_raw.get('orientationAxes', True)),
    }

def set_camera(camera, previous=None, blend=1.0):
    cam = view.GetActiveCamera()
    if previous is not None and blend < 1.0:
        mix = lambda a, b: [a[i] + (b[i] - a[i]) * blend for i in range(3)]
        position = mix(previous['position'], camera['position'])
        focal = mix(previous['focalPoint'], camera['focalPoint'])
        up = vec_normalize(mix(previous['viewUp'], camera['viewUp']), camera['viewUp'])
        angle = previous['viewAngle'] + (camera['viewAngle'] - previous['viewAngle']) * blend
        scale = previous['parallelScale'] + (camera['parallelScale'] - previous['parallelScale']) * blend
    else:
        position, focal, up = camera['position'], camera['focalPoint'], camera['viewUp']
        angle, scale = camera['viewAngle'], camera['parallelScale']
    set_if_supported(view, 'CameraParallelProjection', 1 if camera['parallel'] else 0)
    cam.SetPosition(*position); cam.SetFocalPoint(*focal); cam.SetViewUp(*up)
    cam.SetViewAngle(angle); cam.SetParallelScale(scale)

def apply_snapshot(snapshot, lock_ranges):
    global background_name
    background_name = snapshot['background']
    set_if_supported(view, 'UseColorPaletteForBackground', 0)
    view.Background = BACKGROUNDS[background_name]
    set_if_supported(view, 'OrientationAxesVisibility', 1 if snapshot['orientationAxes'] else 0)
    for identifier, settings in snapshot['nodes'].items():
        node = nodes[identifier]
        node['visible'] = settings['visible']
        node['representation'] = settings['representation']
        node['opacity'] = settings['opacity']
        node['color'] = {key: settings['color'][key] for key in ('association', 'name', 'preset', 'legend')}
        if 'volume' in settings: node['volume'] = settings['volume']
        apply_display(node)
        value_range = settings['color']['range']
        if lock_ranges and value_range and node['color']['name']:
            try:
                lut = node['display'].LookupTable or GetColorTransferFunction(node['color']['name'])
                set_if_supported(lut, 'AutomaticRescaleRangeMode', 'Never')
                lut.RescaleTransferFunction(value_range[0], value_range[1])
            except Exception:
                pass
    sync_legends()
    set_camera(snapshot['camera'])

def rescale_to_frame():
    for node in nodes.values():
        if node['visible'] and node['color']['association'] in ('CELLS', 'POINTS') and node['color']['name']:
            try: node['display'].RescaleTransferFunctionToDataRange(False, True)
            except Exception: pass

def make_video_writer(fmt, filename, fps, width, height):
    if fmt == 'mp4':
        from vtkmodules.vtkIOMovie import vtkMP4Writer
        writer = vtkMP4Writer()
        # Roughly 0.1 bit per pixel per frame: sharp edges on CFD colour maps
        # without multi-gigabyte files.
        try: writer.SetBitRate(int(max(2000000, min(60000000, width * height * fps * 0.1))))
        except Exception: pass
    else:
        from vtkmodules.vtkIOOggTheora import vtkOggTheoraWriter
        writer = vtkOggTheoraWriter()
        try: writer.SetQuality(2)
        except Exception: pass
    writer.SetFileName(filename)
    writer.SetRate(int(fps))
    return writer

def emit_progress(frame, total):
    sys.stdout.write(PREFIX + json.dumps({'id': -2, 'progress': {'frame': frame, 'total': total}}) + '\n')
    sys.stdout.flush()

def export_video(identifier, data, dry=False):
    # dry: render the given frames without writing them and report how long a
    # frame at a new time step and a repeat at the same time take, so the
    # workbench can estimate the whole export before starting it.
    global selected_id
    fmt = str(data.get('format', 'mp4'))
    if fmt not in video_formats(): raise RuntimeError('This ParaView build cannot write ' + fmt.upper() + ' videos.')
    width, height, fps = int(clean_number(data.get('width'))), int(clean_number(data.get('height'))), int(clean_number(data.get('fps')))
    if (width, height) not in VIDEO_SIZES: raise RuntimeError('Unsupported video resolution.')
    if fps not in VIDEO_FPS: raise RuntimeError('Unsupported frame rate.')
    raw_segments = data.get('segments') if isinstance(data.get('segments'), list) else []
    if not raw_segments or len(raw_segments) > 30: raise RuntimeError('The timeline needs between 1 and 30 views.')
    segments = [prepare_snapshot(item) for item in raw_segments]
    raw_frames = data.get('frames') if isinstance(data.get('frames'), list) else []
    if not raw_frames or len(raw_frames) > VIDEO_MAX_FRAMES: raise RuntimeError('The video has no frames or too many.')
    lo, hi = min(times), max(times)
    frames = []
    for item in raw_frames:
        if not isinstance(item, list) or len(item) != 3: raise RuntimeError('Malformed video frame.')
        segment = int(clean_number(item[1], -1))
        if segment < 0 or segment >= len(segments): raise RuntimeError('A video frame refers to a view that does not exist.')
        frames.append((max(lo, min(hi, clean_number(item[0], lo))), segment, max(0.0, min(1.0, clean_number(item[2], 1.0)))))
    lock_ranges = data.get('colorRange') != 'perFrame'
    interpolate = bool(data.get('interpolate'))

    filename = os.path.join(output_dir, 'video_' + str(identifier) + '.' + fmt)
    cancel_path = os.path.join(output_dir, 'cancel-video')
    try: os.remove(cancel_path)
    except Exception: pass

    original = prepare_snapshot(capture_view())
    original_time = current_time
    original_size = list(view.ViewSize)
    original_selected = selected_id
    reader_node = nodes['reader']
    reader_display = reader_node['display']
    interpolator = None
    interpolator_display = None
    reparented = []
    writer = None
    flush_seconds = 0.0
    written = 0
    cancelled = False
    hide_guides()
    try:
        if interpolate:
            # Fields between saved steps come from ParaView's temporal
            # interpolation, inserted under the reader for the export only.
            interpolator = TemporalInterpolator(registrationName='Video temporal interpolation', Input=reader)
            for node in nodes.values():
                if node['parent'] == 'reader':
                    node['proxy'].Input = interpolator
                    reparented.append(node)
            interpolator_display = Show(interpolator, view)
            reader_display.Visibility = 0
            reader_node['display'] = interpolator_display
        view.ViewSize = [width, height]
        # The frame is read back from the (offscreen) render window after each
        # Render; the view proxy itself exposes no image capture in ParaView 6.
        from vtkmodules.vtkRenderingCore import vtkWindowToImageFilter
        grabber = vtkWindowToImageFilter()
        grabber.SetInput(view.GetRenderWindow())
        grabber.ReadFrontBufferOff()
        grabber.ShouldRerenderOff()
        current_segment = -1
        last_emit = 0.0
        durations = []
        import time as _time
        for index, (frame_time, segment, blend) in enumerate(frames):
            if not dry and index % 4 == 0 and os.path.exists(cancel_path):
                cancelled = True
                break
            frame_started = _time.time()
            if segment != current_segment:
                apply_snapshot(segments[segment], lock_ranges)
                current_segment = segment
            previous = segments[segment - 1]['camera'] if segment > 0 else None
            set_camera(segments[segment]['camera'], previous, blend)
            scene.AnimationTime = frame_time
            view.ViewTime = frame_time
            if not lock_ranges:
                for node in nodes.values(): node['proxy'].UpdatePipeline(time=frame_time)
                rescale_to_frame()
            Render(view)
            grabber.Modified()
            grabber.Update()
            # The measurement encodes too, into a file that is thrown away:
            # at 1080p encoding costs as much as rendering a simple case.
            if writer is None:
                writer = make_video_writer(fmt, filename, fps, width, height)
                writer.SetInputConnection(grabber.GetOutputPort())
                writer.Start()
            writer.Write()
            if dry:
                durations.append(_time.time() - frame_started)
                continue
            written += 1
            now = _time.time()
            if now - last_emit > 0.4 or written == len(frames):
                emit_progress(written, len(frames))
                last_emit = now
    finally:
        if writer is not None:
            flush_started = __import__('time').time()
            try: writer.End()
            except Exception: pass
            flush_seconds = __import__('time').time() - flush_started
        if interpolator is not None:
            for node in reparented:
                try: node['proxy'].Input = reader
                except Exception: pass
            reader_node['display'] = reader_display
            try: Delete(interpolator_display)
            except Exception: pass
            try: Delete(interpolator)
            except Exception: pass
        for node in nodes.values():
            try:
                lut = GetColorTransferFunction(node['color']['name']) if node['color']['name'] else None
                if lut is not None: set_if_supported(lut, 'AutomaticRescaleRangeMode', 'Grow and update on Apply')
            except Exception:
                pass
        view.ViewSize = original_size
        apply_snapshot(original, False)
        selected_id = original_selected if original_selected in nodes else 'reader'
        set_time(original_time)
        try: os.remove(cancel_path)
        except Exception: pass
    if dry:
        try: os.remove(filename)
        except Exception: pass
        # An encoder may hold frames back until End: its flush is shared out.
        # How the durations turn into an estimate is estimateRenderSeconds.
        if durations: durations = [value + flush_seconds / len(durations) for value in durations]
        return {'durations': durations}
    if cancelled or written == 0:
        try: os.remove(filename)
        except Exception: pass
        return {'cancelled': True, 'frames': written}
    return {'video': filename, 'frames': written, 'format': fmt}

stage('reading')
reader = OpenFOAMReader(registrationName=os.path.basename(marker), FileName=marker)
try: reader.SkipZeroTime = 0
except Exception: pass
try: reader.ReadAllFilesToDetermineStructure = 1
except Exception: pass
reader.UpdatePipelineInformation()
for property_name in ('CellArrays', 'PointArrays'):
    values = available_values(reader, property_name)
    if values: set_if_supported(reader, property_name, values)
raw_times = [float(v) for v in list(reader.TimestepValues)]
times = raw_times if raw_times else [0.0]
current_time = times[-1]
reader.UpdatePipeline(time=current_time)

stage('rendering')
view = globals().get('_ofstudio_warm_view') or CreateRenderView()
view.ViewSize = [1000, 700]
set_if_supported(view, 'UseColorPaletteForBackground', 0)
view.Background = BACKGROUNDS[background_name]
view.OrientationAxesVisibility = 1
set_if_supported(view, 'CenterAxesVisibility', 0)
scene = GetAnimationScene()
scene.UpdateAnimationUsingDataTimeSteps()
scene.AnimationTime = current_time
view.ViewTime = current_time
display = Show(reader, view)
display.Representation = 'Surface'
available_presets = [name for name in PRESETS if name in ListColorPresetNames()]
supported_video_formats = video_formats()
nodes['reader'] = {
    'proxy': reader, 'display': display, 'label': os.path.basename(marker),
    'type': 'OpenFOAMReader', 'parent': None, 'visible': True,
    'representation': 'Surface', 'opacity': 1.0, 'lineWidth': 1.0, 'pointSize': 3.0,
    'color': {'association': 'SOLID', 'name': '', 'preset': available_presets[0] if available_presets else '', 'legend': False},
}
ResetCamera(view)
emit(globals().get('_ofstudio_ready_id', 0), True, {'state': state()})

# ParaView replaces sys.stdin with vtkPythonStdStreamCaptureHelper so its GUI
# console can capture text. The original stream is the real process pipe and is
# the only iterable one when pvpython is driven headlessly.
for line in sys.__stdin__:
    try:
        request = json.loads(line)
        identifier = int(request.get('id', -1))
        action = request.get('action')
        data = request.get('data') or {}
        if action == 'state': emit(identifier, True, {'state': state()})
        elif action == 'select':
            candidate = str(data.get('id', ''))
            if candidate not in nodes: raise RuntimeError('Pipeline item not found.')
            selected_id = candidate
            set_manipulator(False)
            emit(identifier, True, {'state': state()})
        elif action == 'set_visibility':
            candidate = str(data.get('id', ''))
            if candidate not in nodes: raise RuntimeError('Pipeline item not found.')
            if nodes[candidate]['display'] is None: raise RuntimeError('This source exposes a table. Use its Chart or Table view.')
            nodes[candidate]['visible'] = bool(data.get('visible'))
            apply_display(nodes[candidate])
            emit(identifier, True, {'state': state()})
        elif action == 'add_filter':
            add_filter(str(data.get('filter', '')))
            emit(identifier, True, {'state': changed_state()})
        elif action == 'delete':
            delete_selected(); emit(identifier, True, {'state': changed_state()})
        elif action == 'update':
            if 'revision' in data or 'id' in data or 'time' in data: analysis_source(data)
            update_selected(data); emit(identifier, True, {'state': changed_state()})
        elif action == 'update_reader':
            update_reader(data); emit(identifier, True, {'state': changed_state()})
        elif action == 'update_view':
            update_view(data); emit(identifier, True, {'state': state()})
        elif action == 'set_manipulator':
            set_manipulator(data.get('enabled')); emit(identifier, True, {'state': state()})
        elif action == 'list_case_files':
            emit(identifier, True, {'files': list_case_files()})
        elif action == 'open_case_file':
            open_case_file(data.get('path')); emit(identifier, True, {'state': changed_state()})
        elif action == 'time':
            set_time(data.get('time')); emit(identifier, True, {'state': changed_state()})
        elif action == 'refresh':
            refresh_reader(); emit(identifier, True, {'state': changed_state()})
        elif action == 'data_table':
            emit(identifier, True, {'table': data_table(data)})
        elif action == 'analysis_probe':
            emit(identifier, True, {'probe': analysis_probe(data)})
        elif action == 'find_data':
            emit(identifier, True, {'selection': find_data(data)})
        elif action == 'selection_extract':
            analysis_source(data)
            create_selection({key: data[key] for key in ('block', 'association', 'name', 'component', 'lower', 'upper')})
            emit(identifier, True, {'state': changed_state()})
        elif action == 'cfd_diagnostic':
            analysis_source(data); create_diagnostic(data['diagnostic']); emit(identifier, True, {'state': changed_state()})
        elif action == 'resample_to_image':
            analysis_source(data); create_resample(data['dimensions']); emit(identifier, True, {'state': changed_state()})
        elif action == 'reset_camera':
            ResetCamera(view); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'standard_view':
            standard_view(str(data.get('view', 'Iso'))); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'camera':
            camera(data); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'manipulate':
            manipulate(data); data_revision += 1
            emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'render':
            emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'capture_view':
            emit(identifier, True, {'view': capture_view()})
        elif action == 'workspace_capture':
            emit(identifier, True, {'workspace': capture_workspace()})
        elif action == 'workspace_restore':
            restore_workspace(data.get('workspace')); emit(identifier, True, {'state': changed_state()})
        elif action == 'apply_view':
            apply_snapshot(prepare_snapshot(data.get('view')), True); emit(identifier, True, {'state': state()})
        elif action == 'video_benchmark':
            emit(identifier, True, {'benchmark': export_video(identifier, data, True)})
        elif action == 'export_video':
            emit(identifier, True, {'video': export_video(identifier, data)})
        elif action == 'quit':
            emit(identifier, True, {}); break
        else: raise RuntimeError('Unsupported ParaView action.')
    except Exception as error:
        emit(locals().get('identifier', -1), False, error=str(error))
`;

export interface ParaViewCaseFile {
  path: string;
  name: string;
  extension: string;
  size: number;
}

type WorkerResult = {
  state?: ParaViewWorkbenchState;
  image?: string;
  files?: ParaViewCaseFile[];
  view?: Record<string, unknown>;
  workspace?: ParaViewWorkspace;
  probe?: ProbeResult;
  selection?: FindDataResult;
  table?: ParaViewDataTable;
  video?: { video?: string; frames?: number; format?: string; cancelled?: boolean };
  benchmark?: { durations?: number[] };
};
type Pending = {
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The phases a session goes through before it can answer. `interpreter` and
 * `engine` come from the worker itself, so a start that looks frozen can always
 * be told apart from one that is merely loading ParaView's libraries — a cold
 * pvpython needs around two minutes for that on a first run, against one second
 * once Windows has the files cached.
 */
export type ParaViewStartupStage =
  | 'locating' | 'launching' | 'interpreter' | 'engine' | 'reading' | 'rendering';

export interface ParaViewStartupProgress {
  caseName: string;
  stage: ParaViewStartupStage;
  elapsedMs: number;
}

const STARTUP_STAGES: ParaViewStartupStage[] = [
  'locating', 'launching', 'interpreter', 'engine', 'reading', 'rendering',
];
const READY_TIMEOUT_MS = 600_000;
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * A stop invalidates starts that are still discovering ParaView as well as
 * starts queued behind another case. Killing a child process alone cannot do
 * either, because during discovery there is no child yet.
 */
export class ParaViewLifecycleGuard {
  private generation = 0;

  issue(): number {
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
  }

  isCurrent(ticket: number): boolean {
    return ticket === this.generation;
  }

  assertCurrent(ticket: number): void {
    if (!this.isCurrent(ticket)) throw new Error('ParaView startup was cancelled.');
  }
}

const lifecycleGuard = new ParaViewLifecycleGuard();

class ParaViewWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tempDir: string;
  caseName: string;
  readonly pvpythonPath: string;
  /** The case's .OpenFOAM marker, as a Windows path: its folder is the case. */
  markerPath: string;
  version: string;
  /** Frames written so far by a running video export. */
  onVideoProgress: (frame: number, total: number) => void = () => undefined;
  private buffer = '';
  private stderr = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private alive = true;
  private readyPromise: Promise<WorkerResult>;
  private onStage: (stage: ParaViewStartupStage) => void = () => undefined;

  constructor(child: ChildProcessWithoutNullStreams, tempDir: string, caseName: string, pvpythonPath: string, version: string, markerPath: string) {
    this.child = child;
    this.markerPath = markerPath;
    this.tempDir = tempDir;
    this.caseName = caseName;
    this.pvpythonPath = pvpythonPath;
    this.version = version;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => this.onStdout(String(chunk)));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-16_000);
    });
    child.on('error', error => this.failAll(error));
    child.on('exit', (code, signal) => {
      this.alive = false;
      this.failAll(new Error(
        `ParaView stopped unexpectedly (${signal || `exit ${code ?? 'unknown'}`}).${this.stderr ? ` ${this.stderr.trim().split(/\r?\n/).slice(-1)[0]}` : ''}`
      ));
    });
    // Register id 0 before pvpython can finish initialising and emit READY.
    this.readyPromise = this.waitFor(0, READY_TIMEOUT_MS);
  }

  waitUntilReady(onStage: (stage: ParaViewStartupStage) => void): Promise<WorkerResult> {
    this.onStage = onStage;
    return this.readyPromise;
  }

  get isRunning(): boolean {
    return this.alive;
  }

  request(action: string, data: Record<string, unknown> = {}, timeout = COMMAND_TIMEOUT_MS): Promise<WorkerResult> {
    if (!this.alive) return Promise.reject(new Error('The ParaView session is not running.'));
    const id = this.nextId++;
    const promise = this.waitFor(id, timeout);
    this.child.stdin.write(`${JSON.stringify({ id, action, data })}\n`, error => {
      if (error) this.rejectPending(id, error);
    });
    return promise;
  }

  private waitFor(id: number, timeout: number): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ParaView did not answer within ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const marker = line.indexOf('__OFSTUDIO_JSON__');
      if (marker < 0) continue;
      try {
        const message = JSON.parse(line.slice(marker + '__OFSTUDIO_JSON__'.length)) as {
          id: number; ok?: boolean; stage?: string; result?: WorkerResult; error?: string;
          progress?: { frame?: number; total?: number };
        };
        if (message.progress) {
          this.onVideoProgress(Number(message.progress.frame) || 0, Number(message.progress.total) || 0);
          continue;
        }
        if (message.stage) {
          const stage = message.stage as ParaViewStartupStage;
          if (STARTUP_STAGES.includes(stage)) this.onStage(stage);
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result || {});
        else pending.reject(new Error(message.error || 'ParaView command failed.'));
      } catch { /* ordinary ParaView output, not protocol data */ }
    }
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id] of this.pending) this.rejectPending(id, error);
  }

  /**
   * `graceful` asks the worker to quit through the protocol, which is only
   * meaningful once it answers commands. A session still loading its libraries
   * is killed outright: waiting for a reply it cannot send is what used to make
   * cancelling feel as stuck as the start it was meant to interrupt.
   */
  async stop(graceful = true): Promise<void> {
    if (this.alive) {
      if (graceful) {
        try { await this.request('quit', {}, 2_000); } catch { /* force below */ }
      }
      this.alive = false;
      this.failAll(new Error('The ParaView session was stopped.'));
      this.child.kill();
    }
    await fs.rm(this.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

let activeWorker: ParaViewWorker | null = null;
let startup: { caseName: string; stage: ParaViewStartupStage; startedAt: number; worker: ParaViewWorker | null; ticket: number } | null = null;
let startInFlight: { caseName: string; ticket: number; promise: Promise<ParaViewWorkbenchState> } | null = null;

async function beginSession(
  caseName: string,
  markerPath: string,
  customPath: string,
  ticket: number,
): Promise<ParaViewWorkbenchState> {
  lifecycleGuard.assertCurrent(ticket);
  const pending = { caseName, stage: 'locating' as ParaViewStartupStage, startedAt: Date.now(), worker: null as ParaViewWorker | null, ticket };
  startup = pending;
  const setStage = (stage: ParaViewStartupStage) => {
    if (startup === pending) startup.stage = stage;
  };
  let tempDir = '';
  let worker: ParaViewWorker | null = null;
  try {
    const installation = await findParaView(customPath);
    lifecycleGuard.assertCurrent(ticket);
    if (!installation.found || !installation.pvpythonPath) {
      throw new Error(installation.error || 'ParaView was not found. Configure it from the Dashboard.');
    }
    if (activeWorker) {
      const previous = activeWorker;
      activeWorker = null;
      await previous.stop();
      lifecycleGuard.assertCurrent(ticket);
    }

    setStage('launching');
    const prepared = warmup?.pvpythonPath === installation.pvpythonPath && warmup.worker?.isRunning
      ? warmup.worker : null;
    let ready: WorkerResult;
    if (prepared) {
      // Transfer ownership before awaiting: cancellation now stops this engine,
      // and another request cannot adopt the same idle process.
      warmup!.worker = null;
      worker = prepared;
      worker.caseName = caseName;
      worker.markerPath = markerPath;
      pending.worker = worker;
      if (worker.child.pid) {
        try { os.setPriority(worker.child.pid, os.constants.priority.PRIORITY_NORMAL); } catch { /* best effort */ }
      }
      await worker.waitUntilReady(setStage);
      lifecycleGuard.assertCurrent(ticket);
      ready = await worker.request('activate', {
        marker: markerPath, case: caseName, version: installation.version || 'unknown',
      }, READY_TIMEOUT_MS);
    } else {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openfoam-studio-paraview-session-'));
      lifecycleGuard.assertCurrent(ticket);
      const scriptPath = path.join(tempDir, 'worker.py');
      await fs.writeFile(scriptPath, WORKER_SCRIPT, { encoding: 'utf-8', mode: 0o600 });
      lifecycleGuard.assertCurrent(ticket);
      const child = spawn(installation.pvpythonPath, [
        ...PARAVIEW_RENDER_ARGS,
        scriptPath, markerPath, tempDir, caseName, installation.version || 'unknown',
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      worker = new ParaViewWorker(
        child, tempDir, caseName, installation.pvpythonPath, installation.version || 'unknown', markerPath,
      );
      pending.worker = worker;
      ready = await worker.waitUntilReady(setStage);
    }
    lifecycleGuard.assertCurrent(ticket);
    if (!ready.state) throw new Error('ParaView started without returning its pipeline state.');
    // The engine knows its own version exactly; the installation scan only
    // reads it from folder names.
    worker.version = ready.state.version || worker.version;
    recordParaViewVersion(worker.pvpythonPath, worker.version);
    activeWorker = worker;
    return ready.state;
  } catch (error) {
    if (worker) await worker.stop(false);
    else if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (startup === pending) startup = null;
  }
}

/**
 * Start a session, or join the one already starting for the same case. A second
 * request used to queue behind the first and then restart everything from
 * scratch, which doubled an already slow cold start.
 */
export function startParaViewSession(
  caseName: string,
  markerPath: string,
  customPath = '',
): Promise<ParaViewWorkbenchState> {
  if (startInFlight?.caseName === caseName && lifecycleGuard.isCurrent(startInFlight.ticket)) {
    return startInFlight.promise;
  }
  const ticket = lifecycleGuard.issue();
  const previous = startInFlight ? startInFlight.promise.then(() => undefined, () => undefined) : Promise.resolve();
  const promise = previous.then(() => {
    lifecycleGuard.assertCurrent(ticket);
    return beginSession(caseName, markerPath, customPath, ticket);
  });
  const entry = { caseName, ticket, promise };
  startInFlight = entry;
  void promise.catch(() => undefined).then(() => {
    if (startInFlight === entry) startInFlight = null;
  });
  return promise;
}

export function getParaViewSession(): { caseName: string; version: string; pvpythonPath: string } | null {
  if (!activeWorker?.isRunning) {
    activeWorker = null;
    return null;
  }
  return {
    caseName: activeWorker.caseName,
    version: activeWorker.version,
    pvpythonPath: activeWorker.pvpythonPath,
  };
}

export function getParaViewStartup(): ParaViewStartupProgress | null {
  if (!startup) return null;
  return { caseName: startup.caseName, stage: startup.stage, elapsedMs: Date.now() - startup.startedAt };
}

/**
 * Kill a session that is still starting. Deliberately outside the lifecycle
 * queue: a cancel that waits for the start it cancels is not a cancel.
 */
export async function abortParaViewStartup(): Promise<boolean> {
  lifecycleGuard.cancel();
  const pending = startup;
  if (!pending) return false;
  startup = null;
  if (pending.worker) await pending.worker.stop(false);
  return true;
}

export async function sendParaViewCommand(action: string, data: Record<string, unknown> = {}): Promise<WorkerResult> {
  if (!activeWorker) throw new Error('Start a ParaView session first.');
  assertNoVideoExport();
  if (action === 'workspace_restore') data = { workspace: parseParaViewWorkspace(data.workspace) };
  if (action === 'analysis_probe') data = { ...probeRequest(data) };
  if (action === 'find_data' || action === 'selection_extract') data = { ...findDataRequest(data) };
  if (action === 'cfd_diagnostic') data = { ...diagnosticRequest(data) };
  if (action === 'resample_to_image') data = { ...resampleRequest(data) };
  if (action === 'update' && data.volume !== undefined) data = { ...data, volume: volumeSettings(data.volume) };
  if (action === 'update' && data.diagnostic !== undefined) data = { ...data, diagnostic: diagnosticSettings(data.diagnostic) };
  if (action === 'update' && data.selection !== undefined) data = { ...data, selection: selectionRecipe(data.selection) };
  if (action === 'update' && data.resample !== undefined) {
    const value = data.resample as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'dimensions')) throw new Error('Invalid resampling settings.');
    data = { ...data, resample: { dimensions: resampleRequest({ id: 'reader', revision: 0, time: 0, dimensions: value.dimensions }).dimensions } };
  }
  return activeWorker.request(action, data);
}

// ── Video export ──
//
// The export runs inside the session's own pvpython, so the video shows exactly
// the pipeline on screen. That process answers one request at a time, so while
// it renders frames the workbench is locked (assertNoVideoExport) and follows
// the job through getParaViewVideoJob; cancelling drops a file the worker
// checks between frames, because its stdin is not read until the export ends.

export type ParaViewVideoStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ParaViewVideoJob {
  id: number;
  caseName: string;
  status: ParaViewVideoStatus;
  frame: number;
  total: number;
  /** Video duration in seconds. */
  seconds: number;
  format: VideoFormat;
  fileName: string;
  startedAt: number;
  finishedAt: number | null;
  bytes: number | null;
  error: string | null;
  /** Where "Save in the case" put it, relative to the case. */
  savedInCase: string | null;
}

type InternalVideoJob = ParaViewVideoJob & { file: string | null; worker: ParaViewWorker };

let videoJob: InternalVideoJob | null = null;
let nextVideoJobId = 1;

function publicJob(job: InternalVideoJob | null): ParaViewVideoJob | null {
  if (!job) return null;
  const { file: _file, worker: _worker, ...rest } = job;
  return rest;
}

function assertNoVideoExport(): void {
  if (videoJob?.status === 'running' && videoJob.worker === activeWorker) {
    throw new Error('A video export is running. Wait for it to finish or cancel it.');
  }
}

export function getParaViewVideoJob(): ParaViewVideoJob | null {
  return publicJob(videoJob);
}

/** The worker's copy of a request: the plan's frames and the views, validated again there. */
function workerVideoData(request: VideoRequest, plan: VideoPlan, frames = plan.frames): Record<string, unknown> {
  return {
    format: request.format,
    width: plan.width,
    height: plan.height,
    fps: request.fps,
    interpolate: request.interpolate,
    colorRange: request.colorRange,
    segments: request.segments.map(segment => segment.view),
    frames: frames.map(frame => [frame.time, frame.segment, frame.blend]),
  };
}

async function planForWorker(worker: ParaViewWorker, request: VideoRequest): Promise<VideoPlan> {
  const current = await worker.request('state');
  const plan = buildVideoPlan(current.state?.times || [], request);
  if (!(current.state?.videoFormats || []).includes(request.format)) {
    throw new Error(`This ParaView build cannot write ${request.format.toUpperCase()} videos.`);
  }
  return plan;
}

export interface ParaViewVideoEstimate {
  frames: number;
  seconds: number;
  /** Measured on a few frames of this case; null when there was nothing to measure. */
  renderSeconds: number | null;
  /** What to ask before exporting, or null when the export can simply start. */
  confirm: string | null;
}

/**
 * Render a few frames of the requested video without writing them, and turn
 * their timing into an estimate of the whole export — long ones are confirmed
 * rather than refused.
 */
export async function estimateParaViewVideo(request: VideoRequest): Promise<ParaViewVideoEstimate> {
  const worker = activeWorker;
  if (!worker) throw new Error('Start a ParaView session first.');
  assertNoVideoExport();
  const plan = await planForWorker(worker, request);
  const result = await worker.request('video_benchmark', workerVideoData(request, plan, benchmarkFrames(plan)), 10 * 60_000);
  const durations = result.benchmark?.durations;
  const renderSeconds = Array.isArray(durations) ? estimateRenderSeconds(plan, durations) : null;
  return {
    frames: plan.frames.length,
    seconds: plan.seconds,
    renderSeconds,
    confirm: videoConfirmation(plan.seconds, plan.frames.length, renderSeconds),
  };
}

export async function startParaViewVideoExport(request: VideoRequest): Promise<ParaViewVideoJob> {
  const worker = activeWorker;
  if (!worker) throw new Error('Start a ParaView session first.');
  assertNoVideoExport();
  const plan = await planForWorker(worker, request);
  // Only the latest video is kept; it lives in the session's temporary folder.
  if (videoJob?.file) await fs.rm(videoJob.file, { force: true }).catch(() => undefined);

  const job: InternalVideoJob = {
    id: nextVideoJobId++,
    caseName: worker.caseName,
    status: 'running',
    frame: 0,
    total: plan.frames.length,
    seconds: plan.seconds,
    format: request.format,
    fileName: videoFileName(worker.caseName, request.format),
    startedAt: Date.now(),
    finishedAt: null,
    bytes: null,
    error: null,
    savedInCase: null,
    file: null,
    worker,
  };
  videoJob = job;
  worker.onVideoProgress = (frame, total) => {
    if (videoJob === job) { job.frame = frame; job.total = total || job.total; }
  };
  // A frame of a large case can take seconds; the ceiling only catches a hang.
  const timeout = Math.min(48 * 3_600_000, COMMAND_TIMEOUT_MS + plan.frames.length * 20_000);
  void worker.request('export_video', workerVideoData(request, plan), timeout).then(async result => {
    if (videoJob !== job) return;
    const video = result.video || {};
    job.finishedAt = Date.now();
    job.frame = Number(video.frames) || job.frame;
    if (video.cancelled || !video.video) {
      job.status = 'cancelled';
      return;
    }
    job.file = video.video;
    job.bytes = (await fs.stat(video.video).catch(() => null))?.size ?? null;
    job.status = 'done';
  }, error => {
    if (videoJob !== job) return;
    job.finishedAt = Date.now();
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
  }).finally(() => {
    worker.onVideoProgress = () => undefined;
  });
  return publicJob(job)!;
}

export async function cancelParaViewVideoExport(): Promise<ParaViewVideoJob | null> {
  if (videoJob?.status === 'running') {
    await fs.writeFile(path.join(videoJob.worker.tempDir, 'cancel-video'), '').catch(() => undefined);
  }
  return publicJob(videoJob);
}

/** The finished video file, for download. */
export function getParaViewVideoFile(): { file: string; fileName: string; format: VideoFormat } | null {
  if (videoJob?.status !== 'done' || !videoJob.file) return null;
  return { file: videoJob.file, fileName: videoJob.fileName, format: videoJob.format };
}

/**
 * Copy the finished video into <case>/postProcessing/videos. The case folder
 * is the marker's folder: the same WSL path the session reads.
 */
export async function saveParaViewVideoInCase(): Promise<ParaViewVideoJob> {
  const job = videoJob;
  if (!job || job.status !== 'done' || !job.file) throw new Error('There is no finished video to save.');
  const targetDir = path.join(path.dirname(job.worker.markerPath), 'postProcessing', 'videos');
  await fs.mkdir(targetDir, { recursive: true });
  const extension = path.extname(job.fileName);
  const stem = job.fileName.slice(0, -extension.length);
  let name = job.fileName;
  for (let n = 2; await fs.stat(path.join(targetDir, name)).then(() => true, () => false); n += 1) {
    name = `${stem}-${n}${extension}`;
  }
  await fs.copyFile(job.file, path.join(targetDir, name));
  job.savedInCase = `postProcessing/videos/${name}`;
  return publicJob(job)!;
}

export async function readParaViewRender(width: number, height: number, quality = 92): Promise<Buffer> {
  assertNoVideoExport();
  const result = await sendParaViewCommand('render', { width, height, quality });
  if (!result.image) throw new Error('ParaView did not return a rendered image.');
  try {
    return await fs.readFile(result.image);
  } finally {
    await fs.rm(result.image, { force: true }).catch(() => undefined);
  }
}

export async function sendParaViewCameraCommand(data: Record<string, unknown>): Promise<Buffer> {
  if (!activeWorker) throw new Error('Start a ParaView session first.');
  assertNoVideoExport();
  const result = await activeWorker.request(
    String(data.action || 'camera'),
    Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'action')),
  );
  if (!result.image) throw new Error('ParaView did not return a rendered image.');
  try {
    return await fs.readFile(result.image);
  } finally {
    await fs.rm(result.image, { force: true }).catch(() => undefined);
  }
}

export async function stopParaViewSession(cancelStarts = true): Promise<void> {
  if (cancelStarts) await abortParaViewStartup();
  const worker = activeWorker;
  activeWorker = null;
  if (worker) await worker.stop();
}

// ── Warming the installation before anyone asks for it ──
//
// A cold start is not ParaView being slow, it is Windows meeting ParaView for
// the first time since the machine booted: `from paraview.simple import *`
// loads hundreds of the ~2,200 DLLs and Python modules in a 4 GB tree, reading
// each from disk while the real-time antivirus scans it. Measured on the
// reference machine at ~107 s after a reboot, 36 s with the cache half gone,
// and 1.4-1.9 s once Windows has the files. Nothing in the app makes the first
// load faster; what it can do is pay for it while the user is on the
// Dashboard, meshing or running, instead of while they stare at the ParaView
// tab. Keep that engine alive, so opening the tab reuses its libraries and GL
// context instead of repeating the import and first render in a new process.

/**
 * What the warm-up executes: the same flags the workbench engine is launched
 * with, the same import, and one offscreen render — so the libraries it pulls
 * into the cache are the ones the engine will ask for, rendering stack
 * included. Measured warm at 5 s against 1.4 s for the import alone; the
 * difference is exactly the part a bare import would have left cold.
 */
export const PARAVIEW_RENDER_ARGS = ['--force-offscreen-rendering', '--opengl-window-backend', 'Win32'] as const;
const WARMUP_SCRIPT = String.raw`
import json, sys
sys.stdout.write('__OFSTUDIO_JSON__' + json.dumps({'id': -1, 'stage': 'interpreter'}) + '\n')
sys.stdout.flush()
from paraview.simple import *
sys.stdout.write('__OFSTUDIO_JSON__' + json.dumps({'id': -1, 'stage': 'engine'}) + '\n')
sys.stdout.flush()
_ofstudio_warm_view = CreateRenderView()
Render(_ofstudio_warm_view)
sys.stdout.write('__OFSTUDIO_JSON__' + json.dumps({'id': 0, 'ok': True, 'result': {}}) + '\n')
sys.stdout.flush()
if len(sys.argv) >= 3:
    worker_file, output_dir = sys.argv[1:3]
    for line in sys.__stdin__:
        request = json.loads(line)
        if request.get('action') == 'quit':
            sys.stdout.write('__OFSTUDIO_JSON__' + json.dumps({'id': request['id'], 'ok': True, 'result': {}}) + '\n')
            sys.stdout.flush()
            break
        if request.get('action') != 'activate':
            raise RuntimeError('This prepared engine has no active case.')
        data = request['data']
        _ofstudio_ready_id = request['id']
        sys.argv = [worker_file, data['marker'], output_dir, data['case'], data['version']]
        with open(worker_file, encoding='utf-8') as source:
            exec(compile(source.read(), worker_file, 'exec'), globals())
        break
`;
/** Longer than any cold start measured; only a real hang reaches it. */
const WARMUP_TIMEOUT_MS = 10 * 60_000;

export function paraViewWarmupArgs(workerFile?: string, outputDir?: string): string[] {
  return [...PARAVIEW_RENDER_ARGS, '-c', WARMUP_SCRIPT, ...(workerFile && outputDir ? [workerFile, outputDir] : [])];
}

export type ParaViewWarmupState = 'warming' | 'warm' | 'failed';

export interface ParaViewWarmupStatus {
  state: ParaViewWarmupState;
  pvpythonPath: string;
  elapsedMs: number;
  error?: string;
}

let warmup: {
  pvpythonPath: string;
  state: ParaViewWarmupState;
  startedAt: number;
  finishedAt: number | null;
  error?: string;
  worker: ParaViewWorker | null;
} | null = null;

export function getParaViewWarmup(): ParaViewWarmupStatus | null {
  if (!warmup) return null;
  return {
    state: warmup.state,
    pvpythonPath: warmup.pvpythonPath,
    elapsedMs: (warmup.finishedAt ?? Date.now()) - warmup.startedAt,
    ...(warmup.error ? { error: warmup.error } : {}),
  };
}

let warmupGeneration = 0;

/** Release only the idle engine; an adopted case belongs to its session. */
export async function stopParaViewWarmup(): Promise<void> {
  warmupGeneration += 1;
  const worker = warmup?.worker;
  warmup = null;
  if (worker) await worker.stop(false);
}

/**
 * Load ParaView once in the background so the workbench later starts warm.
 *
 * Once per installation per app process: a Dashboard that mounts again, or
 * asks twice, joins the warm-up already done or running rather than paying
 * for another. A session already running or starting has warmed the cache
 * itself, so there is nothing to do. The process runs below normal priority,
 * waits on its pipe with no case loaded. A failure only means the workbench
 * will start cold, as it did before, so it is reported and never retried in a
 * loop.
 */
export async function warmParaView(customPath = ''): Promise<ParaViewWarmupStatus | null> {
  const generation = warmupGeneration;
  if (activeWorker?.isRunning || startup) return getParaViewWarmup();
  const installation = await findParaView(customPath);
  if (generation !== warmupGeneration) return getParaViewWarmup();
  if (activeWorker?.isRunning || startup) return getParaViewWarmup();
  if (!installation.found || !installation.pvpythonPath) return null;
  const pvpythonPath = installation.pvpythonPath;

  if (warmup && warmup.pvpythonPath === pvpythonPath && warmup.state !== 'failed') {
    return getParaViewWarmup();
  }
  // A different installation was chosen while the previous one was warming:
  // that cache is the wrong one to fill.
  if (warmup?.worker) await warmup.worker.stop(false);
  if (generation !== warmupGeneration) return getParaViewWarmup();
  if (activeWorker?.isRunning || startup) return getParaViewWarmup();

  const entry: NonNullable<typeof warmup> = {
    pvpythonPath, state: 'warming', startedAt: Date.now(), finishedAt: null, worker: null,
  };
  warmup = entry;

  const finish = (state: ParaViewWarmupState, error?: string) => {
    if (entry.state !== 'warming') return;
    entry.state = state;
    entry.finishedAt = Date.now();
    if (error) entry.error = error;
  };

  let tempDir = '';
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openfoam-studio-paraview-session-'));
    const scriptPath = path.join(tempDir, 'worker.py');
    await fs.writeFile(scriptPath, WORKER_SCRIPT, { encoding: 'utf-8', mode: 0o600 });
    if (warmup !== entry || startup || activeWorker?.isRunning) {
      await fs.rm(tempDir, { recursive: true, force: true });
      finish('failed', 'A case started before the prepared engine was launched.');
      return getParaViewWarmup();
    }
    const child = spawn(pvpythonPath, paraViewWarmupArgs(scriptPath, tempDir), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    const worker = new ParaViewWorker(child, tempDir, '', pvpythonPath, installation.version || 'unknown', '');
    entry.worker = worker;
    // Below normal, so the warm-up yields to whatever the user is actually
    // doing — a solve in WSL, the mesh view, another application.
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    }
    const timer = setTimeout(() => {
      if (entry.state === 'warming') {
        void worker.stop(false);
        finish('failed', 'ParaView did not finish loading within ten minutes.');
      }
    }, WARMUP_TIMEOUT_MS);
    void worker.waitUntilReady(() => undefined).then(() => {
      clearTimeout(timer);
      finish('warm');
    }, error => {
      clearTimeout(timer);
      finish('failed', error.message);
      void worker.stop(false);
    });
    child.once('exit', () => {
      if (entry.worker !== worker) return;
      entry.worker = null;
      entry.state = 'failed';
      entry.error = 'The prepared ParaView engine stopped.';
    });
  } catch (error) {
    if (tempDir && !entry.worker) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    finish('failed', error instanceof Error ? error.message : 'ParaView could not be launched.');
  }
  return getParaViewWarmup();
}
