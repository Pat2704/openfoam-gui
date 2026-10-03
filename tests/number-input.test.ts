import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumberInput } from '../src/lib/number-input';

test('deleting a value or typing an unfinished sign/exponent never commits zero', () => {
  for (const text of ['', ' ', '-', '+', '.', '-.', '1e', '1e-', '1e+']) {
    assert.equal(parseNumberInput(text), undefined, text);
  }
});

test('replacement coordinates preserve zero, signed decimals and scientific notation', () => {
  assert.equal(parseNumberInput('0'), 0);
  assert.equal(parseNumberInput('-0.125'), -0.125);
  assert.equal(parseNumberInput('.05'), .05);
  assert.equal(parseNumberInput('1.'), 1);
  assert.equal(parseNumberInput('  +2.5E-3  '), .0025);
});

test('invalid or non-finite text cannot become a ParaView property', () => {
  for (const text of ['NaN', 'Infinity', '1e999', '0x10', '2junk', '1,5', '1 2']) {
    assert.equal(parseNumberInput(text), undefined, text);
  }
});

test('bounded counts stay integers and respect both endpoints', () => {
  const limits = { min: 1, max: 2000, integer: true };
  assert.equal(parseNumberInput('1', limits), 1);
  assert.equal(parseNumberInput('2e3', limits), 2000);
  for (const text of ['0', '2001', '2.5', '-1']) assert.equal(parseNumberInput(text, limits), undefined);
  assert.equal(parseNumberInput('0.25', { min: .05, max: 60 }), .25);
});
