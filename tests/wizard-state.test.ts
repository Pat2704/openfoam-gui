/**
 * "Update case": deciding which of a wizard case's files an update may touch.
 *
 * The promise under test is the one the feature exists for: a file someone
 * edited after the wizard wrote it is NEVER rewritten without the user saying
 * so — not on this update, and not on the next one either. Everything else here
 * (the record's round trip, a hand-edited record) supports that.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_MESH } from '../src/lib/case-templates.ts';
import {
  WIZARD_MARKER_PATH,
  buildMarker,
  isMeshInput,
  parseMarker,
  planUpdate,
  resolvePlan,
  serializeMarker,
  settingsEqual,
  sha256Hex,
  type WizardSettings,
} from '../src/lib/wizard-state.ts';

const H = (c: string) => createHash('sha256').update(c).digest('hex');
const A = H('a'), B = H('b'), C = H('c'), D = H('d');

const DEFAULTS: WizardSettings = {
  flavour: 'modular', solver: 'incompressibleFluid', transient: false, turbulence: 'laminar',
  nu: '1e-05', inletVelocity: '(1 0 0)', intensity: '5', lengthScale: '',
  endTime: '500', deltaT: '1', writeInterval: '100', gravity: '(0 -9.81 0)',
  mesh: DEFAULT_MESH, meshOverride: null, systemOverrides: {}, constantOverrides: {},
  fields: [], snappy: null, full: null,
};

describe('planUpdate', () => {
  test('the four ordinary outcomes', () => {
    const plan = planUpdate({
      recorded: { same: A, changed: A, gone: A },
      onDisk: { same: A, changed: A, gone: A, fresh: null },
      next: { same: A, changed: B, fresh: C },
    });
    const by = Object.fromEntries(plan.map(e => [e.path, e.action]));
    assert.deepEqual(by, { same: 'same', changed: 'write', fresh: 'create', gone: 'delete' });
  });

  test('an edited file is a conflict, never a write', () => {
    const [e] = planUpdate({ recorded: { f: A }, onDisk: { f: D }, next: { f: B } });
    assert.deepEqual(e, { path: 'f', action: 'conflict', reason: 'modified' });
  });

  test('an edit that happens to match what the wizard would write now needs nothing', () => {
    const [e] = planUpdate({ recorded: { f: A }, onDisk: { f: B }, next: { f: B } });
    assert.equal(e.action, 'same');
  });

  test('a deleted, a foreign and an edited obsolete file all ask', () => {
    const plan = planUpdate({
      recorded: { deleted: A, old: A },
      onDisk: { deleted: null, foreign: D, old: D },
      next: { deleted: A, foreign: B },
    });
    const by = Object.fromEntries(plan.map(e => [e.path, `${e.action}:${e.reason}`]));
    assert.deepEqual(by, {
      deleted: 'conflict:missing',
      foreign: 'conflict:foreign',
      old: 'conflict:obsolete-modified',
    });
  });

  test('an obsolete file already gone, and untouched geometry, are left alone', () => {
    const plan = planUpdate({
      recorded: { gone: A, 'constant/geometry/body.stl': A },
      onDisk: { gone: null, 'constant/geometry/body.stl': D },
      next: {},
      untouched: ['constant/geometry/body.stl'],
    });
    assert.deepEqual(plan, []);
  });
});

describe('resolvePlan', () => {
  const recorded = { edited: A, plain: A, old: A, oldEdited: A, geo: C };
  const onDisk = { edited: D, plain: A, old: A, oldEdited: D, fresh: null, geo: C };
  const next = { edited: B, plain: B, fresh: B };
  const plan = planUpdate({ recorded, onDisk, next, untouched: ['geo'] });

  test('without an answer for every conflict nothing may be applied', () => {
    const r = resolvePlan(plan, {}, next, recorded, ['geo']);
    assert.deepEqual(r.undecided.sort(), ['edited', 'oldEdited']);
  });

  test('"keep" leaves the disk alone and keeps the OLD hash on record', () => {
    const r = resolvePlan(plan, { edited: 'keep', oldEdited: 'keep' }, next, recorded, ['geo']);
    assert.deepEqual(r.write.sort(), ['fresh', 'plain']);
    assert.deepEqual(r.remove, ['old']);
    assert.equal(r.recorded.edited, A, 'still recorded as what the wizard wrote');
    assert.equal(r.recorded.oldEdited, undefined, 'an obsolete file the user kept is theirs now');
    assert.equal(r.recorded.geo, C, 'untouched geometry keeps its record');
    assert.equal(r.recorded.plain, B);
    assert.deepEqual(r.undecided, []);

    // The next update, with the user's edit still on disk: asked again, not taken.
    const again = planUpdate({ recorded: r.recorded, onDisk: { edited: D, plain: B, fresh: B }, next });
    assert.deepEqual(again.find(e => e.path === 'edited'), { path: 'edited', action: 'conflict', reason: 'modified' });
  });

  test('"apply" writes the wizard version, or deletes the obsolete file', () => {
    const r = resolvePlan(plan, { edited: 'apply', oldEdited: 'apply' }, next, recorded, ['geo']);
    assert.ok(r.write.includes('edited'));
    assert.equal(r.recorded.edited, B);
    assert.deepEqual(r.remove.sort(), ['old', 'oldEdited']);
  });
});

describe('the record', () => {
  test('survives a round trip', () => {
    const settings = { ...DEFAULTS, endTime: '42', fields: [{ fieldName: 'U', dimensions: '[0 1 -1 0 0 0 0]', internalField: 'uniform (0 0 0)', boundaryConditions: [{ name: 'inlet', type: 'fixedValue', value: 'uniform (1 0 0)' }] }] };
    const marker = buildMarker(settings, { '0/U': A, 'system/controlDict': B }, '14', null, new Date('2026-09-10T12:00:00Z'));
    const back = parseMarker(serializeMarker(marker), DEFAULTS);
    assert.equal(back.error, null);
    assert.deepEqual(back.marker, marker);
  });

  test('an update keeps the creation date', () => {
    const first = buildMarker(DEFAULTS, {}, '14', null, new Date('2026-09-01T00:00:00Z'));
    const second = buildMarker(DEFAULTS, {}, '14', first, new Date('2026-09-10T00:00:00Z'));
    assert.equal(second.createdAt, '2026-09-01T00:00:00.000Z');
    assert.equal(second.updatedAt, '2026-09-10T00:00:00.000Z');
  });

  test('unusable records are refused in words', () => {
    assert.match(parseMarker('{', DEFAULTS).error ?? '', /not valid JSON/);
    assert.match(parseMarker('{"format":3,"settings":{}}', DEFAULTS).error ?? '', /different version/);
    assert.match(parseMarker('{"format":1}', DEFAULTS).error ?? '', /no settings/);
  });

  test('a hand-edited record cannot inject bad values or paths', () => {
    const text = JSON.stringify({
      format: 1,
      settings: { flavour: 'weird', turbulence: 'kEpsilon', mesh: { x0: 'zero', nx: 12 }, endTime: 7, snappy: { surfaces: [{ name: 'b', file: 'b.stl', bbox: { min: [0, 0], max: [1, 1, 1] } }] } },
      files: { '0/U': A, '../escape': A, '/abs': A, 'system/fvSchemes': 'nothex', [WIZARD_MARKER_PATH]: A },
    });
    const { marker } = parseMarker(text, DEFAULTS);
    assert.ok(marker);
    assert.deepEqual(Object.keys(marker.files), ['0/U']);
    assert.equal(marker.settings.flavour, 'modular');
    assert.equal(marker.settings.turbulence, 'kEpsilon');
    assert.equal(marker.settings.mesh.x0, DEFAULT_MESH.x0);
    assert.equal(marker.settings.mesh.nx, 12);
    assert.equal(marker.settings.endTime, '500');
    assert.equal(marker.settings.snappy?.surfaces[0].bbox, null);
  });
});

describe('helpers', () => {
  test('sha256Hex matches sha256sum of the UTF-8 bytes', async () => {
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const text = 'nu              1e-05 [m^2/s];\n// ν air 1.5e-05 · water 1e-06\n';
    assert.equal(await sha256Hex(text), H(text));
    assert.equal(await sha256Hex(new TextEncoder().encode(text)), H(text));
  });

  test('settingsEqual ignores key order but not values', () => {
    const reordered = Object.fromEntries(Object.entries(DEFAULTS).reverse()) as unknown as WizardSettings;
    assert.equal(settingsEqual(DEFAULTS, reordered), true);
    assert.equal(settingsEqual(DEFAULTS, { ...DEFAULTS, mesh: { ...DEFAULTS.mesh, nx: 61 } }), false);
  });

  test('which files the mesh is built from', () => {
    for (const p of ['system/blockMeshDict', 'system/snappyHexMeshDict', 'system/surfaceFeaturesDict', 'system/meshQualityDict', 'constant/geometry/motorBike.obj.gz']) {
      assert.equal(isMeshInput(p), true, p);
    }
    for (const p of ['system/controlDict', '0/U', 'constant/momentumTransport']) assert.equal(isMeshInput(p), false, p);
  });
});
