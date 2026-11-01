import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePorcelain } from '../src/git.js';

/**
 * The git status parser.
 *
 * `git status --porcelain=v1 --branch` is a documented, stable format, but
 * it has enough corners — renames, a repository with no commits, a detached
 * HEAD — that the corners are worth pinning down.
 */

test('a clean branch reports its name and no changes', () => {
  const status = parsePorcelain('## main...origin/main\n');

  assert.ok(status);
  assert.equal(status.branch, 'main');
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.deepEqual(status.changes, []);
});

test('ahead and behind are read from the header', () => {
  const status = parsePorcelain('## main...origin/main [ahead 3, behind 2]\n');

  assert.ok(status);
  assert.equal(status.ahead, 3);
  assert.equal(status.behind, 2);
});

test('a branch with no upstream has no counts', () => {
  const status = parsePorcelain('## feature/x\n');

  assert.ok(status);
  assert.equal(status.branch, 'feature/x');
  assert.equal(status.ahead, 0);
});

test('a repository with no commits still names its branch', () => {
  const status = parsePorcelain('## No commits yet on master\n');

  assert.ok(status);
  assert.equal(status.branch, 'master');
});

test('changes are reported with their kind', () => {
  const status = parsePorcelain(
    [
      '## main...origin/main',
      ' M src/modified.ts',
      '?? untracked.ts',
      'A  added.ts',
      'D  deleted.ts',
      'R  old.ts -> new.ts',
      'UU conflicted.ts',
      '',
    ].join('\n'),
  );

  assert.ok(status);
  assert.deepEqual(status.changes, [
    { path: 'src/modified.ts', status: 'modified' },
    { path: 'untracked.ts', status: 'untracked' },
    { path: 'added.ts', status: 'added' },
    { path: 'deleted.ts', status: 'deleted' },
    { path: 'new.ts', status: 'renamed' },
    { path: 'conflicted.ts', status: 'conflicted' },
  ]);
});

test('a staged change is reported even when the working tree is clean', () => {
  const status = parsePorcelain('## main\nM  staged-only.ts\n');

  assert.ok(status);
  assert.deepEqual(status.changes, [{ path: 'staged-only.ts', status: 'modified' }]);
});

test('output that is not a repository status is ignored', () => {
  assert.equal(parsePorcelain(''), undefined);
  assert.equal(parsePorcelain('fatal: not a git repository'), undefined);
});
