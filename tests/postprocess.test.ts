import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeFoamRow,
  parseFoamTable,
  mergeRestarts,
  isTimeSeries,
  downsampleRows,
  summarizeColumn,
  parseFunctionTemplate,
  buildFunctionSpec,
  wrapFoamValue,
  exampleArgValue,
  buildCallTemplate,
  buildFunctionsEntry,
  validateTypedSpec,
  resolveTemplateExtras,
  optionalTemplateEntries,
  parseClassDocumentation,
  tutorialExamplesFor,
  tokenizeCommand,
  parsePostProcessCommand,
  buildCommandTemplate,
  FunctionSpecError,
  describeDatasetName,
  isTabularOutput,
  serializeCsv,
} from '../src/lib/postprocess.ts';

// The three samples below are verbatim output from OpenFOAM 14, not invented
// shapes: a volFieldValue time series, a sampled-line profile, and a probes
// file whose cells are vectors.

const VOL_FIELD_VALUE = `# Selection   : all
# Cells       : 400
# Volume      : 1.000000e-04
# Time        \tvolAverage(p)
5             \t-5.553211e-03
5.5           \t-6.122171e-03
6             \t-6.665909e-03
`;

const SAMPLED_LINE = `#    distance             p           U_x           U_y           U_z
  7.20485e-18   -0.00901475    0.00145922       0.14085             0
   0.00421053    -0.0100818    0.00134848      0.133185             0
`;

const PROBES_U = `# Probe 0 (0.005 0.005 0.005)
# Probe 1 (0.007 0.007 0.005)
# Time        0             1
9             (0.00267728 -0.00317882 0) (-0.0134597 0.0123971 0)
9.5           (0.00277981 -0.00324883 0) (-0.0139119 0.0128271 0)
`;

test('a parenthesised value stays one cell, and a name containing parentheses is not split', () => {
  assert.deepEqual(
    tokenizeFoamRow('9 (0.1 -0.2 0) (0.3 0.4 0)'),
    ['9', '(0.1 -0.2 0)', '(0.3 0.4 0)'],
  );
  // `volAverage(p)` is a column NAME with balanced parentheses inside a single
  // token. A plain depth counter would have opened a group in the middle of it.
  assert.deepEqual(tokenizeFoamRow('Time volAverage(p)'), ['Time', 'volAverage(p)']);
});

test('a scalar time series keeps its header names and its comment block', () => {
  const table = parseFoamTable(VOL_FIELD_VALUE);
  assert.deepEqual(table.columns, ['Time', 'volAverage(p)']);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0], [5, -5.553211e-3]);
  assert.equal(table.synthesizedColumns, false);
  // Everything above the header line is kept and offered as provenance.
  assert.ok(table.notes.some(note => note.startsWith('Cells')));
});

test('a sampled line is read with its already-expanded components', () => {
  const table = parseFoamTable(SAMPLED_LINE);
  assert.deepEqual(table.columns, ['distance', 'p', 'U_x', 'U_y', 'U_z']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1][2], 0.00134848);
});

test('probe vectors expand into components and pick up their coordinates', () => {
  const table = parseFoamTable(PROBES_U);
  assert.deepEqual(table.columns, [
    'Time',
    '0 (0.005 0.005 0.005)_x', '0 (0.005 0.005 0.005)_y', '0 (0.005 0.005 0.005)_z',
    '1 (0.007 0.007 0.005)_x', '1 (0.007 0.007 0.005)_y', '1 (0.007 0.007 0.005)_z',
  ]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], [9, 0.00267728, -0.00317882, 0, -0.0134597, 0.0123971, 0]);
});

test('a header that names the components of a tuple wins over invented suffixes', () => {
  const table = parseFoamTable(
    '# Time (total_x total_y total_z)\n0.1 (1 2 3)\n',
  );
  assert.deepEqual(table.columns, ['Time', 'total_x', 'total_y', 'total_z']);
});

test('a nested tuple is flattened and still produces one distinct name per number', () => {
  const table = parseFoamTable('# Time forces\n0.1 ((1 2 3) (4 5 6))\n');
  assert.equal(table.columns.length, 7);
  assert.equal(new Set(table.columns).size, 7, 'column names must stay unique');
  assert.deepEqual(table.rows[0], [0.1, 1, 2, 3, 4, 5, 6]);
});

test('column names are invented, and flagged, when the header does not fit the data', () => {
  const table = parseFoamTable('# Time\n1 2 3\n2 3 4\n');
  assert.equal(table.synthesizedColumns, true);
  assert.equal(table.columns.length, 3);
  assert.equal(new Set(table.columns).size, 3);
  assert.equal(table.rows.length, 2);
});

test('a row of the wrong width is dropped rather than padded into place', () => {
  // A crashed write can leave a half-line. Padding it would shift every series
  // after it and plot a value that was never computed.
  const table = parseFoamTable('# Time p\n1 0.5\n2\n3 0.7\n');
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows.map(row => row[0]), [1, 3]);
});

test('a file with no data at all is empty rather than malformed', () => {
  const table = parseFoamTable('# Time p\n');
  assert.deepEqual(table.columns, []);
  assert.deepEqual(table.rows, []);
});

test('the row limit stops the read and says so', () => {
  const content = `# Time p\n${Array.from({ length: 50 }, (_, i) => `${i} ${i * 2}`).join('\n')}\n`;
  const table = parseFoamTable(content, { maxRows: 10 });
  assert.equal(table.rows.length, 10);
  assert.equal(table.truncated, true);
});

test('a time directory is read as a continuation or as a snapshot, from the data itself', () => {
  // Both shapes live at postProcessing/<function>/<time>/, and the first column
  // is what tells them apart. Getting this wrong merged 21 sampled profiles into
  // one curve and kept only the last.
  assert.equal(isTimeSeries(parseFoamTable(VOL_FIELD_VALUE).columns), true);
  assert.equal(isTimeSeries(parseFoamTable(PROBES_U).columns), true);
  assert.equal(isTimeSeries(parseFoamTable(SAMPLED_LINE).columns), false);
  assert.equal(isTimeSeries([]), false);
  // The name is compared without regard to spacing or case, since the header is
  // written with whatever padding the writer used.
  assert.equal(isTimeSeries(['  TIME  ', 'p']), true);
});

test('a restart replaces the rows it recomputed instead of plotting them twice', () => {
  // The first run reached t=3; the restart from t=2 recomputed 2 and 3 and went
  // on to 4. Concatenating would send the x axis backwards mid-plot.
  const first = parseFoamTable('# Time p\n1 10\n2 20\n3 30\n');
  const second = parseFoamTable('# Time p\n2 21\n3 31\n4 41\n');
  const merged = mergeRestarts([
    { startTime: '2', table: second },
    { startTime: '0', table: first },
  ]);
  assert.deepEqual(merged.rows, [[1, 10], [2, 21], [3, 31], [4, 41]]);
  assert.equal(merged.overwritten, 2);
  assert.deepEqual(merged.startTimes, ['0', '2']);
});

test('a restart whose columns changed is left out and reported', () => {
  const first = parseFoamTable('# Time p\n1 10\n');
  const second = parseFoamTable('# Time p U_x\n2 20 1\n');
  const merged = mergeRestarts([
    { startTime: '0', table: first },
    { startTime: '2', table: second },
  ]);
  // The newest run defines the shape; the older, differently shaped one is
  // named rather than silently blended into it.
  assert.deepEqual(merged.columns, ['Time', 'p', 'U_x']);
  assert.deepEqual(merged.incompatible, ['0']);
  assert.equal(merged.rows.length, 1);
});

test('downsampling always keeps the final sample', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [i, i * 2]);
  const thinned = downsampleRows(rows, 100);
  assert.ok(thinned.length <= 101);
  assert.deepEqual(thinned[thinned.length - 1], [999, 1998]);
  assert.deepEqual(thinned[0], [0, 0]);
  // Below the limit nothing is touched at all.
  assert.equal(downsampleRows(rows, 5000), rows);
});

test('CSV export keeps every supplied row and quotes real CSV cells', () => {
  const csv = serializeCsv(
    ['Time', 'force, total', 'probe "A"'],
    [[0, 1.25, null], [1, -2, 3]],
  );
  assert.equal(
    csv,
    'Time,"force, total","probe ""A"""\n0,1.25,\n1,-2,3\n',
  );
});

test('tail statistics describe a settled series and a drifting one differently', () => {
  const settled = Array.from({ length: 100 }, (_, i) => [i, 5 + Math.sin(i) * 1e-9]);
  const drifting = Array.from({ length: 100 }, (_, i) => [i, i]);

  const a = summarizeColumn(settled, 1);
  assert.ok(a.drift < 1e-6, `expected a settled series, drift was ${a.drift}`);
  assert.ok(Math.abs(a.tailMean - 5) < 1e-6);

  const b = summarizeColumn(drifting, 1);
  assert.ok(b.drift > 0.1, `expected a drifting series, drift was ${b.drift}`);
  assert.equal(b.last, 99);
  assert.equal(b.min, 0);
  assert.equal(b.max, 99);
});

test('drift is unknown, not zero, when there is not enough data to judge', () => {
  // Zero would read as "converged" on a series that has barely started.
  const stats = summarizeColumn([[0, 1]], 1);
  assert.ok(Number.isNaN(stats.drift));
  assert.equal(stats.samples, 1);
});

test('a column with no finite values reports no samples rather than throwing', () => {
  const stats = summarizeColumn([[0, NaN], [1, NaN]], 1);
  assert.equal(stats.samples, 0);
  assert.ok(Number.isNaN(stats.mean));
});

// The template below is the installed OpenFOAM 14 `graphUniform`, trimmed to
// the parts that matter. Its shape is what makes a generated form possible.
const GRAPH_UNIFORM = `/*--------------------------------*- C++ -*----------------------------------*\\
-------------------------------------------------------------------------------
Description
    Writes graph data for specified fields along a line, specified by start and
    end points.

\\*---------------------------------------------------------------------------*/

start           <point>;
end             <point>;
nPoints         <number>;

fields          (<fieldNames>);

axis            distance; // The independent variable of the graph. Can be "x",
                          // "y", "z", or "distance" (from the start point).

#includeEtc "caseDicts/functions/graphs/graphUniform.cfg"
`;

test('a case dictionary template yields its prose, its arguments and their kinds', () => {
  const template = parseFunctionTemplate(GRAPH_UNIFORM);
  assert.ok(template.description.startsWith('Writes graph data for specified fields along a line'));

  const byName = Object.fromEntries(template.args.map(arg => [arg.name, arg]));
  assert.deepEqual(Object.keys(byName).sort(), ['axis', 'end', 'fields', 'nPoints', 'start']);

  assert.equal(byName.start.kind, 'point');
  assert.equal(byName.start.required, true);
  assert.equal(byName.nPoints.kind, 'number');

  // `fields (<fieldNames>);` is written already wrapped, so the composer must
  // put the parentheses back when it rebuilds the call.
  assert.equal(byName.fields.kind, 'fieldList');
  assert.equal(byName.fields.listWrapped, true);

  // An entry with a real value is a default, not a blank to be filled in.
  assert.equal(byName.axis.required, false);
  assert.equal(byName.axis.placeholder, 'distance');
});

test('help that wraps onto the next line is kept whole', () => {
  const template = parseFunctionTemplate(GRAPH_UNIFORM);
  const axis = template.args.find(arg => arg.name === 'axis');
  assert.ok(axis);
  assert.ok(axis.help.includes('The independent variable'));
  assert.ok(axis.help.includes('from the start point'), 'the continuation line carries the example');
});

test('the closing rule of the file is not glued onto the last argument as help', () => {
  // Every forces argument used to end in a row of asterisks, because OpenFOAM
  // closes each template with `// ****…**** //` and that is a comment line like
  // any other.
  const template = parseFunctionTemplate(
    'pitchAxis   <pitchAxis>;   // Pitch axis; e.g., (0 1 0)\n\n// ************************************************************************* //\n',
  );
  const arg = template.args.find(entry => entry.name === 'pitchAxis');
  assert.ok(arg);
  assert.equal(arg.help, 'Pitch axis; e.g., (0 1 0)');
});

test('the function-object base interface is not offered as parameters', () => {
  // The installed `yPlus` template holds exactly these four entries and nothing
  // else. Its whole call is `-func yPlus`, so a form with four fields on it
  // would be four fields of noise.
  const template = parseFunctionTemplate(
    'type            yPlus;\nlibs            ("libfieldFunctionObjects.so");\n\nexecuteControl  writeTime;\nwriteControl    writeTime;\n',
  );
  assert.deepEqual(template.args, []);
});

test('the include directive and the banner do not become form fields', () => {
  const template = parseFunctionTemplate(`FoamFile\n{\n    format ascii;\n    class dictionary;\n}\nfields (<fieldNames>);\n#includeEtc "caseDicts/x.cfg"\n`);
  assert.deepEqual(template.args.map(arg => arg.name), ['fields']);
});

test('a function specification is composed the way OpenFOAM accepts it', () => {
  const known = ['graphUniform', 'volAverage'];
  assert.equal(
    buildFunctionSpec('graphUniform', { start: '(0.01 0.05 0.005)', nPoints: '20', fields: '(p U)' }, known),
    'graphUniform(start=(0.01 0.05 0.005), nPoints=20, fields=(p U))',
  );
  // No arguments is a legitimate call for the many functions that need none.
  assert.equal(buildFunctionSpec('volAverage', {}, known), 'volAverage');
  // A blank field is left out rather than sent as an empty entry.
  assert.equal(buildFunctionSpec('volAverage', { p: '  ' }, known), 'volAverage');
});

test('a value is put into the parentheses OpenFOAM expects, whatever the template spelled', () => {
  // `start <point>;` shows no parentheses in the template but a point value
  // still needs them, and composing from the template's spelling alone sent
  // `start=0.01 0.05 0.005`, which OpenFOAM rejected.
  assert.equal(wrapFoamValue('0.01 0.05 0.005', false), '(0.01 0.05 0.005)');
  // A list entry is wrapped even when it holds a single item.
  assert.equal(wrapFoamValue('p', true), '(p)');
  assert.equal(wrapFoamValue('p U', true), '(p U)');
  // A single scalar is not a list and must not gain parentheses.
  assert.equal(wrapFoamValue('40', false), '40');
  assert.equal(wrapFoamValue('distance', false), 'distance');
  // Already one balanced group: left exactly as written.
  assert.equal(wrapFoamValue('(p U)', true), '(p U)');
  assert.equal(wrapFoamValue('(0 0 1)', false), '(0 0 1)');
  // Two groups are NOT one group, so a list of points gains its outer pair
  // rather than being mistaken for an already-wrapped value.
  assert.equal(
    wrapFoamValue('(0.005 0.005 0.005) (0.007 0.007 0.005)', true),
    '((0.005 0.005 0.005) (0.007 0.007 0.005))',
  );
  assert.equal(wrapFoamValue('   ', false), '');
});

test('only function objects this installation reported can be composed', () => {
  assert.throws(
    () => buildFunctionSpec('somethingElse', {}, ['graphUniform']),
    FunctionSpecError,
  );
});

test('shell syntax cannot reach the composed specification', () => {
  const known = ['volAverage'];
  for (const hostile of ['p); rm -rf /', '$(whoami)', '`id`', 'p > /etc/passwd', 'a\nb']) {
    assert.throws(
      () => buildFunctionSpec('volAverage', { fields: hostile }, known),
      FunctionSpecError,
      `expected ${JSON.stringify(hostile)} to be refused`,
    );
  }
});

test('the placeholders the installed templates actually use are classified by shape', () => {
  // The vocabulary below was counted across all 127 OpenFOAM 14 templates, not
  // invented: <fieldNames> 38, <fieldName> 22, <point> 11, <patchName> 6,
  // <points> 5, <patchNames> 5, <nPoints> 5, and so on. The singular/plural
  // split is the one that matters and the one the first version missed, which
  // left `patch <patchName>;` showing a literal placeholder as its example.
  const kindOf = (placeholder: string) =>
    parseFunctionTemplate(`entry ${placeholder};\n`).args[0].kind;

  assert.equal(kindOf('<fieldNames>'), 'fieldList');
  assert.equal(kindOf('<fieldName>'), 'fieldName');
  assert.equal(kindOf('<weightFieldNames>'), 'fieldList');
  assert.equal(kindOf('<isoFieldName>'), 'fieldName');

  assert.equal(kindOf('<patchNames>'), 'patchList');
  assert.equal(kindOf('<patchName>'), 'patchName');
  assert.equal(kindOf('<patchName1>'), 'patchName');

  assert.equal(kindOf('<point>'), 'point');
  assert.equal(kindOf('<points>'), 'pointList');
  assert.equal(kindOf('<CofR>'), 'point');
  assert.equal(kindOf('<liftDir>'), 'point');
  assert.equal(kindOf('<normal>'), 'point');

  assert.equal(kindOf('<nPoints>'), 'number');
  assert.equal(kindOf('<isoValue>'), 'number');

  // `axis` is NOT a direction here: in the graph templates it means "x", "y",
  // "z" or "distance", so classifying it as a vector would offer `(0 0 0)`.
  assert.equal(kindOf('<axis>'), 'text');
  // Nor is `<coordinate>`: `coordinateType <coordinate>;` names one of
  // "volume", "area" or "diameter", and offering a vector for it produced a
  // call OpenFOAM refused.
  assert.equal(kindOf('<coordinate>'), 'text');
  // `fieldType <fieldType>;` in the `uniform` template is a class name —
  // volScalarField — not a field of the case.
  assert.equal(kindOf('<fieldType>'), 'text');
  // Zones can be named from the case, the same way patches can.
  assert.equal(kindOf('<faceZoneName>'), 'faceZone');
  // Unrecognised placeholders stay text, so the example shows the hole.
  assert.equal(kindOf('<phaseName>'), 'text');
  assert.equal(kindOf('<triSurfaceFileName>'), 'text');
});

test('a singular patch argument names a patch of the case', () => {
  const arg = {
    name: 'patch', kind: 'patchName' as const, listWrapped: false,
    placeholder: '<patchName>', help: '', required: true, commented: false,
  };
  assert.equal(exampleArgValue(arg, { patches: ['movingWall', 'fixedWalls'] }), 'movingWall');
  // With no case to ask, the hole stays visible rather than naming a patch that
  // may not exist.
  assert.equal(exampleArgValue(arg, {}), '<patchName>');
});

test('the second patch of a difference is the other one', () => {
  // `patchDifference(patch1=inlet, patch2=inlet)` asks OpenFOAM for a quantity
  // that is zero by construction, which reads as a broken function rather than
  // as an example that still needs editing.
  const second = {
    name: 'patch2', kind: 'patchName' as const, listWrapped: false,
    placeholder: '<patchName2>', help: '', required: true, commented: false,
  };
  assert.equal(exampleArgValue(second, { patches: ['movingWall', 'fixedWalls'] }), 'fixedWalls');
  // One patch and there is no other to name; the first is still better than a
  // placeholder.
  assert.equal(exampleArgValue(second, { patches: ['movingWall'] }), 'movingWall');
});

test('a direction is a direction, and a sampled line crosses the mesh', () => {
  const bounds: [number, number, number, number, number, number] = [0, 0, 0, 0.1, 0.2, 0.01];
  const point = (name: string) => exampleArgValue(
    {
      name, kind: 'point' as const, listWrapped: false,
      placeholder: `<${name}>`, help: '', required: true, commented: false,
    },
    { bounds },
  );
  // `normal=(0 0 0)` is not a plane and `direction=(0 0 0)` is not a direction.
  assert.equal(point('normal'), '(1 0 0)');
  assert.equal(point('direction'), '(1 0 0)');
  assert.equal(point('liftDir'), '(1 0 0)');

  // A line of zero length is what every graph template used to be offered. The
  // longest side here is y, so the sample runs along it through the centre.
  assert.notEqual(point('start'), point('end'));
  assert.ok(point('start').startsWith('(0.05 '));
  assert.ok(point('end').startsWith('(0.05 '));
  assert.ok(point('start').endsWith(' 0.005)'));

  // An origin sits in the middle of the mesh, which is inside it whatever
  // shape the mesh has.
  assert.equal(point('origin'), '(0.05 0.1 0.005)');
});

test('a field argument names a field the case has written', () => {
  const one = {
    name: 'field', kind: 'fieldName' as const, listWrapped: false,
    placeholder: '<fieldName>', help: '', required: true, commented: false,
  };
  const many = {
    ...one, name: 'fields', kind: 'fieldList' as const,
    listWrapped: true, placeholder: '<fieldNames>',
  };
  assert.equal(exampleArgValue(one, { fields: ['T', 'U'] }), 'U');
  assert.equal(exampleArgValue(many, { fields: ['T', 'U', 'p'] }), '(p U)');
  // With no case to ask, the pair every OpenFOAM case has.
  assert.equal(exampleArgValue(many, {}), '(p U)');

  // A time directory holds whatever the run and every earlier function object
  // wrote into it, so the first name alphabetically is usually bookkeeping:
  // the solved variables come first when the case has them.
  assert.equal(exampleArgValue(one, { fields: ['C', 'Ccx', 'U', 'p', 'Vc'] }), 'p');
  assert.equal(exampleArgValue(many, { fields: ['C', 'Ccx', 'U', 'p', 'Vc'] }), '(p U)');
  // A case with none of them keeps its own order rather than inventing names.
  assert.equal(exampleArgValue(one, { fields: ['Ccx', 'Vc'] }), 'Ccx');
});

test('an example value is taken from the template\'s own documentation', () => {
  // `magUInf <magUInf>; // Far field velocity magnitude; e.g., 20 m/s`
  const documented = {
    name: 'magUInf', kind: 'text' as const, listWrapped: false,
    placeholder: '<magUInf>', help: 'Far field velocity magnitude; e.g., 20 m/s',
    required: true, commented: false,
  };
  // The value, not the prose: `20 m/s` is a sentence, `20` is what the
  // dictionary accepts.
  assert.equal(exampleArgValue(documented), '20');

  const vector = { ...documented, name: 'CofR', help: 'Centre of rotation; e.g., (0 0 0)' };
  assert.equal(exampleArgValue(vector), '(0 0 0)');

  // `wallHeatTransferCoeff` writes `e.g, 0.7` — no second full stop. Requiring
  // the complete `e.g.` left its Prandtl number a bare `<Pr>` in an otherwise
  // finished call.
  const typo = { ...documented, name: 'Pr', help: 'Laminar Prandtl number; e.g, 0.7' };
  assert.equal(exampleArgValue(typo), '0.7');
});

test('an undocumented placeholder stays visible instead of being guessed at', () => {
  const opaque = {
    name: 'whatever', kind: 'text' as const, listWrapped: false,
    placeholder: '<whatever>', help: '', required: true, commented: false,
  };
  assert.equal(exampleArgValue(opaque), '<whatever>');
});

test('a placeholder for a list keeps the brackets the list needs', () => {
  // `objects (<objectNames>);` unwrapped produced `objects=<objectNames>`, and
  // OpenFOAM refused it not as an unfilled hole but as a broken list:
  // "incorrect first token, expected <int> or '(', found the word
  // '<objectNames>'". Filling in `p U` over the bare form failed the same way.
  const objects = {
    name: 'objects', kind: 'text' as const, listWrapped: true,
    placeholder: '<objectNames>', help: '', required: true, commented: false,
  };
  assert.equal(exampleArgValue(objects), '(<objectNames>)');
});

test('a patch argument uses a patch the case actually has', () => {
  const arg = {
    name: 'patches', kind: 'patchList' as const, listWrapped: true,
    placeholder: '<patchNames>', help: '', required: true, commented: false,
  };
  assert.equal(exampleArgValue(arg, { patches: ['movingWall', 'fixedWalls'] }), '(movingWall)');
  // With no case to ask, the placeholder stays visible rather than inventing a
  // patch name that would fail at the first run — with its brackets, because
  // the entry is a list either way.
  assert.equal(exampleArgValue(arg, {}), '(<patchNames>)');
});

test('the call template is runnable, and names its own output directory', () => {
  const args = [
    { name: 'start', kind: 'point' as const, listWrapped: false, placeholder: '<point>', help: '', required: true, commented: false },
    { name: 'nPoints', kind: 'number' as const, listWrapped: false, placeholder: '<number>', help: '', required: true, commented: false },
    { name: 'fields', kind: 'fieldList' as const, listWrapped: true, placeholder: '<fieldNames>', help: '', required: true, commented: false },
    { name: 'axis', kind: 'text' as const, listWrapped: false, placeholder: 'distance', help: '', required: false, commented: false },
  ];
  // `name=` first, as every tutorial writes it: without it the output lands in
  // a directory named after the whole call with its spaces stripped.
  assert.equal(
    buildCallTemplate('graphUniform', args),
    'graphUniform(name=graphUniform, start=(0 0 0), nPoints=100, fields=(p U))',
  );
  // Optional entries are left out of the line; the panel documents them below.
  assert.ok(!buildCallTemplate('graphUniform', args).includes('axis'));
});

test('the controlDict entry wraps the same call the panel would run', () => {
  assert.equal(
    buildFunctionsEntry('yPlus'),
    'functions\n{\n    #includeFunc yPlus\n}',
  );
  // A trailing semicolon is how tutorials sometimes write it and is not part
  // of the call.
  assert.ok(buildFunctionsEntry('cellMin(name=pMin, p);').includes('#includeFunc cellMin(name=pMin, p)\n'));
});

test('a typed specification is checked against the installation and the syntax', () => {
  const known = ['graphUniform', 'yPlus'];
  assert.equal(validateTypedSpec('  yPlus ;  ', known), 'yPlus');
  assert.equal(
    validateTypedSpec('graphUniform(name=a, start=(0 0 0))', known),
    'graphUniform(name=a, start=(0 0 0))',
  );
  // Positional fields, the form the tutorials use.
  assert.equal(validateTypedSpec('yPlus(p, U)', known), 'yPlus(p, U)');
});

test('a typed specification that could not run is refused before OpenFOAM sees it', () => {
  const known = ['yPlus'];
  for (const bad of ['', '   ', 'notAFunction', 'yPlus(', 'yPlus(a))', '(yPlus)', 'yPlus; rm -rf /', 'yPlus($(id))']) {
    assert.throws(() => validateTypedSpec(bad, known), FunctionSpecError, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('what a template hides behind its include is read, and not repeated', () => {
  // `volAverage` looks empty until you follow it to `volValue.cfg`: the class
  // and the entries that already have a value live there, not in the template.
  const template = 'fields  (<fieldNames>);\n#includeEtc "caseDicts/functions/volFieldValue/volAverage.cfg"\n';
  const files = {
    'caseDicts/functions/volFieldValue/volAverage.cfg':
      'operation  volAverage;\n#includeEtc "caseDicts/functions/volFieldValue/volValue.cfg"\n',
    'caseDicts/functions/volFieldValue/volValue.cfg':
      'type  volFieldValue;\nlibs  ("libfieldFunctionObjects.so");\ncellZone  all;\n',
  };
  const extras = resolveTemplateExtras(template, files);

  assert.equal(extras.type, 'volFieldValue');
  assert.deepEqual(extras.defaults.map(entry => `${entry.name}=${entry.value}`), ['operation=volAverage', 'cellZone=all']);
  // `fields` is an ARGUMENT and is listed as one; showing it here too is the
  // duplication this section exists to avoid.
  assert.ok(!extras.defaults.some(entry => entry.name === 'fields'));
  // `type` and `libs` are the class, not something to override.
  assert.ok(!extras.defaults.some(entry => entry.name === 'type' || entry.name === 'libs'));
});

test('a configuration wiring one of its own keys to an argument is not a default', () => {
  // `probeLocations $points;` is plumbing: it points at the template's own
  // `points` argument and would just repeat it.
  const extras = resolveTemplateExtras(
    'points (<points>);\n#includeEtc "cfg"\n',
    { cfg: 'type probes;\nprobeLocations $points;\nfixedLocations false;\n' },
  );
  assert.deepEqual(extras.defaults.map(entry => entry.name), ['fixedLocations']);
});

test('an include chain that loops does not spin', () => {
  const extras = resolveTemplateExtras(
    '#includeEtc "a"\n',
    { a: 'type sets;\n#includeEtc "b"\n', b: 'interpolationScheme cellPoint;\n#includeEtc "a"\n' },
  );
  assert.equal(extras.type, 'sets');
  assert.deepEqual(extras.defaults.map(entry => entry.name), ['interpolationScheme']);
});

test('the tutorials supply the examples, matched on the whole name', () => {
  const lines = [
    '    #includeFunc graphCell(name=lineA, start=(0 0 0), end=(0 1 0), U)',
    '#includeFunc graphCellFace(name=other)',
    '#includeFunc graphCell(name=lineB, start=(1 0 0), end=(1 1 0), U);',
    '#includeFunc graphCell',
    '#includeFunc graphCell(name=lineA, start=(0 0 0), end=(0 1 0), U)',
  ];
  const examples = tutorialExamplesFor('graphCell', lines);
  // `graphCellFace` is a different function and must not be collected, the
  // duplicate appears once, and the bare `graphCell` teaches nothing the panel
  // has not already said.
  assert.deepEqual(examples, [
    'graphCell(name=lineA, start=(0 0 0), end=(0 1 0), U)',
    'graphCell(name=lineB, start=(1 0 0), end=(1 1 0), U)',
  ]);
  assert.deepEqual(tutorialExamplesFor('nothingLikeThis', lines), []);
});

test('a quoted argument survives tokenising, brackets and spaces included', () => {
  // `-func "graphUniform(start=(0 0 0))"` is ONE argument. Splitting on
  // whitespace would make it four and lose the call.
  assert.deepEqual(
    tokenizeCommand('foamPostProcess -func "graphUniform(start=(0 0 0), fields=(p U))"'),
    ['foamPostProcess', '-func', 'graphUniform(start=(0 0 0), fields=(p U))'],
  );
  assert.deepEqual(tokenizeCommand("a -time '5:'"), ['a', '-time', '5:']);
});

test('an edited command is read back into the pieces the runner accepts', () => {
  const known = ['graphUniform', 'yPlus'];
  const parsed = parsePostProcessCommand(
    'foamPostProcess -func "graphUniform(name=lineA, start=(0 0 0))" -time 5: -fields "(U p)" -latestTime',
    known,
  );
  assert.equal(parsed.spec, 'graphUniform(name=lineA, start=(0 0 0))');
  assert.equal(parsed.time, '5:');
  assert.deepEqual(parsed.fields, ['U', 'p']);
  assert.equal(parsed.latestTime, true);
  assert.equal(parsed.noZero, undefined);

  // The utility name may be left off; the flags alone are enough.
  assert.equal(parsePostProcessCommand('-func yPlus', known).spec, 'yPlus');
  // And either spelling of it is accepted, since which one exists depends on
  // the OpenFOAM version.
  assert.equal(parsePostProcessCommand('postProcess -func yPlus', known).spec, 'yPlus');
});

test('an editable command is not an editable shell', () => {
  const known = ['yPlus'];
  const refused: [string, string][] = [
    ['rm -rf / -func yPlus', 'a command that is not the utility'],
    ['foamPostProcess -func yPlus -case /etc', '-case, which would leave the open case'],
    ['foamPostProcess -func yPlus -exec something', 'an unknown flag'],
    ['foamPostProcess -func notAFunction', 'a function this installation does not have'],
    ['foamPostProcess -time 5:', 'no -func at all'],
    ['foamPostProcess -func', '-func with no value'],
    ['foamPostProcess -func yPlus -fields "(U; rm -rf /)"', 'a field name that is not one'],
    ['foamPostProcess -func yPlus stray', 'a stray argument outside -func'],
    ['', 'nothing'],
  ];
  for (const [command, why] of refused) {
    assert.throws(() => parsePostProcessCommand(command, known), FunctionSpecError, `expected to refuse ${why}`);
  }
});

test('the default command is the call, quoted, under the utility this version has', () => {
  assert.equal(
    buildCommandTemplate('foamPostProcess', 'yPlus'),
    'foamPostProcess -func "yPlus"',
  );
});

test('a dataset directory name is split for display without inventing its numbers', () => {
  // OpenFOAM strips the spaces out of the directory name, so `(0.010.050.005)`
  // cannot be split back into three numbers. Nothing is reconstructed.
  const described = describeDatasetName('graphUniform(start=(0.010.050.005),nPoints=20)');
  assert.equal(described.base, 'graphUniform');
  assert.equal(described.arguments, 'start=(0.010.050.005),nPoints=20');
  assert.deepEqual(describeDatasetName('yPlus'), { base: 'yPlus', arguments: '' });
});

test('geometry output is not offered as a chart, and extensionless probe files are', () => {
  assert.equal(isTabularOutput('volFieldValue.dat'), true);
  assert.equal(isTabularOutput('line.xy'), true);
  assert.equal(isTabularOutput('U'), true);
  assert.equal(isTabularOutput('surface.vtk'), false);
  assert.equal(isTabularOutput('cut.vtp'), false);
});


// ── Comment attribution, which is where a reference silently lies ──
//
// The four fixtures below are the shapes the installed templates actually use.
// Each one produced documentation belonging to another entry, or none at all.

test('a comment above an entry introduces it, and does not belong to the one before', () => {
  // Verbatim from `etc/caseDicts/postProcessing/fields/randomise`. The comment
  // describes `magPerturbation`, and gluing it to the entry above gave `field`
  // a help text about a perturbation it has nothing to do with.
  const template = parseFunctionTemplate([
    '\\*---------------------------------------------------------------------------*/',
    '',
    'field           <fieldName>;',
    '',
    '// Set the magnitude of the perturbation',
    'magPerturbation <scalar>;',
    '',
  ].join('\n'));

  const byName = Object.fromEntries(template.args.map(arg => [arg.name, arg]));
  assert.equal(byName.field.help, '');
  assert.equal(byName.magPerturbation.help, 'Set the magnitude of the perturbation');
});

test('an entry the template writes out commented is an option, not prose', () => {
  // `graphCutLayerAverage` offers `distance` as the alternative to `direction`
  // exactly this way. Read as prose it swallowed the help of the entry above
  // and the option itself was never mentioned anywhere.
  const template = parseFunctionTemplate([
    '\\*---------------------------------------------------------------------------*/',
    '',
    'direction       <direction>; // Direction along which to graph',
    '',
    '//distance      <fieldName>; // Name of the distance field. Either this or',
    '                             // direction should be specified; not both.',
    '',
    'nPoints         <nPoints>;   // Number of points in the graph',
    '',
  ].join('\n'));

  const byName = Object.fromEntries(template.args.map(arg => [arg.name, arg]));
  assert.equal(byName.direction.help, 'Direction along which to graph');
  assert.equal(byName.direction.commented, false);

  assert.equal(byName.distance.commented, true);
  // Commented means off: it can never be something the caller MUST supply, and
  // it never appears in the call the panel builds.
  assert.equal(byName.distance.required, false);
  assert.ok(byName.distance.help.includes('Name of the distance field'));
  assert.ok(byName.distance.help.includes('not both'));

  assert.equal(byName.nPoints.help, 'Number of points in the graph');
  assert.ok(!buildCallTemplate('graphCutLayerAverage', template.args).includes('distance='));
});

test('a comment that wraps is one help text, and a blank comment line does not end it', () => {
  // `populationBalanceSetSizeDistribution` writes its example distribution as
  // an indented block with empty `//` lines inside it.
  const template = parseFunctionTemplate([
    '\\*---------------------------------------------------------------------------*/',
    '',
    'file  <file>; // Distribution file. E.g.:',
    '              //',
    '              // ( (1e-3 0.2) (2e-3 0.4) )',
    '',
  ].join('\n'));
  const file = template.args.find(arg => arg.name === 'file');
  assert.ok(file);
  assert.ok(file.help.includes('Distribution file'));
  assert.ok(file.help.includes('(1e-3 0.2)'));
});

test('a sub-dictionary is not flattened into the argument list', () => {
  // The same template wires its own `distribution { Q $Q; file $file; }`.
  // Flattened, it offered `Q` and `file` twice, the second time with the
  // wiring itself as their value.
  const template = parseFunctionTemplate([
    '\\*---------------------------------------------------------------------------*/',
    '',
    'file                <file>;',
    'Q                   0;',
    '',
    'distribution',
    '{',
    '    type                tabulatedDensity;',
    '    Q                   $Q;',
    '    file                $file;',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(template.args.map(arg => arg.name), ['file', 'Q']);
});

test('an entry wired to another is plumbing, not a parameter', () => {
  // `CourantNo` writes `phi phi; field $phi;`. The second is the template
  // pointing one of its own entries at the first; offering `field = $phi` as a
  // parameter is offering the wiring.
  const template = parseFunctionTemplate('phi             phi;\nfield           $phi;\n');
  assert.deepEqual(template.args.map(arg => arg.name), ['phi']);
});

test('a base-interface key is noise with a value and an argument with a placeholder', () => {
  // `yPlus` holds only the base interface and takes no arguments at all…
  assert.deepEqual(
    parseFunctionTemplate('writeControl    writeTime;\nexecuteControl  writeTime;\n').args,
    [],
  );
  // …but `writeMesh` writes `writeControl <writeControl>;`, and dropping that
  // offered a function with no arguments that then aborted on "Essential value
  // for keyword 'writeControl' not set".
  const writeMesh = parseFunctionTemplate('writeControl    <writeControl>;\n');
  assert.equal(writeMesh.args.length, 1);
  assert.equal(writeMesh.args[0].name, 'writeControl');
  assert.equal(writeMesh.args[0].required, true);
});

test('a Description sentence is never read as an entry', () => {
  const template = parseFunctionTemplate([
    '/*--------------------------------*- C++ -*----------------------------------*\\',
    '-------------------------------------------------------------------------------',
    'Description',
    '    Calculates the flow rate; the result is volumetric.',
    '',
    '    Two things follow:',
    '    - the first',
    '    - the second',
    '',
    '\\*---------------------------------------------------------------------------*/',
    '',
    'patch   <patchName>;',
    '',
  ].join('\n'));

  assert.deepEqual(template.args.map(arg => arg.name), ['patch']);
  // The prose keeps its shape: a list run together into the paragraph above it
  // is the wall of text the panel exists to avoid.
  assert.deepEqual(template.descriptionParagraphs, [
    'Calculates the flow rate; the result is volumetric.',
    'Two things follow:',
    '- the first',
    '- the second',
  ]);
  assert.ok(template.description.startsWith('Calculates the flow rate'));
});

test('the options a configuration hides are listed apart from its defaults', () => {
  const template = 'fields  (<fieldNames>);\n#includeEtc "caseDicts/functions/x.cfg"\n';
  const files = {
    'caseDicts/functions/x.cfg': [
      'type        volFieldValue;',
      'libs        ("libfieldFunctionObjects.so");',
      'operation   volAverage;',
      '//weightField <weightFieldName>; // Field with which to weight the average',
      '',
    ].join('\n'),
  };

  const extras = resolveTemplateExtras(template, files);
  assert.equal(extras.type, 'volFieldValue');
  assert.deepEqual(extras.libs, ['libfieldFunctionObjects.so']);
  // A commented entry has no value set, so it is not a default to override.
  assert.deepEqual(extras.defaults.map(entry => entry.name), ['operation']);

  const optional = optionalTemplateEntries(template, files);
  assert.deepEqual(optional.map(arg => arg.name), ['weightField']);
  assert.ok(optional[0].help.includes('weight the average'));
});

// ── The command line, against the options the installation actually has ──

test('the solver option is read, and refused when this OpenFOAM has none', () => {
  const known = ['forceCoeffsIncompressible'];
  const offered = ['-func', '-time', '-solver', '-latestTime'];
  const parsed = parsePostProcessCommand(
    'foamPostProcess -func "forceCoeffsIncompressible" -solver incompressibleFluid -latestTime',
    known, offered,
  );
  assert.equal(parsed.solver, 'incompressibleFluid');
  assert.equal(parsed.latestTime, true);

  // The older line has no `-solver`, and argList answers an unknown option
  // with its whole usage screen rather than with anything about the mistake.
  assert.throws(
    () => parsePostProcessCommand(
      'postProcess -func "forceCoeffsIncompressible" -solver incompressibleFluid',
      known, ['-func', '-time', '-latestTime'],
    ),
    FunctionSpecError,
  );
});

test('a solver and a field list are two different answers to the same question', () => {
  // With `-solver` the utility loads the module and never looks at the field
  // options, so a line carrying both hides which one is in force.
  assert.throws(
    () => parsePostProcessCommand(
      'foamPostProcess -func "yPlus" -solver incompressibleFluid -fields "(U p)"',
      ['yPlus'], ['-func', '-solver', '-fields'],
    ),
    FunctionSpecError,
  );
});

test('the singular field option joins the list the utility keeps', () => {
  const parsed = parsePostProcessCommand(
    'foamPostProcess -func "mag(U)" -field p -fields "(U phi)"',
    ['mag'], ['-func', '-field', '-fields'],
  );
  assert.deepEqual(parsed.fields, ['p', 'U', 'phi']);
});

test('the command shown carries the solver when there is one to name', () => {
  assert.equal(
    buildCommandTemplate('foamPostProcess', 'yPlus', { solver: 'incompressibleFluid' }),
    'foamPostProcess -func "yPlus" -solver incompressibleFluid',
  );
  assert.equal(buildCommandTemplate('postProcess', 'yPlus'), 'postProcess -func "yPlus"');
});

// ── The class reference, as the installation's own source writes it ──

test('a class header is read into prose, examples and a property table', () => {
  // Trimmed from `src/functionObjects/field/fieldValues/volFieldValue/
  // volFieldValue.H` — the shape, not an invented one.
  const header = [
    'Class',
    '    Foam::functionObjects::fieldValues::volFieldValue',
    '',
    'Description',
    '    Provides a \\c fvCellZone specialisation of the fieldValue function object.',
    '',
    '    Example of function object specification:',
    '    \\verbatim',
    '    volFieldValue1',
    '    {',
    '        type            volFieldValue;',
    '        operation       volAverage;',
    '    }',
    '    \\endverbatim',
    '',
    'Usage',
    '    \\table',
    '        Property     | Description                   | Required | Default value',
    '        cellZone     | cellZone                      | yes      |',
    '        weightField  | Name of field to apply weighting | no    | none',
    '    \\endtable',
    '',
    '    Where \\c cellZone options are:',
    '    \\plaintable',
    '        cellZone \\<name\\>  | Looks-up the named cellZone',
    '        cellZone {type \\<zoneGeneratorType\\>;...} | \\\\',
    '            Generates the cellZone locally',
    '    \\endplaintable',
    '',
    'See also',
    '    Foam::functionObjects::fieldValues::fieldValue',
    '',
    'SourceFiles',
    '    volFieldValue.C',
    '',
    '\\*---------------------------------------------------------------------------*/',
    '',
    '#ifndef volFieldValue_functionObject_H',
  ].join('\n');

  const doc = parseClassDocumentation(header);
  assert.ok(doc);
  assert.equal(doc.className, 'Foam::functionObjects::fieldValues::volFieldValue');

  // `\c fvCellZone` means "fvCellZone, in code font"; left in place the markup
  // reads as part of the sentence.
  const prose = doc.description.find(block => block.kind === 'text');
  assert.ok(prose && prose.kind === 'text' && prose.text.includes('fvCellZone specialisation'));
  assert.ok(prose.kind === 'text' && !prose.text.includes('\\c'));

  // The dictionary example keeps its own nesting and loses the comment's.
  const example = doc.description.find(block => block.kind === 'code');
  assert.ok(example && example.kind === 'code');
  assert.equal(example.lines[0], 'volFieldValue1');
  assert.equal(example.lines[2], '    type            volFieldValue;');

  const table = doc.usage.find(block => block.kind === 'table' && block.head);
  assert.ok(table && table.kind === 'table');
  assert.deepEqual(table.head, ['Property', 'Description', 'Required', 'Default value']);
  assert.deepEqual(table.rows[0], ['cellZone', 'cellZone', 'yes', '']);
  assert.deepEqual(table.rows[1], ['weightField', 'Name of field to apply weighting', 'no', 'none']);

  // A plaintable has no header row, and a row continued onto the next line is
  // one row: the longer cellZone forms are written that way.
  const plain = doc.usage.find(block => block.kind === 'table' && !block.head);
  assert.ok(plain && plain.kind === 'table');
  assert.equal(plain.rows.length, 2);
  assert.equal(plain.rows[0][0], 'cellZone <name>');
  assert.ok(plain.rows[1][1].includes('Generates the cellZone locally'));

  assert.deepEqual(doc.seeAlso, ['Foam::functionObjects::fieldValues::fieldValue']);
});

test('a header with no class of its own has no documentation to show', () => {
  // Showing another class's reference would be worse than showing none, so the
  // caller is told there is nothing rather than given a guess.
  assert.equal(parseClassDocumentation('Description\n    Something.\n'), null);
});

test('a continuation table is not given the first property as its heading', () => {
  // `forceCoeffs` opens a SECOND \table for its bin entries without repeating
  // the column names. Taking the first row regardless promoted
  // `nBin | number of data bins | yes` into a heading — a property presented
  // as a column label. OpenFOAM's own convention settles it: a heading names
  // its second column "Description".
  const doc = parseClassDocumentation([
    'Class',
    '    Foam::functionObjects::forceCoeffs',
    '',
    'Usage',
    '    \\table',
    '        nBin         | number of data bins     | yes         |',
    '        cumulative   | bin data accumulated    | yes         |',
    '    \\endtable',
    '',
    '\\*---------------------------------------------------------------------------*/',
  ].join('\n'));

  assert.ok(doc);
  const table = doc.usage[0];
  assert.ok(table && table.kind === 'table');
  assert.equal(table.head, null);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0], 'nBin');
});
