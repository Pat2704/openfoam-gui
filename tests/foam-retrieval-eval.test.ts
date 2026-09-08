import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankChunks, type Chunk } from '../src/lib/foam-retrieval';

const corpus: Chunk[] = [
  { path: 'incompressible/flowRate/0/U', line: 1, text: 'inlet\n{\n    type flowRateInletVelocity;\n    volumetricFlowRate constant 0.1;\n}' },
  { path: 'incompressible/wall/0/nut', line: 1, text: 'walls\n{\n    type nutkWallFunction;\n    value uniform 0;\n}' },
  { path: 'basic/cavity/system/controlDict', line: 1, text: 'solver incompressibleFluid;\nwriteControl timeStep;\nwriteInterval 20;' },
  { path: 'multiphase/damBreak/0/alpha.water', line: 1, text: 'interface compression free surface VoF alpha water' },
  { path: 'heatTransfer/solid/0/T', line: 1, text: 'temperature heat transfer thermal wall fixedValue' },
  { path: 'mesh/snappyHexMesh/system/snappyHexMeshDict', line: 1, text: 'geometry features surfaceFeatureExtractDict refinementSurfaces castellatedMesh snap layers' },
  { path: 'isothermalFluid/box/system/blockMeshDict', line: 1, text: 'mesh surface hex blocks extract feature boundary scale vertices' },
];

const questions: { question: string; expected: string }[] = [
  { question: "come impongo una portata volumetrica all'ingresso", expected: 'incompressible/flowRate/0/U' },
  { question: 'quale funzione di parete uso per la viscosità turbolenta', expected: 'incompressible/wall/0/nut' },
  { question: 'come imposto la superficie libera multifase', expected: 'multiphase/damBreak/0/alpha.water' },
  { question: 'show me nutkWallFunction', expected: 'incompressible/wall/0/nut' },
  { question: 'come imposto snappyHexMesh con surfaceFeatureExtract', expected: 'mesh/snappyHexMesh/system/snappyHexMeshDict' },
];

test('Italian and exact-identifier retrieval questions reach the expected tutorial', () => {
  for (const fixture of questions) {
    const ranked = rankChunks(corpus, fixture.question, 3);
    assert.ok(ranked.length > 0, `no result for: ${fixture.question}`);
    assert.equal(ranked[0].path, fixture.expected, fixture.question);
  }
});
