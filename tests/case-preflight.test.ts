/**
 * The preflight's hard rule is that uncertainty never becomes a blocking
 * error. These fixtures exercise both direct contradictions and the cases
 * that must stay explicitly unverified.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCasePreflight,
  isDictionaryCandidate,
  type PreflightAnalysisInput,
} from '../src/lib/case-preflight.ts';
import type { FoamIndex } from '../src/lib/foam-index.ts';
import type { CaseFileSlice } from '../src/lib/wsl.ts';

const INDEX: FoamIndex = {
  format: 4,
  version: '14',
  bashrc: '/opt/openfoam14/etc/bashrc',
  installationId: 'fixture',
  installationBaseId: 'fixture',
  distro: 'Ubuntu',
  fingerprint: 'fixture',
  builtAt: '2026-09-12T00:00:00.000Z',
  hasToC: true,
  names: {
    fixedValue: ['fvPatchField'],
    zeroGradient: ['fvPatchField'],
    incompressibleFluid: ['solver'],
  },
  boundaryConditions: { scalar: ['fixedValue', 'zeroGradient'], vector: ['fixedValue', 'zeroGradient'] },
  solvers: ['incompressibleFluid'],
  functionObjects: [],
  fvModels: [],
  fvConstraints: [],
  applications: [],
  keysByType: {},
};

const CONTROL = `FoamFile
{
    class dictionary;
    object controlDict;
}
solver          incompressibleFluid;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         10;
deltaT          1;
writeControl    timeStep;
writeInterval   1;
`;

const U = `FoamFile
{
    class volVectorField;
    object U;
}
internalField uniform (0 0 0);
boundaryField
{
    walls
    {
        type fixedValue;
        value uniform (0 0 0);
    }
}
`;

function file(path: string, content: string): CaseFileSlice {
  return { path, content, bytes: Buffer.byteLength(content), truncated: false };
}

function validInput(overrides: Partial<PreflightAnalysisInput> = {}): PreflightAnalysisInput {
  const files = [
    file('system/controlDict', CONTROL),
    file('system/fvSchemes', 'FoamFile { class dictionary; object fvSchemes; }\nddtSchemes { default steadyState; }'),
    file('system/fvSolution', 'FoamFile { class dictionary; object fvSolution; }\nsolvers {}'),
    file('0/U', U),
  ];
  return {
    caseName: 'fixture',
    index: INDEX,
    inventory: { initialTime: '0', files, skipped: [], totalFiles: files.length, inventoryTruncated: false },
    directories: [],
    meshPresent: true,
    syntax: [],
    syntaxAttempted: true,
    syntaxPaths: files.map(item => item.path),
    syntaxCandidateCount: files.length,
    boundary: {
      success: true,
      meshChecked: true,
      meshPatches: ['walls'],
      warnings: [],
      fields: [{ name: 'U', patches: [{ patch: 'walls', type: 'fixedValue', valid: true }] }],
    },
    ...overrides,
  };
}

describe('case preflight analysis', () => {
  test('passes direct structure, parser, vocabulary and boundary checks without inventing mesh quality', () => {
    const report = analyzeCasePreflight(validInput());
    assert.equal(report.counts.error, 0);
    assert.equal(report.counts.warning, 0);
    assert.equal(report.counts.unverified, 1);
    assert.match(report.issues[0].title, /Mesh quality/);
    assert.equal(report.sections.find(section => section.id === 'syntax')?.status, 'pass');
    assert.equal(report.dictionaryFilesParsed, 4);
  });

  test('keeps conventional omissions advisory and reports unusable numeric controls as errors', () => {
    const brokenControl = CONTROL.replace('deltaT          1;', 'deltaT          0;')
      .replace('endTime         10;', 'endTime         0;');
    const control = file('system/controlDict', brokenControl);
    const report = analyzeCasePreflight(validInput({
      inventory: { initialTime: null, files: [control], skipped: [], totalFiles: 1, inventoryTruncated: false },
      meshPresent: false,
      syntaxPaths: [control.path],
      boundary: null,
    }));
    const titles = report.issues.filter(issue => issue.severity === 'error').map(issue => issue.title);
    assert.ok(titles.includes('Initial time directory is missing'));
    assert.ok(titles.includes('deltaT is not usable'));
    assert.equal(report.issues.find(issue => issue.title === 'fvSchemes is missing')?.severity, 'warning');
    assert.equal(report.issues.find(issue => issue.title === 'The run interval is empty')?.severity, 'warning');
  });

  test('downgrades unknown runtime names when custom registration can supply them', () => {
    const customControl = file('system/controlDict', `${CONTROL}\nlibs ("libcaseModels.so");\n`);
    const customU = file('0/U', U.replace('type fixedValue;', 'type companyBoundary;'));
    const input = validInput();
    const files = input.inventory.files.map(item => item.path === 'system/controlDict' ? customControl : item.path === '0/U' ? customU : item);
    const report = analyzeCasePreflight({
      ...input,
      inventory: { ...input.inventory, files },
    });
    const unknown = report.issues.find(issue => issue.message.includes('companyBoundary'));
    assert.equal(unknown?.severity, 'unverified');
    assert.equal(report.issues.some(issue => issue.category === 'Installed-version vocabulary' && issue.severity === 'error'), false);
  });

  test('never turns a catalogue miss or skipped dynamic preprocessing into a false blocking error', () => {
    const input = validInput();
    const unknownU = file('0/U', U.replace('type fixedValue;', 'type siteSpecificBoundary;'));
    const files = input.inventory.files.map(item => item.path === '0/U' ? unknownU : item);
    const report = analyzeCasePreflight({
      ...input,
      inventory: { ...input.inventory, files },
      syntaxAttempted: false,
      syntaxUnavailableReason: 'Syntax parsing was skipped because 0/U contains #codeStream.',
    });
    assert.equal(report.issues.find(issue => issue.message.includes('siteSpecificBoundary'))?.severity, 'unverified');
    assert.equal(report.issues.find(issue => issue.title === 'Parser check was not completed')?.severity, 'unverified');
  });

  test('links decomposition and boundary contradictions to their source files', () => {
    const input = validInput();
    const decomposition = file('system/decomposeParDict', 'numberOfSubdomains 4;\nmethod scotch;');
    const report = analyzeCasePreflight({
      ...input,
      inventory: { ...input.inventory, files: [...input.inventory.files, decomposition] },
      directories: ['processor0', 'processor1'],
      boundary: {
        success: true,
        meshChecked: true,
        meshPatches: ['walls', 'inlet'],
        warnings: [],
        fields: [{ name: 'U', patches: [{ patch: 'inlet', type: '', valid: false, note: 'missing from boundaryField' }] }],
      },
    });
    assert.equal(report.issues.find(issue => issue.title.includes('processor directories'))?.file, 'system/decomposeParDict');
    assert.equal(report.issues.find(issue => issue.title.includes('Boundary entry'))?.file, '0/U');
  });

  test('classifies only plausible OpenFOAM dictionaries for parser validation', () => {
    assert.equal(isDictionaryCandidate(file('system/functions', '#include "forces"')), true);
    assert.equal(isDictionaryCandidate(file('constant/data.json', '{"type":"custom"}')), false);
    assert.equal(isDictionaryCandidate(file('system/helper', '#!/bin/bash\necho ok')), false);
  });
});
