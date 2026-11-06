import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { snapshotLeftovers, removeLeftovers } = require('../electron/housekeeping.js') as {
  snapshotLeftovers: (o: { tmpDir: string; currentDir: string }) => { folders: string[]; prompts: number };
  removeLeftovers: (folders: string[]) => Promise<{ removed: number; skipped: number }>;
};

function portable(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'resources', 'standalone'), { recursive: true });
  writeFileSync(join(dir, 'OpenFOAMStudio.exe'), '');
  writeFileSync(join(dir, 'resources', 'standalone', 'server.js'), '');
  const anHourAgo = new Date(Date.now() - 3600_000);
  utimesSync(dir, anHourAgo, anHourAgo);
  return dir;
}

test('sweeps only our own leftovers, never the running app or foreign folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofstudio-housekeeping-'));
  try {
    const stale = portable(root, '3IikJ2hlsbzKTZUGmx3iDH26YPP');
    const current = portable(root, '3Im5bGAHJfRjJRweFFiCttmC5Hf');
    // Written moments ago: a portable stub may be extracting into it right now.
    const fresh = portable(root, '3IlU1xBEUClPgoxJ89ZTi5iOmWU');
    utimesSync(fresh, new Date(), new Date());
    // A 27-character folder of another program: same name shape, not ours.
    mkdirSync(join(root, '2aaaaaaaaaaaaaaaaaaaaaaaaaa'));
    mkdirSync(join(root, 'openfoam-studio-paraview-session-AbC123'));
    mkdirSync(join(root, 'openfoam-studio-trash-1-0-left-over'));
    mkdirSync(join(root, 'openfoam-studio-agent'));
    writeFileSync(join(root, 'openfoam-studio-agent', 'system-prompt-0123456789abcdef.txt'), 'x');
    writeFileSync(join(root, 'openfoam-studio-agent', 'keep.txt'), 'x');

    const snap = snapshotLeftovers({ tmpDir: root, currentDir: current });
    assert.equal(snap.prompts, 1);
    assert.deepEqual(readdirSync(join(root, 'openfoam-studio-agent')), ['keep.txt']);
    assert.equal(snap.folders.length, 3);
    assert.ok(!snap.folders.includes(current));

    const result = await removeLeftovers(snap.folders);
    assert.deepEqual(result, { removed: 3, skipped: 0 });
    assert.ok(!existsSync(stale));
    assert.ok(existsSync(current));
    assert.ok(existsSync(join(root, '2aaaaaaaaaaaaaaaaaaaaaaaaaa')));
    assert.deepEqual(readdirSync(root).sort(), [
      '2aaaaaaaaaaaaaaaaaaaaaaaaaa', '3IlU1xBEUClPgoxJ89ZTi5iOmWU', '3Im5bGAHJfRjJRweFFiCttmC5Hf', 'openfoam-studio-agent',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('leaves a folder alone while a program inside it is running', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofstudio-housekeeping-'));
  const busy = join(root, 'openfoam-studio-paraview-session-busy');
  mkdirSync(busy);
  // Another running copy of the app: its executables run from the folder.
  const exe = join(busy, 'OpenFOAMStudio.exe');
  copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    const result = await removeLeftovers([busy]);
    assert.deepEqual(result, { removed: 0, skipped: 1 });
    assert.ok(existsSync(exe));
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
