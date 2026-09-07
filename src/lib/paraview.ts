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

export interface ParaViewPipelineNode {
  id: string;
  label: string;
  type: 'OpenFOAMReader' | 'Slice' | 'Clip' | 'Contour' | 'CellDatatoPointData';
  parent: string | null;
  visible: boolean;
  representation: string;
  opacity: number;
  color: { association: 'SOLID' | 'CELLS' | 'POINTS'; name: string; preset: string; legend: boolean };
  origin?: [number, number, number];
  normal?: [number, number, number];
  invert?: boolean;
  contour?: { association: 'CELLS' | 'POINTS'; name: string; value: number };
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
nodes = OrderedDict()
selected_id = 'reader'
current_time = 0.0
next_filter = 1

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
        'color': node['color'],
    }
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
    }

def apply_display(node):
    display = node['display']
    display.Representation = node['representation']
    display.Opacity = node['opacity']
    display.Visibility = 1 if node['visible'] else 0
    color = node['color']
    if color['association'] == 'SOLID' or not color['name']:
        ColorBy(display, None)
        display.SetScalarBarVisibility(view, False)
        return
    ColorBy(display, (color['association'], color['name']))
    try:
        display.RescaleTransferFunctionToDataRange(True, False)
        lut = GetColorTransferFunction(color['name'])
        if color['preset'] in available_presets: lut.ApplyPreset(color['preset'], True)
    except Exception:
        pass
    display.SetScalarBarVisibility(view, bool(color['legend']))

def render(identifier, width, height):
    width = max(320, min(1920, int(width or 1000)))
    height = max(240, min(1200, int(height or 700)))
    view.ViewSize = [width, height]
    Render(view)
    filename = os.path.join(output_dir, 'render_' + str(identifier) + '.jpg')
    SaveScreenshot(filename, view, ImageResolution=[width, height], Quality=92)
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

def refresh_reader():
    global times, current_time
    try: reader.Refresh()
    except Exception: pass
    reader.UpdatePipelineInformation()
    refreshed = [float(v) for v in list(reader.TimestepValues)]
    times = refreshed if refreshed else [0.0]
    # Follow a newly written solver result, which is the useful meaning of
    # Refresh in a post-processing workbench.
    set_time(times[-1])
    scene.UpdateAnimationUsingDataTimeSteps()

def selected_node():
    return nodes[selected_id]

def add_filter(kind):
    global selected_id, next_filter
    if kind not in ('Slice', 'Clip', 'Contour', 'CellDatatoPointData'):
        raise RuntimeError('Unsupported ParaView filter: ' + str(kind))
    parent_id = selected_id
    parent = nodes[parent_id]
    label = kind.replace('Datato', ' Data to ') + str(next_filter)
    identifier = 'filter-' + str(next_filter)
    next_filter += 1
    kwargs = {'registrationName': label, 'Input': parent['proxy']}
    if kind == 'Slice': proxy = Slice(**kwargs)
    elif kind == 'Clip': proxy = Clip(**kwargs)
    elif kind == 'CellDatatoPointData': proxy = CellDatatoPointData(**kwargs)
    else:
        candidates = [a for a in arrays_for(parent['proxy']) if a['association'] == 'POINTS']
        if not candidates:
            raise RuntimeError('Contour needs point data. Add Cell Data to Point Data first.')
        chosen = candidates[0]
        proxy = Contour(**kwargs)
        proxy.ContourBy = ['POINTS', chosen['name']]
        value = (chosen['range'][0] + chosen['range'][1]) / 2.0
        proxy.Isosurfaces = [value]
    proxy.UpdatePipeline(time=current_time)
    Hide(parent['proxy'], view)
    parent['visible'] = False
    parent['display'].Visibility = 0
    display = Show(proxy, view)
    display.Representation = 'Surface'
    node = {
        'proxy': proxy, 'display': display, 'label': label, 'type': kind,
        'parent': parent_id, 'visible': True, 'representation': 'Surface',
        'opacity': 1.0,
        'color': {'association': 'SOLID', 'name': '', 'preset': 'Cool to Warm', 'legend': False},
    }
    if kind == 'Contour':
        node['contour'] = {'association': 'POINTS', 'name': chosen['name'], 'value': value}
    nodes[identifier] = node
    selected_id = identifier
    ResetCamera(view)

def delete_selected():
    global selected_id
    if selected_id == 'reader': raise RuntimeError('The OpenFOAM reader cannot be deleted.')
    if any(node['parent'] == selected_id for node in nodes.values()):
        raise RuntimeError('Delete child filters first.')
    identifier = selected_id
    parent_id = nodes[identifier]['parent']
    Delete(nodes[identifier]['proxy'])
    del nodes[identifier]
    selected_id = parent_id
    parent = nodes[parent_id]
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
    if 'visible' in data: node['visible'] = bool(data['visible'])
    if 'color' in data:
        color = data['color'] if isinstance(data['color'], dict) else {}
        association = color.get('association', 'SOLID')
        name = str(color.get('name', ''))
        valid = association == 'SOLID' or any(a['association'] == association and a['name'] == name for a in arrays_for(node['proxy']))
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
    node['proxy'].UpdatePipeline(time=current_time)
    apply_display(node)

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
    try:
        prop = getattr(reader, property_name)
        setattr(reader, property_name, list(prop.Available))
    except Exception: pass
times = [float(v) for v in list(reader.TimestepValues)]
if not times: times = [0.0]
current_time = times[-1]
reader.UpdatePipeline(time=current_time)

view = CreateRenderView()
view.ViewSize = [1000, 700]
view.Background = [0.18, 0.20, 0.24]
view.OrientationAxesVisibility = 1
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
    'representation': 'Surface', 'opacity': 1.0,
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
            emit(identifier, True, {'state': state()})
        elif action == 'add_filter':
            add_filter(str(data.get('filter', '')))
            emit(identifier, True, {'state': state()})
        elif action == 'delete':
            delete_selected(); emit(identifier, True, {'state': state()})
        elif action == 'update':
            update_selected(data); emit(identifier, True, {'state': state()})
        elif action == 'time':
            set_time(data.get('time')); emit(identifier, True, {'state': state()})
        elif action == 'refresh':
            refresh_reader(); emit(identifier, True, {'state': state()})
        elif action == 'reset_camera':
            ResetCamera(view); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'))})
        elif action == 'standard_view':
            standard_view(str(data.get('view', 'Iso'))); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'))})
        elif action == 'camera':
            camera(data); emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'))})
        elif action == 'render':
            emit(identifier, True, {'image': render(identifier, data.get('width'), data.get('height'))})
        elif action == 'quit':
            emit(identifier, True, {}); break
        else: raise RuntimeError('Unsupported ParaView action.')
    except Exception as error:
        emit(locals().get('identifier', -1), False, error=str(error))
`;

type WorkerResult = { state?: ParaViewWorkbenchState; image?: string };
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

export async function readParaViewRender(width: number, height: number): Promise<Buffer> {
  const result = await sendParaViewCommand('render', { width, height });
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
