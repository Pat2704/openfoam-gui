/**
 * The rule that ties a running process to a case. The Monitor's RUNNING badge
 * and the File Editor's refusal to delete timesteps mid-run both rest on it.
 *
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isProcessForCase } from '../src/lib/case-processes.ts';

const RUN = '/home/user/OpenFOAM/user-14/run';

describe('isProcessForCase', () => {
  test('the case directory and its processor subdirectories belong to the case', () => {
    assert.equal(isProcessForCase({ cwd: `${RUN}/cavity` }, 'cavity'), true);
    assert.equal(isProcessForCase({ cwd: `${RUN}/cavity/` }, 'cavity'), true);
    assert.equal(isProcessForCase({ cwd: `${RUN}/cavity/processor3` }, 'cavity'), true);
  });

  test('a case whose name only looks alike does not', () => {
    assert.equal(isProcessForCase({ cwd: `${RUN}/cavity_test` }, 'cavity'), false);
    assert.equal(isProcessForCase({ cwd: `${RUN}/mycavity` }, 'cavity'), false);
  });

  test('no working directory, or no case, never counts', () => {
    assert.equal(isProcessForCase({}, 'cavity'), false);
    assert.equal(isProcessForCase({ cwd: `${RUN}/cavity` }, ''), false);
  });
});
