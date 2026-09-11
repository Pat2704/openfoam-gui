/**
 * thermoType choices from the installation's foamToC table.
 *
 * The strings below are real entries of the v14 `fluidThermo` and `solidThermo`
 * tables. The promise under test: a dropdown never offers a value that does
 * not form a real combination with the others, which is what would otherwise
 * stop the solver with "Unknown thermoType".
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRealThermo, parseThermoCombo, parseThermoTable, resolveThermo, thermoOptions, thermoTypeBlock,
} from '../src/lib/wizard/thermo.ts';

const TABLE = [
  'heRhoThermo<pureMixture<const<hConst<perfectGas<specie>>,sensibleEnthalpy>>>',
  'heRhoThermo<pureMixture<const<eConst<perfectGas<specie>>,sensibleInternalEnergy>>>',
  'heRhoThermo<pureMixture<sutherland<janaf<perfectGas<specie>>,sensibleEnthalpy>>>',
  'heRhoThermo<pureMixture<const<eConst<rhoConst<specie>>,sensibleInternalEnergy>>>',
  'hePsiThermo<pureMixture<const<hConst<perfectGas<specie>>,sensibleEnthalpy>>>',
  'heRhoThermo<pureMixture<liquid,sensibleInternalEnergy>>',
  'heSolidThermo<pureMixture<constIsoSolid<eConst<rhoConst<specie>>,sensibleInternalEnergy>>>',
  'not a thermo',
];

describe('parseThermoCombo', () => {
  test('the seven components of the usual chain', () => {
    assert.deepEqual(parseThermoCombo(TABLE[0]), {
      type: 'heRhoThermo', mixture: 'pureMixture', transport: 'const', thermo: 'hConst',
      equationOfState: 'perfectGas', specie: 'specie', energy: 'sensibleEnthalpy',
    });
  });

  test('the liquid form keeps its properties and has no chain', () => {
    const c = parseThermoCombo(TABLE[5])!;
    assert.equal(c.properties, 'liquid');
    assert.equal(c.energy, 'sensibleInternalEnergy');
    assert.equal(c.transport, '');
  });

  test('solid thermo parses the same way', () => {
    assert.equal(parseThermoCombo(TABLE[6])!.transport, 'constIsoSolid');
  });

  test('anything else is refused', () => {
    assert.equal(parseThermoCombo('not a thermo'), null);
    assert.equal(parseThermoCombo('heRhoThermo<pureMixture<const<hConst<perfectGas<specie>>>>>'), null);
    assert.equal(parseThermoTable(TABLE).length, 7);
  });
});

describe('narrowing', () => {
  const combos = parseThermoTable(TABLE);

  test('each component only offers values that still form a real combination', () => {
    const o = thermoOptions(combos, { type: 'heRhoThermo', transport: 'const', equationOfState: 'perfectGas' });
    assert.deepEqual(o.thermo, ['eConst', 'hConst']);
    assert.deepEqual(o.energy, ['sensibleEnthalpy', 'sensibleInternalEnergy']);
    // janaf exists, but only with sutherland: not offered next to const.
    assert.ok(!o.thermo.includes('janaf'));
  });

  test('resolveThermo keeps the key the user just changed and repairs the rest', () => {
    const chosen = { type: 'heRhoThermo', mixture: 'pureMixture', transport: 'const', thermo: 'hConst', equationOfState: 'perfectGas', specie: 'specie', energy: 'sensibleEnthalpy' };
    const r = resolveThermo(combos, { ...chosen, thermo: 'janaf' }, ['thermo']);
    assert.equal(r!.thermo, 'janaf');
    assert.equal(r!.transport, 'sutherland');
    assert.ok(isRealThermo(combos, r!));
    assert.equal(isRealThermo(combos, { ...chosen, thermo: 'janaf' }), false);
  });

  test('the thermoType block is what the tutorials write', () => {
    const b = thermoTypeBlock(combos[0]);
    assert.match(b, /^thermoType\n\{\n\s+type\s+heRhoThermo;\n\s+mixture\s+pureMixture;/);
    assert.match(b, /equationOfState\s+perfectGas;/);
    assert.match(thermoTypeBlock(parseThermoCombo(TABLE[5])!), /properties\s+liquid;/);
  });
});
