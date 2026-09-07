import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ParaViewInstallation {
  found: boolean;
  pvpythonPath?: string;
  version?: string;
  source?: string;
  searched: string[];
  error?: string;
}

type Candidate = { executable: string; source: string };

let cachedInstallation: ParaViewInstallation | null = null;
let cachedKey = '';

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

/** Turn a user/registry/PATH result into the plausible pvpython executables it represents. */
export function paraViewExecutableCandidates(value: string): string[] {
  const clean = value.trim().replace(/^"|"$/g, '');
  if (!clean) return [];
  const base = path.basename(clean).toLowerCase();
  const dir = base.endsWith('.exe') ? path.dirname(clean) : clean;
  const out: string[] = [];
  if (base === 'pvpython.exe' || base === 'pvpython') out.push(clean);
  if (base === 'paraview.exe' || base === 'paraview') out.push(path.join(dir, 'pvpython.exe'));
  out.push(path.join(dir, 'pvpython.exe'), path.join(dir, 'bin', 'pvpython.exe'));
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

async function findPvpythonBelow(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0) return;
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'pvpython.exe') found.push(full);
      else if (entry.isDirectory()) await walk(full, depth - 1);
    }
  };
  await walk(root, maxDepth);
  return found;
}

async function pathResults(): Promise<string[]> {
  const results: string[] = [];
  for (const name of ['pvpython.exe', 'paraview.exe']) {
    try {
      const output = await execFileText('where.exe', [name], 5_000);
      results.push(...output.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    } catch { /* not on PATH */ }
  }
  return results;
}

async function registryResults(): Promise<string[]> {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const results: string[] = [];
  for (const root of roots) {
    try {
      const output = await execFileText('reg.exe', ['query', root, '/s'], 12_000);
      const blocks = output.split(/\r?\n\r?\n/).filter(block => /ParaView/i.test(block));
      for (const block of blocks) {
        for (const match of block.matchAll(/^\s*(?:InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/gmi)) {
          results.push(match[1].trim().replace(/,\d+$/, ''));
        }
      }
    } catch { /* missing/inaccessible registry hive */ }
  }
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const output = await execFileText('reg.exe', [
        'query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\paraview.exe`, '/ve',
      ], 5_000);
      const match = output.match(/REG_\w+\s+(.+)$/mi);
      if (match) results.push(match[1].trim());
    } catch { /* no App Paths entry */ }
  }
  return results;
}

async function standardInstallResults(): Promise<string[]> {
  const roots = [...new Set([
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter((v): v is string => Boolean(v)))];
  const results: string[] = [];
  for (const root of roots) {
    let entries: Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/paraview/i.test(entry.name)) continue;
      results.push(...await findPvpythonBelow(path.join(root, entry.name), 4));
    }
  }
  return results;
}

async function expandCandidate(value: string, source: string, recursive: boolean): Promise<Candidate[]> {
  const out = paraViewExecutableCandidates(value).map(executable => ({ executable, source }));
  const clean = value.trim().replace(/^"|"$/g, '');
  if (recursive && await isDirectory(clean)) {
    for (const executable of await findPvpythonBelow(clean, 4)) out.push({ executable, source });
  }
  return out;
}

async function probe(candidate: Candidate): Promise<ParaViewInstallation | null> {
  if (!await isFile(candidate.executable)) return null;
  try {
    const output = await execFileText(candidate.executable, ['--version']);
    const match = output.match(/(?:ParaView[^\d]*)?(\d+\.\d+(?:\.\d+)?)/i);
    if (!match) return null;
    return {
      found: true,
      pvpythonPath: path.resolve(candidate.executable),
      version: match[1],
      source: candidate.source,
      searched: [],
    };
  } catch { return null; }
}

/** Find the newest usable ParaView, regardless of its versioned folder name. */
export async function findParaView(customPath = '', refresh = false): Promise<ParaViewInstallation> {
  const key = customPath.trim().toLowerCase();
  if (!refresh && cachedInstallation && cachedKey === key) return cachedInstallation;

  const candidates: Candidate[] = [];
  if (customPath) {
    candidates.push(...await expandCandidate(customPath, 'Custom path', true));
    const unique = [...new Map(candidates.map(c => [c.executable.toLowerCase(), c])).values()];
    const valid = (await Promise.all(unique.map(probe))).filter((v): v is ParaViewInstallation => Boolean(v));
    valid.sort((a, b) => compareParaViewVersions(b.version || '0', a.version || '0'));
    if (valid[0]) {
      cachedInstallation = { ...valid[0], searched: unique.map(c => c.executable) };
      cachedKey = key;
      return cachedInstallation;
    }
    // A portable installation may have moved since the path was saved. Keep
    // searching the machine so a stale override never disables discovery.
  }
  if (process.env.OFSTUDIO_PARAVIEW_PATH) {
    candidates.push(...await expandCandidate(process.env.OFSTUDIO_PARAVIEW_PATH, 'OFSTUDIO_PARAVIEW_PATH', true));
  }
  for (const value of await pathResults()) candidates.push(...await expandCandidate(value, 'PATH', false));
  for (const value of await registryResults()) candidates.push(...await expandCandidate(value, 'Windows registry', true));
  for (const executable of await standardInstallResults()) candidates.push({ executable, source: 'Standard install folders' });

  const unique = [...new Map(candidates.map(c => [c.executable.toLowerCase(), c])).values()];
  const valid = (await Promise.all(unique.map(probe))).filter((v): v is ParaViewInstallation => Boolean(v));
  const searched = unique.map(c => c.executable);
  valid.sort((a, b) => compareParaViewVersions(b.version || '0', a.version || '0'));
  const result = valid[0]
    ? { ...valid[0], searched }
    : {
        found: false,
        searched,
        error: customPath
          ? 'The selected path is not usable and no other ParaView installation was found.'
          : 'ParaView was not found. Install it or enter its folder or pvpython.exe path.',
      };
  cachedInstallation = result;
  cachedKey = key;
  return result;
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
  | 'TemporalStatistics';

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
  representation: string;
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
  manipulatorAvailable: boolean;
  manipulatorVisible: boolean;
}

export interface ParaViewWorkbenchState {
  caseName: string;
  version: string;
  selectedId: string;
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
}

// A persistent pvpython process owns the ParaView pipeline. The browser can
// request only these app-defined operations; no Python or arbitrary property
// names ever cross the API boundary.
const WORKER_SCRIPT = String.raw`
import json, math, os, sys, traceback
from collections import OrderedDict
from paraview.simple import *

PREFIX = '__OFSTUDIO_JSON__'
marker, output_dir, case_name, pv_version = sys.argv[1:5]
case_root = os.path.realpath(os.path.dirname(marker))
nodes = OrderedDict()
guides = {}
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

def node_state(identifier, node):
    state = {
        'id': identifier, 'label': node['label'], 'type': node['type'],
        'parent': node['parent'], 'visible': node['visible'],
        'representation': node['representation'], 'opacity': node['opacity'],
        'lineWidth': node['lineWidth'], 'pointSize': node['pointSize'],
        'color': node['color'],
        'manipulatorAvailable': node['type'] in ('Slice', 'Clip', 'StreamTracer', 'PlotOverLine'),
        'manipulatorVisible': manipulator_visible and identifier == selected_id,
    }
    if node.get('filePath'): state['filePath'] = node['filePath']
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
    active.UpdatePipeline(time=current_time)
    info = active.GetDataInformation()
    return {
        'caseName': case_name, 'version': pv_version, 'selectedId': selected_id,
        'pipeline': [node_state(identifier, node) for identifier, node in nodes.items()],
        'arrays': arrays_for(active), 'times': times, 'time': current_time,
        'points': int(info.GetNumberOfPoints()), 'cells': int(info.GetNumberOfCells()),
        'bounds': bounds_for(active), 'presets': available_presets,
        'availableFilters': filter_capabilities(),
        'reader': reader_metadata(), 'view': view_metadata(),
    }

def apply_display(node):
    display = node['display']
    display.Representation = node['representation']
    display.Opacity = node['opacity']
    display.Visibility = 1 if node['visible'] else 0
    set_if_supported(display, 'LineWidth', node['lineWidth'])
    set_if_supported(display, 'PointSize', node['pointSize'])
    set_if_supported(display, 'EdgeColor', [0.08, 0.08, 0.08])
    color = node['color']
    if color['association'] == 'SOLID' or not color['name']:
        # ParaView 6 raises "invalid association NONE" from ColorBy(None) for
        # OpenFOAM meshes without result arrays. Setting ColorArrayName is the
        # cross-version equivalent and keeps all representations available.
        try: display.ColorArrayName = [None, '']
        except Exception:
            try: ColorBy(display, None)
            except Exception: pass
        try: display.SetScalarBarVisibility(view, False)
        except Exception: pass
        return
    if color['association'] == 'BLOCKS':
        try: ColorBy(display, ('FIELD', 'vtkBlockColors'))
        except Exception:
            try: display.ColorArrayName = [None, '']
            except Exception: pass
        try: display.SetScalarBarVisibility(view, False)
        except Exception: pass
        return
    ColorBy(display, (color['association'], color['name']))
    try:
        display.RescaleTransferFunctionToDataRange(True, False)
        lut = GetColorTransferFunction(color['name'])
        if color['preset'] in available_presets: lut.ApplyPreset(color['preset'], True)
    except Exception:
        pass
    display.SetScalarBarVisibility(view, bool(color['legend']))

def render(identifier, width, height, quality=92):
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
    for node in nodes.values():
        node['proxy'].UpdatePipeline(time=current_time)
    for node in nodes.values(): apply_display(node)

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
        parent['display'].Visibility = 0
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
        display = Show(proxy, view)
        identifier = 'source-' + str(next_filter)
        next_filter += 1
        nodes[identifier] = {
            'proxy': proxy, 'display': display, 'label': label,
            'type': 'CaseFileReader', 'parent': None, 'filePath': safe_relative,
            'visible': True, 'representation': 'Surface', 'opacity': 1.0,
            'lineWidth': 1.0, 'pointSize': 3.0,
            'color': {'association': 'SOLID', 'name': '', 'preset': available_presets[0] if available_presets else '', 'legend': False},
        }
        selected_id = identifier
        set_manipulator(False)
        apply_display(nodes[identifier])
        ResetCamera(view)
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
    parent['visible'] = True
    parent['display'].Visibility = 1
    ResetCamera(view)

def update_selected(data):
    node = selected_node()
    display = node['display']
    if 'representation' in data:
        allowed = ('Surface', 'Surface With Edges', 'Wireframe', 'Points', 'Outline')
        if data['representation'] not in allowed: raise RuntimeError('Unsupported representation.')
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

view = CreateRenderView()
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
nodes['reader'] = {
    'proxy': reader, 'display': display, 'label': os.path.basename(marker),
    'type': 'OpenFOAMReader', 'parent': None, 'visible': True,
    'representation': 'Surface', 'opacity': 1.0, 'lineWidth': 1.0, 'pointSize': 3.0,
    'color': {'association': 'SOLID', 'name': '', 'preset': available_presets[0] if available_presets else '', 'legend': False},
}
ResetCamera(view)
emit(0, True, {'state': state()})

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
            nodes[candidate]['visible'] = bool(data.get('visible'))
            apply_display(nodes[candidate])
            emit(identifier, True, {'state': state()})
        elif action == 'add_filter':
            add_filter(str(data.get('filter', '')))
            emit(identifier, True, {'state': state()})
        elif action == 'delete':
            delete_selected(); emit(identifier, True, {'state': state()})
        elif action == 'update':
            update_selected(data); emit(identifier, True, {'state': state()})
        elif action == 'update_reader':
            update_reader(data); emit(identifier, True, {'state': state()})
        elif action == 'update_view':
            update_view(data); emit(identifier, True, {'state': state()})
        elif action == 'set_manipulator':
            set_manipulator(data.get('enabled')); emit(identifier, True, {'state': state()})
        elif action == 'list_case_files':
            emit(identifier, True, {'files': list_case_files()})
        elif action == 'open_case_file':
            open_case_file(data.get('path')); emit(identifier, True, {'state': state()})
        elif action == 'time':
            set_time(data.get('time')); emit(identifier, True, {'state': state()})
        elif action == 'refresh':
            refresh_reader(); emit(identifier, True, {'state': state()})
        elif action == 'reset_camera':
            ResetCamera(view); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'standard_view':
            standard_view(str(data.get('view', 'Iso'))); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'camera':
            camera(data); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'manipulate':
            manipulate(data); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
        elif action == 'render':
            emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'), data.get('quality'))})
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

type WorkerResult = { state?: ParaViewWorkbenchState; image?: string; files?: ParaViewCaseFile[] };
type Pending = {
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class ParaViewWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tempDir: string;
  readonly caseName: string;
  readonly pvpythonPath: string;
  readonly version: string;
  private buffer = '';
  private stderr = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private alive = true;
  private readyPromise: Promise<WorkerResult>;

  constructor(child: ChildProcessWithoutNullStreams, tempDir: string, caseName: string, pvpythonPath: string, version: string) {
    this.child = child;
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
    this.readyPromise = this.waitFor(0, 240_000);
  }

  waitUntilReady(): Promise<WorkerResult> {
    return this.readyPromise;
  }

  get isRunning(): boolean {
    return this.alive;
  }

  request(action: string, data: Record<string, unknown> = {}, timeout = 120_000): Promise<WorkerResult> {
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
          id: number; ok: boolean; result?: WorkerResult; error?: string;
        };
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

  async stop(): Promise<void> {
    if (this.alive) {
      try { await this.request('quit', {}, 2_000); } catch { /* force below */ }
      this.alive = false;
      this.child.kill();
    }
    await fs.rm(this.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

let activeWorker: ParaViewWorker | null = null;

export async function startParaViewSession(
  caseName: string,
  markerPath: string,
  customPath = '',
): Promise<ParaViewWorkbenchState> {
  const installation = await findParaView(customPath);
  if (!installation.found || !installation.pvpythonPath) {
    throw new Error(installation.error || 'ParaView was not found. Configure it from the Dashboard.');
  }
  if (activeWorker) {
    await activeWorker.stop();
    activeWorker = null;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openfoam-studio-paraview-session-'));
  const scriptPath = path.join(tempDir, 'worker.py');
  await fs.writeFile(scriptPath, WORKER_SCRIPT, { encoding: 'utf-8', mode: 0o600 });
  const child = spawn(installation.pvpythonPath, [
    '--force-offscreen-rendering', '--opengl-window-backend', 'Win32',
    scriptPath, markerPath, tempDir, caseName, installation.version || 'unknown',
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const worker = new ParaViewWorker(
    child, tempDir, caseName, installation.pvpythonPath, installation.version || 'unknown'
  );
  try {
    const ready = await worker.waitUntilReady();
    if (!ready.state) throw new Error('ParaView started without returning its pipeline state.');
    activeWorker = worker;
    return ready.state;
  } catch (error) {
    await worker.stop();
    throw error;
  }
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

export async function sendParaViewCommand(action: string, data: Record<string, unknown> = {}): Promise<WorkerResult> {
  if (!activeWorker) throw new Error('Start a ParaView session first.');
  return activeWorker.request(action, data);
}

export async function readParaViewRender(width: number, height: number, quality = 92): Promise<Buffer> {
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

export async function stopParaViewSession(): Promise<void> {
  const worker = activeWorker;
  activeWorker = null;
  if (worker) await worker.stop();
}
