import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCheck, assessCheck, assessVerification, argvHash } from '../verification.mjs';

function fixture(exit = 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-check-'));
  writeFileSync(join(cwd, 'test.mjs'), `process.exit(${exit});`);
  const command = [process.execPath, 'test.mjs'];
  const prepared = prepareCheck({ name: 'focused', cwd, command, candidateFiles: ['test.mjs'] });
  const preparedFile = join(cwd, 'prepared.json'), receiptFile = join(cwd, 'receipt.json');
  writeFileSync(preparedFile, JSON.stringify(prepared));
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), { cwd, windowsHide: true });
  const receipt = { kind: 'tandem-command-receipt', version: 1, cwd, command, startedAt,
    finishedAt: new Date().toISOString(), exitCode: result.status, outcome: result.status === 0 ? 'pass' : 'fail', outputTruncated: false };
  const save = () => writeFileSync(receiptFile, JSON.stringify(receipt));
  save();
  return { cwd, prepared, receipt, save, item: { preparedFile, receiptFile } };
}

test('real passing and failing exit codes survive receipt import', () => {
  assert.equal(assessCheck(fixture().item).outcome, 'pass');
  const failed = assessCheck({ ...fixture(7).item, failureClass: 'known_baseline' });
  assert.equal(failed.outcome, 'fail');
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.failureClass, 'known_baseline');
});
test('truncation and changed source prevent a green handoff', () => {
  const f = fixture();
  f.receipt.outputTruncated = true; f.save();
  assert.equal(assessCheck(f.item).outcome, 'incomplete');
  writeFileSync(join(f.cwd, 'test.mjs'), 'changed');
  assert.equal(assessCheck(f.item).outcome, 'stale');
});
test('masked pipeline and different command cannot substitute for prepared test', () => {
  const f = fixture(4);
  f.receipt.command = ['bash', '-c', 'node test.mjs | grep ok; echo pipe_done'];
  f.receipt.exitCode = 0; f.receipt.outcome = 'pass'; f.save();
  assert.equal(assessCheck(f.item).outcome, 'invalid');
  assert.throws(() => prepareCheck({ name: 'bad', cwd: f.cwd, command: f.receipt.command, candidateFiles: ['test.mjs'] }), /actual test runner/);
});
test('no receipt, no checks, and stale timestamps are not passes', () => {
  const f = fixture();
  assert.equal(assessCheck({ ...f.item, receiptFile: join(f.cwd, 'absent.json') }).outcome, 'not_run');
  assert.equal(assessVerification().outcome, 'not_run');
  f.receipt.startedAt = '2000-01-01T00:00:00Z'; f.save();
  assert.equal(assessCheck(f.item).outcome, 'invalid');
});
test('maintained bounded runner schema imports without depending on its installation', () => {
  const f = fixture();
  writeFileSync(f.item.receiptFile, JSON.stringify({ kind: 'codex-bounded-command', schema_version: 2,
    working_directory: f.cwd, command: { requested_argv_sha256: argvHash(f.prepared.command) },
    started_at_utc: f.receipt.startedAt, finished_at_utc: f.receipt.finishedAt,
    process_exit_code: 0, runner_exit_code: 2, outcome: 'output_contract_failed', output_limited: false }));
  assert.equal(assessCheck(f.item).outcome, 'fail');
});

test('missing completeness flag is unknown evidence, not a passing receipt', () => {
  const f = fixture();
  delete f.receipt.outputTruncated; f.save();
  assert.equal(assessCheck(f.item).outcome, 'invalid');
});
