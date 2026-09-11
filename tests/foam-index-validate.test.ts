/**
 * The installation check the wizard's summary runs (validateDictText): a real
 * name must not be reported as missing, and a typo still must be.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateDictText, type FoamIndex } from '../src/lib/foam-index.ts';

const INDEX: FoamIndex = {
  format: 1, version: '14', bashrc: '', installationId: '', installationBaseId: '', distro: '', fingerprint: '', builtAt: '',
  hasToC: true,
  names: {
    'heRhoThermo<pureMixture<const<hConst<perfectGas<specie>>,sensibleEnthalpy>>>': ['fluidThermo'],
    'hePsiThermo<pureMixture<sutherland<janaf<perfectGas<specie>>,sensibleInternalEnergy>>>': ['psiThermo'],
    limitPressure: ['fvConstraint'],
    kEpsilon: ['RAS'],
    fluid: ['solver'],
    zeroGradient: ['fvPatchScalarField'],
  },
  boundaryConditions: { scalar: ['zeroGradient'], vector: [] },
  solvers: ['fluid'], functionObjects: [], fvModels: [], fvConstraints: ['limitPressure'],
  applications: [], keysByType: {},
};

const THERMO = (type: string) => `thermoType
{
    type            ${type};
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState perfectGas;
    specie          specie;
    energy          sensibleEnthalpy;
}`;

describe('validateDictText', () => {
  test('a thermo type is known through the combinations foamToC lists', () => {
    // Found in the dev server: "heRhoThermo" does not exist in this OpenFOAM.
    assert.deepEqual(validateDictText(INDEX, THERMO('heRhoThermo'), 'constant/physicalProperties'), []);
    assert.deepEqual(validateDictText(INDEX, THERMO('hePsiThermo'), 'constant/physicalProperties'), []);
  });

  test('a typo in the same place is still reported', () => {
    const problems = validateDictText(INDEX, THERMO('heRhoThermoo'), 'constant/physicalProperties');
    assert.equal(problems.length, 1);
    assert.equal(problems[0].name, 'heRhoThermoo');
  });

  test('the other namespaces are unchanged', () => {
    const fvc = 'limitp\n{\n    type            limitPressure;\n}';
    assert.deepEqual(validateDictText(INDEX, fvc, 'system/fvConstraints'), []);
    const bc = 'boundaryField\n{\n    walls\n    {\n        type            pureMixture;\n    }\n}';
    // A thermo component is not a boundary condition.
    assert.equal(validateDictText(INDEX, bc, '0/T').length, 1);
  });
});
