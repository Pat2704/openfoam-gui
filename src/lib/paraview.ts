import { execFile } from 'child_process';
import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';

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
    const searched = unique.map(c => c.executable);
    valid.sort((a, b) => compareParaViewVersions(b.version || '0', a.version || '0'));
    cachedInstallation = valid[0]
      ? { ...valid[0], searched }
      : { found: false, searched, error: 'No usable pvpython.exe was found at the selected path.' };
    cachedKey = key;
    return cachedInstallation;
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
        error: 'ParaView was not found. Install it or enter its folder or pvpython.exe path.',
      };
  cachedInstallation = result;
  cachedKey = key;
  return result;
}

const EXPORT_SCRIPT = String.raw`
import os, sys
from paraview.simple import OpenFOAMReader, MergeBlocks, ExtractSurface, Triangulate
from paraview import servermanager
import vtk

marker, output = sys.argv[1], sys.argv[2]
reader = OpenFOAMReader(registrationName=os.path.basename(marker), FileName=marker)
reader.UpdatePipeline()
merged = MergeBlocks(registrationName='Merged case', Input=reader)
surface = ExtractSurface(registrationName='Boundary surface', Input=merged)
triangles = Triangulate(registrationName='Triangulated surface', Input=surface)
triangles.UpdatePipeline()
poly = servermanager.Fetch(triangles)
writer = vtk.vtkSTLWriter()
writer.SetFileName(output)
writer.SetFileTypeToASCII()
writer.SetInputData(poly)
if writer.Write() != 1:
    raise RuntimeError('ParaView could not write the extracted surface')
`;

/** Run only the app-owned extraction pipeline; no user Python is accepted. */
export async function exportParaViewSurface(
  pvpythonPath: string,
  markerPath: string,
  outputPath: string,
  timeout = 240_000,
): Promise<void> {
  await execFileText(pvpythonPath, ['-c', EXPORT_SCRIPT, markerPath, outputPath], timeout);
  if (!await isFile(outputPath)) throw new Error('ParaView completed without producing a surface file.');
}
