/** The File Editor's comment colouring and indent guides (src/lib/editor-highlight.ts). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canHighlight, highlightFoam, HIGHLIGHT_MAX_LINES } from '../src/lib/editor-highlight.ts';

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
  assert.deepEqual(marked.map(s => [s.text, s.comment, s.mark]), [
    ['value', false, 2], [' 1; ', false, 0], ['// ', true, 0], ['value', true, 1],
  ]);
});
