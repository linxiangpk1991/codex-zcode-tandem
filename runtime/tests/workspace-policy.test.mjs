import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWorkspace } from '../workspace-policy.mjs';
import { decideToolPermission } from '../policy.mjs';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-scope-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'owned.js'), 'owned');
  writeFileSync(join(cwd, 'src', 'keep.js'), 'controller change');
  const workspace = normalizeWorkspace({ ownedPaths: ['src'], preservedPaths: ['src/keep.js'],
    commands: ['git status --short', 'node --test tests/focused.test.mjs'] }, cwd);
  const request = { cwd, workspace, allowToolKinds: ['read', 'search', 'edit', 'execute'] };
  const decide = (nativeName, rawInput) => decideToolPermission({ request, nativeName, rawInput });
  return { cwd, request, decide };
}

test('edit ownership, preserved files, traversal, unknown paths and Git metadata', () => {
  const { decide } = fixture();
  assert.equal(decide('Write', { file_path: 'src/new.js' }).allowed, true);
  for (const file_path of ['src/keep.js', '../outside.js', '.git/config', 'README.md']) {
    assert.equal(decide('Edit', { file_path }).allowed, false, file_path);
  }
  assert.equal(decide('Write', {}).allowed, false);
  assert.equal(decide('Write', { file_path: 'src/owned.js', path: 'src/keep.js' }).allowed, false);
  assert.equal(decide('MultiEdit', { file_path: 'src/owned.js', edits: [{ path: 'src/keep.js' }] }).allowed, false);
  assert.equal(decide('ApplyPatch', { patch: '*** Update File: src/owned.js\n*** Move to: README.md\n' }).allowed, false);
});

test('directory junction cannot extend ownership outside workspace', () => {
  const { cwd, decide } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'tandem-outside-'));
  symlinkSync(outside, join(cwd, 'src', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(decide('Write', { file_path: 'src/link/secret.js' }).allowed, false);
  assert.throws(() => normalizeWorkspace({ ownedPaths: ['src/link'] }, cwd), /inside cwd/);
});

test('reviewed commands are exact; destructive Git and shell wrappers are not implicitly granted', () => {
  const { request, decide } = fixture();
  for (const command of request.workspace.commands) assert.equal(decide('Bash', { command }).allowed, true);
  for (const command of ['git stash push -m scratch', 'git reset --hard', 'git clean -fd',
    'git worktree remove --force ../baseline', 'git checkout -f HEAD', 'git switch main',
    'bash -c "git stash"', 'git status --short; git stash', 'node --test tests/focused.test.mjs | grep pass; echo done']) {
    assert.equal(decide('Bash', { command }).allowed, false, command);
  }
  request.workspace.commands.push('git stash push');
  assert.equal(decide('Bash', { command: 'git stash push' }).allowed, false);
  assert.equal(decide('Bash', { command: 'git status --short', cwd: '..' }).allowed, false);
});

test('denying stash preserves controller dirty and untracked files in a real temporary repository', () => {
  const { cwd, decide } = fixture();
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  git(['init', '--quiet']);
  git(['add', 'src/owned.js']);
  writeFileSync(join(cwd, 'src', 'owned.js'), 'worker dirty');
  const before = git(['status', '--porcelain=v1']);
  assert.equal(decide('Bash', { command: 'git stash push --include-untracked' }).allowed, false);
  assert.equal(git(['status', '--porcelain=v1']), before);
  assert.equal(decide('Read', { file_path: 'src/keep.js' }).allowed, true);
});

test('category alone no longer grants editing or arbitrary shell access', () => {
  for (const nativeName of ['Write', 'Bash']) {
    assert.equal(decideToolPermission({ request: { allowToolKinds: ['edit', 'execute'] }, nativeName, rawInput: {} }).allowed, false);
  }
});
