/** Folding and find/replace in the File Editor (src/lib/editor-folding.ts, editor-search.ts). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanFoam } from '../src/lib/editor-highlight.ts';
import {
  applyVisibleEdit, foldRegions, foldsHiding, fullToVisible, project, shiftFolds, visibleToFull,
} from '../src/lib/editor-folding.ts';
import { findMatches, replaceAll, replaceMatch } from '../src/lib/editor-search.ts';

const FILE = [
  'FoamFile', //                 0
  '{', //                        1
  '    format ascii;', //        2
  '}', //                        3
  'boundaryField', //            4
  '{', //                        5
  '    inlet', //                6
  '    {', //                    7
  '        type fixedValue;', // 8
  '        value uniform 1;', // 9
  '    }', //                    10
  '    wall { type noSlip; }', // 11
  '}', //                        12
].join('\n');

const regionsOf = (text: string) => foldRegions(text, scanFoam(text).blocks);

describe('fold regions', () => {
  test('every block with lines inside, its toggle on the line that names it', () => {
    assert.deepEqual(regionsOf(FILE).map(r => [r.open, r.close, r.toggle]), [[1, 3, 0], [5, 12, 4], [7, 10, 6]]);
  });

  test('a brace on its name line toggles there; a block after a statement keeps its own line', () => {
    assert.deepEqual(regionsOf('a {\n  b;\n}').map(r => r.toggle), [0]);
    assert.deepEqual(regionsOf('x 1;\n{\n  b;\n}').map(r => r.toggle), [1]);
  });
});

describe('projection', () => {
  const regions = regionsOf(FILE);

  test('nothing folded is the file itself', () => {
    const p = project(FILE, regions, new Set());
    assert.equal(p.visible, FILE);
  });

  test('a fold hides the lines between its braces, and nested folds go with it', () => {
    const p = project(FILE, regions, new Set([5, 7]));
    assert.deepEqual(p.lineMap, [0, 1, 2, 3, 4, 5, 12]);
    assert.equal(p.hiddenAfter.get(5), 6);
    assert.equal(p.visible.split('\n').at(-1), '}');
  });

  test('offsets convert both ways; a hidden position goes to the end of the line above', () => {
    const p = project(FILE, regions, new Set([5]));
    const closing = FILE.lastIndexOf('}');
    assert.equal(visibleToFull(p, p.visible.lastIndexOf('}')), closing);
    assert.equal(fullToVisible(p, closing), p.visible.lastIndexOf('}'));
    const hidden = FILE.indexOf('fixedValue');
    const braceLineEnd = p.visible.lastIndexOf('}') - 1;
    assert.equal(fullToVisible(p, hidden), braceLineEnd);
  });
});

describe('editing a projection', () => {
  const regions = regionsOf(FILE);
  const folded = new Set([5]);

  test('typing above or after a fold changes the file in the same place', () => {
    const p = project(FILE, regions, folded);
    const typed = p.visible.replace('boundaryField', 'boundaryFields');
    const edit = applyVisibleEdit(FILE, p, typed);
    assert.equal(edit.text, FILE.replace('boundaryField', 'boundaryFields'));
    const after = applyVisibleEdit(FILE, p, `${p.visible}\n// end`);
    assert.equal(after.text, `${FILE}\n// end`);
  });

  test('typing right after a folded { goes after the brace, not after the hidden lines', () => {
    const p = project(FILE, regions, folded);
    const at = p.visible.indexOf('{', p.visible.indexOf('boundaryField')) + 1;
    const edit = applyVisibleEdit(FILE, p, p.visible.slice(0, at) + ' // x' + p.visible.slice(at));
    assert.ok(edit.text.includes('boundaryField\n{ // x\n    inlet'));
  });

  test('Backspace at the start of the } line keeps the hidden content', () => {
    const p = project(FILE, regions, folded);
    const at = p.visible.lastIndexOf('\n');
    const edit = applyVisibleEdit(FILE, p, p.visible.slice(0, at) + p.visible.slice(at + 1));
    assert.ok(edit.text.includes('type fixedValue;'));
    assert.ok(edit.text.endsWith('wall { type noSlip; }}'));
    assert.equal(edit.reveal, 5, 'the joined block is shown');
  });

  test('deleting a selection that covers a folded block deletes the block', () => {
    const p = project(FILE, regions, folded);
    const from = p.visible.indexOf('boundaryField');
    const edit = applyVisibleEdit(FILE, p, p.visible.slice(0, from));
    assert.equal(edit.text, FILE.slice(0, FILE.indexOf('boundaryField')));
  });

  test('folds below an edit move with the lines it added, and broken ones are dropped', () => {
    const grown = `// one\n// two\n${FILE}`;
    const moved = shiftFolds(new Set([5, 7]), 0, 2, regionsOf(grown));
    assert.deepEqual([...moved].sort((a, b) => a - b), [7, 9]);
    assert.deepEqual([...shiftFolds(new Set([5]), 0, 0, regionsOf('a;'))], []);
  });

  test('the folds hiding a line, for revealing a search hit', () => {
    assert.deepEqual(foldsHiding(8, regions, new Set([5, 7])), [5, 7]);
    assert.deepEqual(foldsHiding(4, regions, new Set([5, 7])), []);
  });
});

describe('find and replace', () => {
  const plain = { caseSensitive: false, wholeWord: false, regex: false };

  test('case, whole word and regex', () => {
    const text = 'U u Ux U_0 U';
    assert.equal(findMatches(text, 'u', plain).matches.length, 5);
    assert.equal(findMatches(text, 'U', { ...plain, caseSensitive: true }).matches.length, 4);
    assert.equal(findMatches(text, 'U', { ...plain, caseSensitive: true, wholeWord: true }).matches.length, 2);
    assert.deepEqual(findMatches('a1 b22', '\\d+', { ...plain, regex: true }).matches, [{ start: 1, end: 2 }, { start: 4, end: 6 }]);
    assert.ok(findMatches('x', '(', { ...plain, regex: true }).error);
    assert.equal(findMatches('abc', 'x*', { ...plain, regex: true }).matches.length, 0, 'empty matches are skipped');
  });

  test('a plain replacement is literal: $& and $1 are inserted as typed', () => {
    assert.equal(replaceAll('a.b a.b', 'a.b', '$&$1', plain).text, '$&$1 $&$1');
    assert.equal(replaceAll('a.b axb', 'a.b', 'X', plain).text, 'X axb', 'the dot is not a wildcard');
  });

  test('a regex replacement expands groups, in the context of the whole text', () => {
    const regex = { ...plain, regex: true };
    assert.equal(replaceAll('nu 1e-05; nu 2e-05;', 'nu (\\S+);', 'nu [$1];', regex).text, 'nu [1e-05]; nu [2e-05];');
    const text = 'p 1;\np 2;';
    const [, second] = findMatches(text, '^p', regex).matches;
    assert.equal(replaceMatch(text, second, '^p', 'q', regex), 'p 1;\nq 2;');
  });
});

test('after any single keystroke the projection is exactly what was typed', () => {
  // The textarea is controlled: if the recomputed projection differed from
  // the text in it, React would rewrite it and the caret would jump.
  const regions = regionsOf(FILE);
  for (const folds of [[5], [7], [1, 5], [5, 7]]) {
    const folded = new Set(folds);
    const p = project(FILE, regions, folded);
    for (let at = 0; at <= p.visible.length; at++) {
      // Each edit with the caret where it leaves it, as the textarea reports.
      const edits: [string, number][] = [
        [p.visible.slice(0, at) + 'x' + p.visible.slice(at), at + 1],
        [p.visible.slice(0, at) + '\n' + p.visible.slice(at), at + 1],
      ];
      if (at > 0) edits.push([p.visible.slice(0, at - 1) + p.visible.slice(at), at - 1]);
      for (const [typed, caret] of edits) {
        const edit = applyVisibleEdit(FILE, p, typed, caret);
        const nextRegions = regionsOf(edit.text);
        const nextFolds = shiftFolds(folded, edit.fromLine, edit.lineDelta, nextRegions, regions);
        if (edit.reveal !== undefined) nextFolds.delete(edit.reveal);
        // Only when the edit left every fold intact must the text be identical;
        // a broken fold reopens on purpose.
        if (nextFolds.size !== folded.size) continue;
        assert.equal(project(edit.text, nextRegions, nextFolds).visible, typed, `folds ${folds} at ${at}: ${JSON.stringify(typed.slice(Math.max(0, at - 5), at + 5))}`);
      }
    }
  }
});

test('Enter at the end of a folded { line opens the fold, so the new line is seen', () => {
  const regions = regionsOf(FILE);
  const p = project(FILE, regions, new Set([5]));
  const at = p.visible.lastIndexOf('{') + 1;
  const edit = applyVisibleEdit(FILE, p, p.visible.slice(0, at) + '\n' + p.visible.slice(at), at + 1);
  assert.equal(edit.reveal, 5);
  assert.ok(edit.text.includes('boundaryField\n{\n\n    inlet'));
});
