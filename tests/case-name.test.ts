/**
 * One rule for what a case may be called, applied on both sides.
 *
 * These tests exist because there used to be two rules that disagreed in both
 * directions — the wizard accepted names the server then refused, and refused
 * names the server would have accepted. The point of the module is that the
 * predicate here and `validateCaseName` in src/lib/wsl-input.ts can never drift
 * apart again, so the last test checks exactly that.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_NAME_MAX_LENGTH,
  caseNameProblem,
  isValidCaseName,
} from '../src/lib/case-name.ts';
import { WslInputError, validateCaseName } from '../src/lib/wsl-input.ts';

const ACCEPTED = ['cavity', 'nozzleFlow2D', 'claude_test', 'a', '1', 'case-1', 'v2.3.1', 'café', '模型'];
const REJECTED = [
  '', '.', '..', '.hidden', '-rf', '_tmp', 'a/b', 'a\\b', 'a b', 'a\tb',
  '$(id)', '`id`', 'a;b', 'a|b', "a'b", 'a"b', 'a\nb', 'a\0b', 'a'.repeat(129),
];

describe('isValidCaseName', () => {
  test('accepts ordinary and non-ASCII names', () => {
    for (const n of ACCEPTED) assert.equal(isValidCaseName(n), true, `should accept ${JSON.stringify(n)}`);
  });

  test('rejects traversal, separators, metacharacters and bad first characters', () => {
    for (const n of REJECTED) assert.equal(isValidCaseName(n), false, `should reject ${JSON.stringify(n)}`);
  });

  test('rejects non-strings rather than coercing them', () => {
    for (const v of [null, undefined, 42, {}, []]) assert.equal(isValidCaseName(v), false);
  });

  test('the length limit is inclusive', () => {
    assert.equal(isValidCaseName('a'.repeat(CASE_NAME_MAX_LENGTH)), true);
    assert.equal(isValidCaseName('a'.repeat(CASE_NAME_MAX_LENGTH + 1)), false);
  });
});

describe('caseNameProblem', () => {
  test('says nothing about a good name', () => {
    for (const n of ACCEPTED) assert.equal(caseNameProblem(n), null, n);
  });

  test('names the rule that was broken, rather than one catch-all sentence', () => {
    // Five different mistakes used to produce the same message.
    assert.match(caseNameProblem('')!, /no name/i);
    assert.match(caseNameProblem('a b')!, /space/i);
    assert.match(caseNameProblem('a/b')!, /slash/i);
    assert.match(caseNameProblem('.hidden')!, /start with a letter or a number/i);
    assert.match(caseNameProblem('-rf')!, /start with a letter or a number/i);
    assert.match(caseNameProblem('a'.repeat(200))!, /limit is 128/);
    assert.match(caseNameProblem('a$b')!, /letters, numbers, dot, dash and underscore/i);
  });

  test('every problem message is a complete sentence for a person to read', () => {
    for (const n of REJECTED) {
      const message = caseNameProblem(n);
      assert.ok(message, `expected a problem for ${JSON.stringify(n)}`);
      assert.ok(message!.length > 10 && message!.endsWith('.'), `unhelpful message: ${message}`);
    }
  });
});

describe('the wizard and the server agree', () => {
  // The whole reason src/lib/case-name.ts exists. If these two ever diverge
  // again, the wizard will approve a name that creation then refuses — which is
  // what happened with ".hidden", "-rf", "_tmp", "café" and long names.
  test('isValidCaseName accepts exactly what validateCaseName accepts', () => {
    const probes = [
      ...ACCEPTED, ...REJECTED,
      'a'.repeat(CASE_NAME_MAX_LENGTH), 'a'.repeat(CASE_NAME_MAX_LENGTH + 1),
      'Ünïcode', '0start', 'dot.in.middle', 'dash-in-middle', 'under_score',
      'trailing.', 'trailing-', 'trailing_',
    ];
    for (const name of probes) {
      let serverAccepts = true;
      try { validateCaseName(name); } catch (e) {
        assert.ok(e instanceof WslInputError, `unexpected error type for ${JSON.stringify(name)}`);
        serverAccepts = false;
      }
      assert.equal(
        isValidCaseName(name), serverAccepts,
        `client and server disagree about ${JSON.stringify(name)}: ` +
        `client says ${isValidCaseName(name)}, server says ${serverAccepts}`,
      );
    }
  });

  test('a name the client reports a problem for is one the server refuses', () => {
    for (const name of REJECTED) {
      assert.ok(caseNameProblem(name), `client accepted ${JSON.stringify(name)}`);
      assert.throws(() => validateCaseName(name), WslInputError, `server accepted ${JSON.stringify(name)}`);
    }
  });
});
