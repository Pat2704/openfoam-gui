import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foamLookupResult, validateApplicationArguments } from '../src/lib/agent-knowledge';
import type { FoamApplication, FoamIndex } from '../src/lib/foam-index';
import { buildInstallationId, type InstallationIdentityParts } from '../src/lib/foam-installation';

function application(): FoamApplication {
  return {
    name: 'foamRun',
    options: ['-solver', '-parallel', '-latestTime'],
    optionDetails: [
      { name: '-solver', valueHint: '<name>', description: 'solver module', requiresValue: true },
      { name: '-parallel', valueHint: '', description: 'parallel run', requiresValue: false },
      { name: '-latestTime', valueHint: '', description: 'latest time', requiresValue: false },
    ],
  };
}

function index(version: string, hasToC: boolean): FoamIndex {
  return {
    format: 3,
    version,
    bashrc: `/opt/openfoam${version}/etc/bashrc`,
    installationId: `fixture-${version}`,
    installationBaseId: `fixture-base-${version}`,
    distro: 'fixture',
    fingerprint: 'fixture',
    builtAt: '2026-01-01T00:00:00.000Z',
    hasToC,
    names: hasToC ? { fixedValue: ['patchField<scalar>'] } : {},
    boundaryConditions: { scalar: hasToC ? ['fixedValue'] : [], vector: [] },
    solvers: hasToC ? ['incompressibleFluid'] : [],
    functionObjects: [],
    fvModels: [],
    fvConstraints: [],
    applications: [application()],
    keysByType: { fixedValue: ['value'] },
  };
}

test('guarded command options follow the structured -help contract', () => {
  assert.deepEqual(validateApplicationArguments(application(), ['-solver', 'incompressibleFluid', '-parallel']), { ok: true });
  assert.deepEqual(validateApplicationArguments(application(), ['-solver=incompressibleFluid', '-latestTime']), { ok: true });
  const missing = validateApplicationArguments(application(), ['-solver']);
  const unknown = validateApplicationArguments(application(), ['-unknown']);
  assert.equal(missing.ok, false);
  assert.equal(unknown.ok, false);
  if (!missing.ok) assert.match(missing.reason, /requires <name>/);
  if (!unknown.ok) assert.match(unknown.reason, /not listed/);
});

test('OpenFOAM 9 and 10 never turn a reduced index into a false negative', () => {
  for (const version of ['9', '10']) {
    const knownSourceType = foamLookupResult(index(version, false), 'fixedValue', 'solvers');
    assert.ok('text' in knownSourceType);
    assert.match(knownSourceType.text, /cannot be proven/);

    const absent = foamLookupResult(index(version, false), 'futureBoundaryType', 'solvers');
    assert.ok('text' in absent);
    assert.match(absent.text, /cannot be verified/);
    assert.doesNotMatch(absent.text, /does not exist/);

    const applications = foamLookupResult(index(version, false), '', 'applications');
    assert.ok('text' in applications);
    assert.match(applications.text, /foamRun/);
  }
});

test('versions with foamToC distinguish valid and absent runtime names', () => {
  for (const version of ['11', '12', '13', '14']) {
    const valid = foamLookupResult(index(version, true), 'fixedValue', 'solvers');
    assert.ok('text' in valid);
    assert.match(valid.text, new RegExp(`valid in OpenFOAM ${version}`));

    const absent = foamLookupResult(index(version, true), 'fixedVale', 'solvers', ['fixedValue']);
    assert.ok('text' in absent);
    assert.match(absent.text, /does not exist/);
    assert.match(absent.text, /fixedValue/);
  }
});

test('installation cache identity changes with distro, paths and binary metadata', () => {
  const base: InstallationIdentityParts = {
    distro: 'Ubuntu-22.04', bashrc: '/opt/openfoam14/etc/bashrc', version: '14',
    projectDir: '/opt/openfoam14', tutorials: '/opt/openfoam14/tutorials',
    applicationBin: '/opt/openfoam14/platforms/bin', metadata: 'bin|100|1',
  };
  const original = buildInstallationId(base).id;
  assert.notEqual(buildInstallationId({ ...base, distro: 'Ubuntu-24.04' }).id, original);
  assert.notEqual(buildInstallationId({ ...base, version: '13' }).id, original);
  assert.notEqual(buildInstallationId({ ...base, metadata: 'bin|101|1' }).id, original);
  assert.equal(buildInstallationId({ ...base, metadata: 'bin|101|1' }).baseId, buildInstallationId(base).baseId);
});
