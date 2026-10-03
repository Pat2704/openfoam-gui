import type { ParaViewNodeType } from './paraview';
import type { ParaViewViewSnapshot, VideoRequest } from './paraview-video';
import { isValidCaseName } from './case-name';
import { selectionRecipe, diagnosticSettings, volumeSettings, resampleRequest } from './paraview-analysis';

type Rule = 'number' | 'boolean' | 'string' | 'vector' | readonly string[] | { [key: string]: Rule };
const association = ['CELLS', 'POINTS'] as const;
// These are app parameter names, never arbitrary proxy or Python property names.
export const WORKSPACE_PARAMETER_SCHEMA: Record<string, Record<string, Rule>> = {
  OpenFOAMReader: {}, CaseFileReader: {},
  Slice: { origin: 'vector', normal: 'vector' },
  Clip: { origin: 'vector', normal: 'vector', invert: 'boolean' },
  Contour: { contour: { association, name: 'string', value: 'number' } },
  Threshold: { threshold: { association, name: 'string', lower: 'number', upper: 'number' } },
  StreamTracer: { streamTracer: { name: 'string', seedType: ['Point Cloud', 'Line'], center: 'vector', radius: 'number', points: 'number', point1: 'vector', point2: 'vector', resolution: 'number', direction: ['FORWARD', 'BACKWARD', 'BOTH'], maximumLength: 'number' } },
  Tube: { tube: { radius: 'number', sides: 'number' } },
  Calculator: { calculator: { association, expression: 'string', resultName: 'string' } },
  Gradient: { gradient: { association, name: 'string', resultName: 'string' } },
  Glyph: { glyph: { name: 'string', scaleFactor: 'number', maxPoints: 'number' } },
  WarpByVector: { warp: { association, name: 'string', scaleFactor: 'number' } },
  WarpByScalar: { warp: { association, name: 'string', scaleFactor: 'number', normal: 'vector', useNormal: 'boolean' } },
  Transform: { transform: { translate: 'vector', rotate: 'vector', scale: 'vector' } },
  Reflect: { reflect: { origin: 'vector', normal: 'vector', copyInput: 'boolean' } },
  Shrink: { shrink: { factor: 'number' } },
  PlotOverLine: { plotOverLine: { point1: 'vector', point2: 'vector', resolution: 'number' } },
  CellDatatoPointData: {}, PointDatatoCellData: {}, ExtractSurface: {}, CellCenters: {},
  ExtractEdges: {}, Connectivity: {}, IntegrateVariables: {}, TemporalStatistics: {},
  CFDGradient: { diagnostic: { association, name: 'string', prefix: 'string' } },
  Selection: { selection: { block: 'number', association, name: 'string', component: 'number', lower: 'number', upper: 'number' } },
  ResampleToImage: { resample: { dimensions: 'vector' } },
};

export interface ParaViewWorkspaceNode {
  id: string;
  type: ParaViewNodeType;
  parent: string | null;
  filePath?: string;
  parameters: Record<string, unknown>;
}

export interface ParaViewWorkspace {
  format: 'openfoam-studio-paraview';
  version: 1;
  caseName: string;
  paraviewVersion: string;
  selectedId: string;
  reader: { caseType: string; regions: string[] };
  nodes: ParaViewWorkspaceNode[];
  view: ParaViewViewSnapshot;
  centerAxes: boolean;
  video?: VideoRequest;
  clientView?: { mode: 'render' | 'chart' | 'table' | 'split'; chartSourceId?: string };
}

export const MAX_WORKSPACE_BYTES = 1_500_000;
export const MAX_WORKSPACE_NODES = 64;

function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid ${label}.`);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Unsupported ${label} setting.`);
  return value;
}

function validate(raw: unknown, rule: Rule, label: string): void {
  if (Array.isArray(rule)) {
    if (!rule.includes(raw as string)) throw new Error(`Invalid ${label}.`);
  } else if (typeof rule === 'object') {
    const schema = rule as Record<string, Rule>;
    const value = object(raw, Object.keys(schema), label);
    for (const [key, child] of Object.entries(schema)) validate(value[key], child, `${label}.${key}`);
  } else if (rule === 'vector') {
    if (!Array.isArray(raw) || raw.length !== 3) throw new Error(`Invalid ${label}.`);
    raw.forEach(value => validate(value, 'number', label));
  } else if (rule === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1e15) throw new Error(`Invalid ${label}.`);
  } else if (rule === 'string') {
    if (typeof raw !== 'string' || raw.length > 1024 || /[\x00-\x1f]/.test(raw)) throw new Error(`Invalid ${label}.`);
  } else if (typeof raw !== 'boolean') throw new Error(`Invalid ${label}.`);
}

const idValid = (id: unknown): id is string => typeof id === 'string' && /^(reader|(?:filter|source)-[1-9]\d{0,8})$/.test(id);

function parameterBounds(type: string, parameters: Record<string, unknown>): void {
  const range = (raw: unknown, lo: number, hi: number, integer = false) => {
    const number = raw as number;
    if (number < lo || number > hi || (integer && !Number.isInteger(number))) throw new Error(`Invalid ${type} parameter range.`);
  };
  const nonzero = (raw: unknown) => { if (!(raw as number[]).some(value => value !== 0)) throw new Error(`Invalid ${type} direction.`); };
  range(parameters.lineWidth, 1, 20); range(parameters.pointSize, 1, 30);
  if (type === 'Slice' || type === 'Clip') nonzero(parameters.normal);
  if (type === 'StreamTracer') {
    const stream = parameters.streamTracer as Record<string, unknown>;
    range(stream.points, 1, 2000, true); range(stream.resolution, 1, 2000, true);
    range(stream.radius, 0, 1e15); range(stream.maximumLength, 1e-12, 1e15);
  } else if (type === 'Tube') {
    const tube = parameters.tube as Record<string, unknown>;
    range(tube.radius, 1e-12, 1e15); range(tube.sides, 3, 64, true);
  } else if (type === 'Glyph') {
    const glyph = parameters.glyph as Record<string, unknown>;
    range(glyph.scaleFactor, 0, 1e15); range(glyph.maxPoints, 1, 50000, true);
  } else if (type === 'PlotOverLine') {
    range((parameters.plotOverLine as Record<string, unknown>).resolution, 1, 10000, true);
  } else if (type === 'Shrink') range((parameters.shrink as Record<string, unknown>).factor, 0, 1);
  else if (type === 'Transform') {
    if (((parameters.transform as Record<string, unknown>).scale as number[]).some(value => Math.abs(value) < 1e-12)) throw new Error('Invalid Transform scale.');
  } else if (type === 'Reflect') nonzero((parameters.reflect as Record<string, unknown>).normal);
  else if (type === 'Calculator' || type === 'Gradient') {
    const settings = parameters[type === 'Calculator' ? 'calculator' : 'gradient'] as Record<string, unknown>;
    if (typeof settings.resultName !== 'string' || !/^[\p{L}\p{N}_]{1,80}$/u.test(settings.resultName)) throw new Error('Invalid result array name.');
    if (type === 'Calculator' && (!(settings.expression as string).trim() || (settings.expression as string).length > 500)) throw new Error('Invalid calculator expression.');
  }
}

function snapshot(raw: unknown, ids: Set<string>, complete = true): ParaViewViewSnapshot {
  const value = object(raw, ['time', 'camera', 'nodes', 'view'], 'captured view');
  validate(value.time, 'number', 'view time');
  validate(value.camera, { position: 'vector', focalPoint: 'vector', viewUp: 'vector', viewAngle: 'number', parallelScale: 'number', parallel: 'boolean' }, 'camera');
  const camera = value.camera as { position: number[]; focalPoint: number[]; viewUp: number[]; viewAngle: number; parallelScale: number };
  if (camera.viewAngle < 1 || camera.viewAngle > 170 || camera.parallelScale < 1e-12 || !camera.viewUp.some(component => component !== 0) || camera.position.every((component, index) => component === camera.focalPoint[index])) throw new Error('Invalid workspace camera.');
  const settings = object(value.view, ['background', 'orientationAxes'], 'view');
  validate(settings.background, ['ParaView Dark', 'Midnight', 'Slate', 'White'], 'background');
  validate(settings.orientationAxes, 'boolean', 'orientation axes');
  if (!value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) throw new Error('Invalid snapshot pipeline.');
  const displays = value.nodes as Record<string, unknown>;
  if ((complete && Object.keys(displays).length !== ids.size) || Object.keys(displays).some(id => !ids.has(id))) throw new Error('The captured view does not match the workspace pipeline.');
  for (const rawDisplay of Object.values(displays)) {
    const display = object(rawDisplay, ['label', 'visible', 'representation', 'opacity', 'color', 'volume'], 'display');
    validate(display.label, 'string', 'display label');
    validate(display.visible, 'boolean', 'visibility');
    validate(display.representation, ['Surface', 'Surface With Edges', 'Wireframe', 'Feature Edges', 'Points', 'Outline', 'Volume'], 'representation');
    if (display.volume !== undefined) volumeSettings(display.volume);
    validate(display.opacity, 'number', 'opacity');
    if ((display.opacity as number) < 0 || (display.opacity as number) > 1) throw new Error('Opacity must be between 0 and 1.');
    const color = object(display.color, ['association', 'name', 'preset', 'legend', 'range'], 'color');
    validate(color.association, ['SOLID', 'BLOCKS', 'CELLS', 'POINTS'], 'color association');
    validate(color.name, 'string', 'color name'); validate(color.preset, 'string', 'color preset'); validate(color.legend, 'boolean', 'legend');
    if (color.range !== null) {
      if (!Array.isArray(color.range) || color.range.length !== 2) throw new Error('Invalid color range.');
      color.range.forEach(item => validate(item, 'number', 'color range'));
      if (color.range[0] > color.range[1]) throw new Error('Invalid color range.');
    }
  }
  return value;
}

/** Parse both saved/imported documents and API restore requests without executing them. */
export function parseParaViewWorkspace(raw: unknown): ParaViewWorkspace {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid workspace.');
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_WORKSPACE_BYTES) throw new Error('The workspace is too large.');
  const value = object(raw, ['format', 'version', 'caseName', 'paraviewVersion', 'selectedId', 'reader', 'nodes', 'view', 'centerAxes', 'video', 'clientView'], 'workspace');
  if (value.format !== 'openfoam-studio-paraview' || value.version !== 1) throw new Error('Unsupported workspace format or version.');
  validate(value.caseName, 'string', 'workspace case');
  if (!isValidCaseName(value.caseName as string)) throw new Error('Invalid workspace case.');
  validate(value.paraviewVersion, 'string', 'ParaView version');
  validate(value.centerAxes, 'boolean', 'center axes');
  const reader = object(value.reader, ['caseType', 'regions'], 'reader');
  validate(reader.caseType, ['Reconstructed Case', 'Decomposed Case'], 'case mode');
  if (!Array.isArray(reader.regions) || !reader.regions.length || reader.regions.length > 5000) throw new Error('Invalid workspace regions.');
  reader.regions.forEach(item => validate(item, 'string', 'region'));
  if (new Set(reader.regions).size !== reader.regions.length) throw new Error('Duplicate workspace regions.');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > MAX_WORKSPACE_NODES) throw new Error('A workspace supports up to 64 pipeline items.');
  const ids = new Set<string>();
  for (const rawNode of value.nodes) {
    const node = object(rawNode, ['id', 'type', 'parent', 'filePath', 'parameters'], 'pipeline item');
    if (!idValid(node.id) || ids.has(node.id)) throw new Error('Invalid or duplicate workspace pipeline ID.');
    if (typeof node.type !== 'string' || !Object.hasOwn(WORKSPACE_PARAMETER_SCHEMA, node.type)) throw new Error('Unsupported workspace filter.');
    if (node.type === 'OpenFOAMReader') {
      if (node.id !== 'reader' || ids.size || node.parent !== null) throw new Error('The workspace must begin with its OpenFOAM reader.');
    } else if (!ids.has('reader') || node.id === 'reader' || (node.type === 'CaseFileReader' ? node.parent !== null : typeof node.parent !== 'string' || !ids.has(node.parent))) {
      throw new Error('Workspace filters must follow their inputs.');
    }
    if (node.type === 'CaseFileReader') {
      validate(node.filePath, 'string', 'case file');
      const path = node.filePath as string;
      if (!path || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Workspace source files must remain inside the case.');
    } else if (node.filePath !== undefined) throw new Error('Only case-file readers have a file path.');
    const parameters = object(node.parameters, [...Object.keys(WORKSPACE_PARAMETER_SCHEMA[node.type]), 'lineWidth', 'pointSize', 'volume'], 'filter parameters');
    const { volume, ...base } = parameters;
    validate(base, { ...WORKSPACE_PARAMETER_SCHEMA[node.type], lineWidth: 'number', pointSize: 'number' }, 'filter parameters');
    parameterBounds(node.type, base);
    if (volume !== undefined) volumeSettings(volume);
    if (node.type === 'Selection') selectionRecipe(base.selection);
    if (node.type === 'CFDGradient') diagnosticSettings(base.diagnostic);
    if (node.type === 'ResampleToImage') resampleRequest({ id: 'reader', revision: 0, time: 0, dimensions: (base.resample as Record<string, unknown>).dimensions });
    ids.add(node.id);
  }
  if (!ids.has(value.selectedId as string)) throw new Error('The selected workspace item is missing.');
  snapshot(value.view, ids);
  if (value.clientView !== undefined) {
    const client = object(value.clientView, ['mode', 'chartSourceId'], 'workspace view layout');
    validate(client.mode, ['render', 'chart', 'table', 'split'], 'workspace view mode');
    if (client.chartSourceId !== undefined && !ids.has(client.chartSourceId as string)) throw new Error('The chart source is missing from the workspace.');
  }
  if (value.video !== undefined) {
    const video = object(value.video, ['start', 'segments', 'timing', 'interpolate', 'fps', 'resolution', 'format', 'colorRange'], 'video');
    validate(video.start, 'number', 'video start'); validate(video.interpolate, 'boolean', 'interpolation');
    if (![12, 24, 25, 30, 60].includes(video.fps as number)) throw new Error('Invalid video frame rate.');
    validate(video.resolution, ['480p', '720p', '1080p', '2160p'], 'video resolution'); validate(video.format, ['mp4', 'ogv'], 'video format'); validate(video.colorRange, ['captured', 'perFrame'], 'video color range');
    const timing = object(video.timing, ['mode', 'secondsPerStep', 'videoSecondsPerSimSecond'], 'video timing');
    if (timing.mode === 'perStep') {
      validate(timing.secondsPerStep, 'number', 'seconds per step');
      if ((timing.secondsPerStep as number) < 0.02 || (timing.secondsPerStep as number) > 10) throw new Error('Invalid seconds per step.');
    } else if (timing.mode === 'realTime') {
      validate(timing.videoSecondsPerSimSecond, 'number', 'video speed');
      if ((timing.videoSecondsPerSimSecond as number) < 1e-6 || (timing.videoSecondsPerSimSecond as number) > 1e6) throw new Error('Invalid video speed.');
    }
    else throw new Error('Invalid video timing.');
    if (!Array.isArray(video.segments) || video.segments.length > 30) throw new Error('A workspace supports up to 30 video views.');
    let previous = video.start as number;
    for (const rawSegment of video.segments) {
      const segment = object(rawSegment, ['until', 'transition', 'view'], 'video segment');
      validate(segment.until, 'number', 'segment end'); validate(segment.transition, ['cut', 'smooth'], 'transition');
      if ((segment.until as number) <= previous) throw new Error('Video segment times must increase.');
      previous = segment.until as number;
      snapshot(segment.view, ids, false);
    }
  }
  return JSON.parse(JSON.stringify(value)) as ParaViewWorkspace;
}
