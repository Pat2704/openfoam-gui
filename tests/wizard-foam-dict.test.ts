/**
 * Taking a tutorial's field file apart, for the modules the wizard seeds from a
 * tutorial. The sample is the shape of the v14 motorBike and damBreakLaminar
 * fields: variables and #include at the top, a zonal internalField, regex
 * patch names, an #includeEtc inside boundaryField, nested dictionaries.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { entries, parseFieldFile, renderEntries, splitBoundaryBody, stripComments } from '../src/lib/wizard/foam-dict.ts';

const FIELD = `/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    format      ascii;
    class       volVectorField;
    location    "0";
    object      U;
}
// * * * * //

#include        "include/initialConditions"
flowVelocity    (20 0 0); // the stream

dimensions      [0 1 -1 0 0 0 0];

internalField
{
    type        zonal;
    defaultValue (0 0 0);
    zones { water { type box; box (0 0 0) (1 1 1); value (1 0 0); } }
}

boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (20 0 0);
    }
    "motorBike_.*"
    {
        type            noSlip;
    }
    outlet
    {
        type            inletOutlet;
        inletValue      uniform (0 0 0);
        value           $internalField;
    }
    #includeEtc "caseDicts/setConstraintTypes"
}
`;

describe('foam-dict', () => {
  test('comments go, strings stay', () => {
    assert.equal(stripComments('a 1; // x\nb "c//d"; /* e */ f 2;').replace(/\s+/g, ' ').trim(), 'a 1; b "c//d"; f 2;');
  });

  test('a field file comes apart into its pieces', () => {
    const f = parseFieldFile(FIELD)!;
    assert.equal(f.cls, 'volVectorField');
    assert.equal(f.object, 'U');
    assert.equal(f.dimensions, '[0 1 -1 0 0 0 0]');
    assert.match(f.internalField, /^\{\n[\s\S]*type\s+zonal;[\s\S]*\}$/);
    assert.deepEqual(f.preamble.map(e => `${e.kind}:${e.key}`), ['directive:#include', 'value:flowVelocity']);
    assert.deepEqual(f.boundary.map(e => e.key), ['inlet', '"motorBike_.*"', 'outlet', '#includeEtc']);
  });

  test('a boundary entry splits into type, value and the rest', () => {
    const f = parseFieldFile(FIELD)!;
    const outlet = splitBoundaryBody(f.boundary[2].body);
    assert.equal(outlet.type, 'inletOutlet');
    assert.equal(outlet.value, '$internalField');
    assert.match(outlet.extra, /^inletValue\s+uniform \(0 0 0\);$/);
  });

  test('entries render back as dictionary text', () => {
    const text = renderEntries(entries('a 1;\nb { c 2; }\n#include "x"'));
    assert.match(text, /^a\s+1;\nb\n\{\n    c 2;\n\}\n#include "x"$/);
  });

  test('a file without boundaryField is not a field', () => {
    assert.equal(parseFieldFile('FoamFile { class dictionary; }\nnu 1e-5;'), null);
  });
});
