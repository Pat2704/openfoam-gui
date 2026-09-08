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
  FunctionSpecError,
  describeDatasetName,
  isTabularOutput,
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
