import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codexDynamicTools } from '../src/lib/codex-tools';

test('Codex run_openfoam description remains accurate in both panel modes', () => {
  const definitions = JSON.parse(readFileSync(new URL('../electron/mcp/openfoam-tools.json', import.meta.url), 'utf8'));
  const run = codexDynamicTools(definitions).find(tool => tool.name === 'run_openfoam');
  assert.ok(run);
  assert.match(run.description, /current panel mode/);
  assert.match(run.description, /Guarded mode/);
  assert.match(run.description, /No limits mode/);
  assert.match(run.description, /\/mnt\//);
});
