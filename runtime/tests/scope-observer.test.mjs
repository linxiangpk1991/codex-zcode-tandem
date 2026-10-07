import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopeObserver } from '../scope-observer.mjs';

function fixture(command = '', budget = 2000000) {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-observe-'));
  return new ScopeObserver({ cwd, maxOutputBytes: budget, allowToolKinds: ['edit', 'execute'],
    workspace: { ownedPaths: ['owned.txt'], preservedPaths: [], commands: [command] } }, { maxTools: 5 });
}
const tool = (name, status = 'pending') => ({ toolCallId: 'tool-1', title: name, status });
test('large Write content is discarded without losing its scope', () => {
  const o = fixture();
  o.observe(tool('Write'), { file_path: 'owned.txt', content: 'a'.repeat(80000) });
  assert.equal(o.input('tool-1').content, undefined);
  assert.equal(o.observe(tool('Write', 'completed')).allowed, true);
});
test('large reviewed Bash command remains available for omitted permission input and terminal observation', () => {
  const command = `node test.js ${'a'.repeat(40000)}`, o = fixture(command);
  o.observe(tool('Bash'), { command });
  assert.equal(o.input('tool-1').command, command);
  assert.equal(o.observe(tool('Bash', 'completed')).allowed, true);
});
test('large patch keeps every destination header including a preserved/outside move', () => {
  const o = fixture();
  o.observe(tool('ApplyPatch'), { patch: `*** Update File: owned.txt\n${'+line\n'.repeat(10000)}*** Move to: outside.txt\n` });
  assert.equal(o.observe(tool('ApplyPatch', 'completed')).allowed, false);
});
test('retention overflow is unknown, not a false violation', () => {
  const command = 'x'.repeat(500), o = fixture(command, 128);
  o.observe(tool('Bash'), { command });
  assert.equal(o.observe(tool('Bash', 'completed')).allowed, null);
  assert.equal(o.truncated, true);
});
