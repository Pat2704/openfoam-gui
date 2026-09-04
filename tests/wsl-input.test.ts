/**
 * The validators are the security boundary.
 *
 * Everything the UI and the agent send towards `wsl.exe` passes through this
 * module first, and every value that reaches a bash string is either one of
 * these validated tokens or goes through shellQuote(). These tests pin that
 * behaviour down, because a regression here is not a broken feature — it is a
 * path out of the case directory or a command the user did not write.
 *
 * Run with `npm test` (node --test, native type stripping, no dependencies).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WslInputError,
  argumentStaysInside,
  boundedInteger,
  looksLikePath,
  shellQuote,
  validateCaseName,
  validateLogName,
  validatePathWithin,
  validatePid,
  validateRelativePath,
} from '../src/lib/wsl-input.ts';

const rejects = (fn: () => unknown, what: string) =>
  assert.throws(fn, WslInputError, `should have rejected ${what}`);

describe('validateCaseName', () => {
  test('accepts ordinary names', () => {
    for (const name of ['cavity', 'nozzleFlow2D', 'claude_test', 'a', 'case-1', 'v2.3.1']) {
      assert.equal(validateCaseName(name), name);
    }
  });

  test('accepts non-ASCII letters (the run directory is a Linux filesystem)', () => {
    assert.equal(validateCaseName('café'), 'café');
    assert.equal(validateCaseName('模型'), '模型');
  });

  test('rejects anything that is not a single path segment', () => {
    rejects(() => validateCaseName('a/b'), 'a slash');
    rejects(() => validateCaseName('a\\b'), 'a backslash');
    rejects(() => validateCaseName('..'), 'the parent directory');
    rejects(() => validateCaseName('.'), 'the current directory');
    rejects(() => validateCaseName('/abs'), 'an absolute path');
  });

  test('rejects a leading dot, dash or underscore', () => {
    // A leading dash would be read as an option by the commands the name is
    // interpolated into; a leading dot hides the case from every listing.
    rejects(() => validateCaseName('-rf'), 'a leading dash');
    rejects(() => validateCaseName('.hidden'), 'a leading dot');
    rejects(() => validateCaseName('_tmp'), 'a leading underscore');
  });

  test('rejects shell metacharacters and control characters', () => {
    for (const bad of ['$(id)', '`id`', 'a;b', 'a|b', 'a&b', 'a b', 'a\nb', 'a\rb', 'a\0b', "a'b", 'a"b']) {
      rejects(() => validateCaseName(bad), JSON.stringify(bad));
    }
  });

  test('rejects the empty string and non-strings', () => {
    rejects(() => validateCaseName(''), 'the empty string');
    rejects(() => validateCaseName(undefined as unknown as string), 'undefined');
    rejects(() => validateCaseName(null as unknown as string), 'null');
    rejects(() => validateCaseName(42 as unknown as string), 'a number');
  });

  test('caps the length at 128 characters', () => {
    assert.equal(validateCaseName('a'.repeat(128)).length, 128);
    rejects(() => validateCaseName('a'.repeat(129)), 'a 129-character name');
  });
});

describe('validateRelativePath', () => {
  test('accepts ordinary case-relative paths', () => {
    for (const p of ['0/U', 'system/controlDict', 'constant/polyMesh/points', 'Allrun', 'README.txt']) {
      assert.equal(validateRelativePath(p), p);
    }
  });

  test('refuses to leave the case', () => {
    rejects(() => validateRelativePath('../etc/passwd'), 'a parent segment');
    rejects(() => validateRelativePath('a/../../b'), 'a nested parent segment');
    rejects(() => validateRelativePath('..'), 'a bare parent segment');
    rejects(() => validateRelativePath('/etc/passwd'), 'an absolute path');
    rejects(() => validateRelativePath('./x'), 'a leading current-directory segment');
    rejects(() => validateRelativePath('sub/./y'), 'an inner current-directory segment');
  });

  test('rejects empty segments, so a// cannot collapse into something else', () => {
    rejects(() => validateRelativePath('a//b'), 'a doubled slash');
    rejects(() => validateRelativePath('x/'), 'a trailing slash');
    rejects(() => validateRelativePath('/x'), 'a leading slash');
  });

  test('rejects backslashes, NUL and newlines', () => {
    rejects(() => validateRelativePath('a\\b'), 'a backslash');
    rejects(() => validateRelativePath('a\0b'), 'a NUL');
    rejects(() => validateRelativePath('a\nb'), 'a newline');
    rejects(() => validateRelativePath('a\rb'), 'a carriage return');
  });

  test('allows dots that are not a whole segment', () => {
    // "..foo" and "a/..b" are ordinary filenames; only a segment that IS ".."
    // escapes the case.
    assert.equal(validateRelativePath('a/..b'), 'a/..b');
    assert.equal(validateRelativePath('..a/b'), '..a/b');
    assert.equal(validateRelativePath('.hidden'), '.hidden');
  });

  test('caps the length at 1024 characters', () => {
    rejects(() => validateRelativePath('a'.repeat(1025)), 'a 1025-character path');
  });

  test('allowEmpty only permits the empty string, nothing else new', () => {
    assert.equal(validateRelativePath('', 'Dir', true), '');
    rejects(() => validateRelativePath('', 'Dir'), 'the empty string without allowEmpty');
    rejects(() => validateRelativePath('../x', 'Dir', true), 'a parent segment even with allowEmpty');
  });

  test('uses the supplied label in the message, so the user sees which field failed', () => {
    assert.throws(() => validateRelativePath('../x', 'Destination'), /Destination/);
  });
});

describe('validatePathWithin', () => {
  const base = '/opt/openfoam14/tutorials';

  test('accepts a path genuinely inside the base', () => {
    assert.equal(
      validatePathWithin(base, `${base}/incompressibleFluid/cavity`, 'Tutorial'),
      `${base}/incompressibleFluid/cavity`,
    );
  });

  test('normalises the candidate before comparing', () => {
    assert.equal(validatePathWithin(base, `${base}/a/../b`, 'Tutorial'), `${base}/b`);
  });

  test('is not fooled by a sibling sharing the base as a prefix', () => {
    // The classic startsWith() bug: "/opt/openfoam14/tutorials-evil" begins with
    // the base string but is not inside it.
    rejects(() => validatePathWithin(base, `${base}-evil/x`, 'Tutorial'), 'a prefix sibling');
  });

  test('rejects escaping the base with ..', () => {
    rejects(() => validatePathWithin(base, `${base}/../../etc/passwd`, 'Tutorial'), 'an escape');
  });

  test('rejects the base itself, a relative candidate, and control characters', () => {
    rejects(() => validatePathWithin(base, base, 'Tutorial'), 'the base itself');
    rejects(() => validatePathWithin(base, 'relative/path', 'Tutorial'), 'a relative candidate');
    rejects(() => validatePathWithin(base, `${base}/a\0b`, 'Tutorial'), 'a NUL');
  });

  test('tolerates a trailing slash on the base', () => {
    assert.equal(validatePathWithin(`${base}/`, `${base}/a`, 'Tutorial'), `${base}/a`);
  });
});

describe('validateLogName', () => {
  test('accepts the bare "log" and ordinary log names', () => {
    assert.equal(validateLogName('log'), 'log');
    assert.equal(validateLogName('log.blockMesh'), 'log.blockMesh');
  });

  test('rejects traversal and metacharacters', () => {
    for (const bad of ['../log', 'log/../x', '.hidden', '-rf', 'a b', '$(id)', 'a/b']) {
      rejects(() => validateLogName(bad), JSON.stringify(bad));
    }
  });
});

describe('validatePid', () => {
  test('accepts a positive decimal pid', () => {
    assert.equal(validatePid('1'), '1');
    assert.equal(validatePid('123456'), '123456');
  });

  test('rejects zero, negatives, padding and anything non-numeric', () => {
    for (const bad of ['0', '-1', '01', '1.5', '', ' 1', '1 ', '1;kill', 'abc', '1e3']) {
      rejects(() => validatePid(bad), JSON.stringify(bad));
    }
  });
});

describe('boundedInteger', () => {
  test('passes through an in-range value', () => {
    assert.equal(boundedInteger(50, 10, 1, 100), 50);
    assert.equal(boundedInteger('50', 10, 1, 100), 50);
  });

  test('clamps to the range rather than rejecting', () => {
    assert.equal(boundedInteger(1000, 10, 1, 100), 100);
    assert.equal(boundedInteger(-5, 10, 1, 100), 1);
  });

  test('falls back for anything that is not a finite number', () => {
    for (const bad of [NaN, Infinity, -Infinity, 'abc', {}, [], true, false]) {
      assert.equal(boundedInteger(bad, 10, 1, 100), 10, `fallback for ${JSON.stringify(bad)}`);
    }
  });

  test('an absent parameter falls back rather than clamping to the minimum', () => {
    // URLSearchParams.get() answers null for an absent parameter, and Number(null)
    // is 0 — which used to clamp to `min` and return one line of a log where the
    // route's declared default was a hundred.
    assert.equal(boundedInteger(null, 100, 1, 50000), 100);
    assert.equal(boundedInteger(undefined, 100, 1, 50000), 100);
    assert.equal(boundedInteger('', 100, 1, 50000), 100);
    assert.equal(boundedInteger('   ', 100, 1, 50000), 100);
  });

  test('an explicit zero still clamps, because the caller did say zero', () => {
    assert.equal(boundedInteger(0, 100, 1, 50000), 1);
    assert.equal(boundedInteger('0', 100, 1, 50000), 1);
  });

  test('truncates towards zero rather than rounding', () => {
    assert.equal(boundedInteger(7.9, 10, 1, 100), 7);
  });
});

describe('argumentStaysInside', () => {
  // What the agent policy uses to judge a command ARGUMENT. Checking the
  // spelling was not enough in either direction: banning ".." refused
  // `mapFields ../coarse`, which is a sibling case inside the run directory and
  // not an escape at all, while allowing anything without ".." would have let
  // `-case /mnt/c/Users` through.
  const RUN = '/home/u/OpenFOAM/u-14/run';
  const CASE = `${RUN}/cavity`;
  const inside = (t: string) => argumentStaysInside(t, CASE, RUN);

  test('accepts paths under the case', () => {
    for (const t of ['system/fvSolution', '0/U', 'constant/polyMesh', '.', 'system/../0/U']) {
      assert.equal(inside(t), true, t);
    }
  });

  test('accepts a SIBLING case — the two-case utilities depend on it', () => {
    for (const t of ['../coarse', '../pitzDaily', '..', '../coarse/system/fvSchemes']) {
      assert.equal(inside(t), true, t);
    }
  });

  test('accepts an absolute path that genuinely lands inside the run directory', () => {
    assert.equal(inside(`${RUN}/other`), true);
    assert.equal(inside(RUN), true);
  });

  test('refuses anything that leaves the run directory', () => {
    for (const t of [
      '../..', '../../..', '../../etc/passwd', '/mnt/c/Users', '/etc/passwd', '/',
      `${RUN}/../elsewhere`, '../../u-14', '/home/u/OpenFOAM',
    ]) {
      assert.equal(inside(t), false, t);
    }
  });

  test('is not fooled by a sibling directory sharing the run directory as a prefix', () => {
    // The classic startsWith() mistake.
    assert.equal(inside(`${RUN}-evil/x`), false);
    assert.equal(inside(`${RUN}evil`), false);
  });

  test('refuses everything when the directories are not absolute', () => {
    assert.equal(argumentStaysInside('0/U', 'relative/case', RUN), false);
    assert.equal(argumentStaysInside('0/U', CASE, 'relative/run'), false);
  });

  test('tolerates a trailing slash on the run directory', () => {
    assert.equal(argumentStaysInside('../coarse', CASE, `${RUN}/`), true);
    assert.equal(argumentStaysInside('../../etc', CASE, `${RUN}/`), false);
  });
});

describe('looksLikePath', () => {
  test('flags tokens worth resolving and ignores plain flags and values', () => {
    for (const t of ['0/U', '/abs', '..', '.', '../x']) assert.equal(looksLikePath(t), true, t);
    for (const t of ['-parallel', '-latestTime', 'fluid', '-np', '4', 'latestTime', '-consistent']) {
      assert.equal(looksLikePath(t), false, t);
    }
  });
});

describe('shellQuote', () => {
  test('wraps in single quotes so nothing inside is interpreted', () => {
    assert.equal(shellQuote('plain'), "'plain'");
    assert.equal(shellQuote('a b'), "'a b'");
    assert.equal(shellQuote('$(id)'), "'$(id)'");
    assert.equal(shellQuote('`id`'), "'`id`'");
    assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'");
  });

  test('closes and reopens the quote around an embedded single quote', () => {
    // The only character that can end the quoted run, so it is the only one
    // that needs escaping — and this is the POSIX way to do it.
    assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  });

  test('a quoted value survives a round trip through sh', async () => {
    const { execFileSync } = await import('node:child_process');
    // Skip where there is no POSIX shell (this suite must pass on bare Windows).
    let sh = true;
    try { execFileSync('sh', ['-c', 'true'], { windowsHide: true }); } catch { sh = false; }
    if (!sh) return;

    for (const value of ["it's", '$(id)', 'a b', '`id`', 'a;b', 'a|b', '*']) {
      const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf-8', windowsHide: true,
      });
      assert.equal(out, value, `round trip of ${JSON.stringify(value)}`);
    }
  });
});
