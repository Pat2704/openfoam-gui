/** The File Editor's comment colouring and indent guides (src/lib/editor-highlight.ts). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canHighlight, highlightFoam, syntaxFor, HIGHLIGHT_MAX_LINES } from '../src/lib/editor-highlight.ts';

const comments = (text: string) => highlightFoam(text).map(line =>
  line.segments.filter(s => s.comment).map(s => s.text).join('|'));

describe('comments', () => {
  test('a line comment runs to the end of the line, after code or alone', () => {
    assert.deepEqual(comments('deltaT 0.005; // the step\n// alone\nendTime 1;'),
      ['// the step', '// alone', '']);
  });

  test('a block comment spans lines and ends where it closes', () => {
    assert.deepEqual(comments('a /* one\ntwo\nthree */ b;\nc;'), ['/* one', 'two', 'three */', '']);
    const [line] = highlightFoam('x /* c */ y;');
    assert.deepEqual(line.segments, [
      { text: 'x ', comment: false }, { text: '/* c */', comment: true }, { text: ' y;', comment: false },
    ]);
  });

  test('slashes inside a string are not a comment', () => {
    assert.deepEqual(comments('#include "../a//b" // real\npatches "(in|out)/*";'), ['// real', '']);
  });

  test('the OpenFOAM banner is one block comment', () => {
    const banner = '/*--------------------------------*- C++ -*----------------------------------*\\\n  =========                 |\n\\*---------------------------------------------------------------------------*/\nFoamFile';
    assert.deepEqual(highlightFoam(banner).map(l => l.segments.every(s => s.comment)), [true, true, true, false]);
  });

  test('the text is kept exactly, segment by segment', () => {
    const text = 'a { // x\n\tb "q//" /* c\n*/ }\r\n';
    const rebuilt = highlightFoam(text).map(l => l.segments.map(s => s.text).join('')).join('\n');
    assert.equal(rebuilt, text.replace('\r', ''));
  });
});

describe('indent guides', () => {
  test('a guide runs between a brace pair, at the column of the line that opens it', () => {
    const text = [
      'boundaryField', //            0
      '{', //                        1
      '    inlet', //                2
      '    {', //                    3
      '        type fixedValue;', // 4
      '', //                         5
      '    }', //                    6
      '}', //                        7
    ].join('\n');
    assert.deepEqual(highlightFoam(text).map(l => l.guides), [[], [], [0], [0], [0, 4], [0, 4], [0], []]);
  });

  test('a brace on the line of its name, a one-line block and tabs', () => {
    assert.deepEqual(highlightFoam('a {\n  b;\n}').map(l => l.guides), [[], [0], []]);
    assert.deepEqual(highlightFoam('x { type empty; }\ny;').map(l => l.guides), [[], []]);
    assert.deepEqual(highlightFoam('\tblock\n\t{\n\t\tv;\n\t}').map(l => l.guides), [[], [], [4], []]);
  });

  test('braces in comments and strings do not count, and a stray } is ignored', () => {
    assert.deepEqual(highlightFoam('// {\n"{"\n}\n/* { */\na;').map(l => l.guides), [[], [], [], [], []]);
  });
});

test('very large files are not highlighted', () => {
  assert.equal(canHighlight('a\nb'), true);
  assert.equal(canHighlight('\n'.repeat(HIGHLIGHT_MAX_LINES)), false);
});

test('search hits cut the segments of a line, the current one marked apart', async () => {
  const { markSegments } = await import('../src/lib/editor-highlight.ts');
  const [line] = highlightFoam('value 1; // value');
  const marked = markSegments(line.segments, [{ start: 0, end: 5, current: true }, { start: 12, end: 17, current: false }]);
  assert.deepEqual(marked.map(s => [s.text, s.comment, s.number ?? false, s.mark]), [
    ['value', false, false, 2], [' ', false, false, 0], ['1', false, true, 0], ['; ', false, false, 0],
    ['// ', true, false, 0], ['value', true, false, 1],
  ]);
});

describe('numbers', () => {
  const numbers = (text: string) => highlightFoam(text).map(line =>
    line.segments.filter(s => s.number).map(s => s.text));

  test('integers, decimals, exponents and signs standing alone are numbers', () => {
    assert.deepEqual(numbers('deltaT 0.005;\nnu 1e-05;\nvalue uniform (-1 0 2.5E+3);\nn .5;'),
      [['0.005'], ['1e-05'], ['-1', '0', '2.5E+3'], ['.5']]);
  });

  test('digits in names, strings and comments are not', () => {
    assert.deepEqual(numbers('U_0 p2 k:0 div(phi,U) 3;'), [['3']]);
    assert.deepEqual(numbers('#include "file1" // step 2\n/* 3 */ 4;'), [[], ['4']]);
    assert.deepEqual(numbers('a-1;'), [['1']], 'a minus after a name is an operator, the digits still count');
  });

  test('the text is kept exactly with numbers split out', () => {
    const text = 'value nonuniform List<scalar> 3(1 -2e-3 .5); // 4';
    assert.equal(highlightFoam(text)[0].segments.map(s => s.text).join(''), text);
  });
});

test('a block knows the column of its brace, for the fold arrow', async () => {
  const { scanFoam } = await import('../src/lib/editor-highlight.ts');
  assert.deepEqual(scanFoam('inlet\n{\n  a;\n}\n  wall {\n  b;\n  }').blocks.map(b => [b.open, b.openChar]), [[1, 0], [4, 7]]);
});

describe('shell scripts', () => {
  const shellComments = (text: string) => highlightFoam(text, 4, 'shell').map(line =>
    line.segments.filter(s => s.comment).map(s => s.text).join('|'));

  test('Allrun, *.sh and a #! first line are read as shell; dictionaries are not', () => {
    assert.equal(syntaxFor('combustorSimple/Allrun', ''), 'shell');
    assert.equal(syntaxFor('Allclean', ''), 'shell');
    assert.equal(syntaxFor('Allrun.pre', ''), 'shell');
    assert.equal(syntaxFor('scripts/mesh.sh', ''), 'shell');
    assert.equal(syntaxFor('system/run', '#!/bin/bash\necho'), 'shell');
    assert.equal(syntaxFor('system/controlDict', 'FoamFile\n{\n}'), 'foam');
    assert.equal(syntaxFor(null, '/*---*/'), 'foam');
  });

  test('the /* of `cd ${0%/*}` does not open a comment', () => {
    const text = [
      '#!/bin/sh',
      'cd ${0%/*} || exit 1    # run from this directory',
      '',
      '# Source tutorial run functions',
      '. $WM_PROJECT_DIR/bin/tools/RunFunctions',
      "physical_cores=$(lscpu | grep 'Core(s) per socket' | awk '{print $NF}')",
      'nCores=$1;',
      'runApplication blockMesh',
    ].join('\n');
    assert.deepEqual(shellComments(text), [
      '#!/bin/sh', '# run from this directory', '', '# Source tutorial run functions', '', '', '', '',
    ]);
  });

  test('a # inside quotes, after $ or in ${#…} is not a comment', () => {
    assert.deepEqual(shellComments('echo "a # b" \'c # d\' $# ${#x} \\# e # real'), ['# real']);
  });

  test('a shell argument is a variable, not a number', () => {
    const [line] = highlightFoam('nCores=$1; sleep 2', 4, 'shell');
    assert.deepEqual(line.segments.filter(s => s.number).map(s => s.text), ['2']);
  });

  test('the same text read as a dictionary still treats /* as a comment', () => {
    assert.deepEqual(comments('cd ${0%/*}\nx'), ['/*}', 'x']);
  });
});
