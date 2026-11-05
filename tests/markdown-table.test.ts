/** Tables in agent answers (src/lib/markdown-table.ts). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readMarkdownTable, splitTableRow } from '../src/lib/markdown-table.ts';

describe('readMarkdownTable', () => {
  test('reads header, alignment and rows, and where the table ends', () => {
    const lines = [
      'Intro',
      '| Campo | Min … max | Media |',
      '|:---|:---:|---:|',
      '| Ux | 0 … 1 | 0.5 |',
      '| p | −1 … 2 | `0` |',
      '',
      'after',
    ];
    assert.equal(readMarkdownTable(lines, 0), null);
    const table = readMarkdownTable(lines, 1)!;
    assert.deepEqual(table.header, ['Campo', 'Min … max', 'Media']);
    assert.deepEqual(table.align, ['left', 'center', 'right']);
    assert.deepEqual(table.rows, [['Ux', '0 … 1', '0.5'], ['p', '−1 … 2', '`0`']]);
    assert.equal(table.end, 5);
  });

  test('an escaped pipe stays inside its cell', () => {
    assert.deepEqual(splitTableRow('| \\|U\\| | 0.25 |'), ['|U|', '0.25']);
    const table = readMarkdownTable(['| a | b |', '|---|---|', '| \\|U\\| | 1 |'], 0)!;
    assert.deepEqual(table.rows, [['|U|', '1']]);
  });

  test('rows are made as wide as the header', () => {
    const table = readMarkdownTable(['a | b | c', '---|---|---', '1 | 2', '1 | 2 | 3 | 4'], 0)!;
    assert.deepEqual(table.rows, [['1', '2', ''], ['1', '2', '3']]);
    assert.deepEqual(table.align, [null, null, null]);
  });

  test('a pipe in prose, or a separator of the wrong width, is not a table', () => {
    assert.equal(readMarkdownTable(['use a | b here', 'and then more text'], 0), null);
    assert.equal(readMarkdownTable(['| a | b |', '|---|'], 0), null);
    assert.equal(readMarkdownTable(['| a | b |'], 0), null);
    assert.equal(readMarkdownTable(['| a | b |', '| x | y |'], 0), null);
  });
});
