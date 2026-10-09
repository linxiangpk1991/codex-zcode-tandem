import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../config.mjs';
import { normalizeRequest } from '../request.mjs';
import { captureReview, assessDelivery, observedCandidateInspection, REVIEW_LABEL } from '../delivery.mjs';
import { prepareCheck, assessVerification } from '../verification.mjs';

function fixture(t, delivery = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-delivery-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'source.mjs'), 'export const value = 1;');
  const raw = { cwd, prompt: 'implement', allowToolKinds: ['read', 'edit'],
    workspace: { ownedPaths: ['source.mjs'] }, delivery: { candidateFiles: ['source.mjs'], ...delivery } };
  const request = normalizeRequest(buildConfig({}, {}), raw);
  const text = '```tandem-review\n' + JSON.stringify({ reviewedFiles: ['source.mjs'],
    fixedIssues: [], openIssues: [], summary: 'Read actual final source and checked behavior.' }) + '\n```';
  const review = captureReview(request, { stopReason: 'end_turn', text }, true);
  return { cwd, raw, request, text, review, report: { status: 'completed', cwd,
    firstPassReview: review, verification: { outcome: 'not_run', checks: [] } } };
}

test('editing tasks receive mandatory final review, including resumed sessions', t => {
  const f = fixture(t);
  for (const sessionId of [undefined, 'old-session']) {
    const raw = { ...f.raw, sessionId }; delete raw.delivery;
    const r = normalizeRequest(buildConfig({}, {}), raw);
    assert.equal(r.prompts.at(-1).label, REVIEW_LABEL);
    assert.equal(r.delivery.validation, 'required');
  }
  assert.throws(() => normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: false }), /cannot disable/);
  assert.throws(() => normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: { candidateFiles: ['../secret'] } }), /inside cwd/);
  assert.throws(() => normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: { candidateFiles: ['.'] } }), /inside cwd/);
  assert.throws(() => normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: { validation: 'not_applicable' } }), /reason/);
  assert.throws(() => normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: { validation: 'not_applicable', validationReason: 'skip', userPaths: ['save'] } }), /cannot skip/);
  const readOnly = normalizeRequest(buildConfig({}, {}), { cwd: f.cwd, prompt: 'inspect', allowToolKinds: ['read'] });
  assert.equal(readOnly.delivery, null); assert.equal(readOnly.prompts.length, 1);
  const scopedReadOnly = normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: undefined, allowToolKinds: ['read'] });
  assert.equal(scopedReadOnly.delivery, null);
  const workflow = normalizeRequest(buildConfig({}, {}), { ...f.raw, delivery: undefined,
    allowToolKinds: ['read'], waitForBackground: true });
  assert.equal(workflow.prompts.at(-1).label, REVIEW_LABEL);
});

test('reading receipts alone cannot stand in for inspecting the candidate', t => {
  const f = fixture(t);
  const tool = { title: 'Read', status: 'completed', rawInput: { file_path: join(f.cwd, 'receipt.json') } };
  assert.equal(observedCandidateInspection(f.request, [tool]), false);
  tool.rawInput.file_path = join(f.cwd, 'source.mjs');
  assert.equal(observedCandidateInspection(f.request, [tool]), true);
  tool.status = 'failed'; assert.equal(observedCandidateInspection(f.request, [tool]), false);
  assert.equal(observedCandidateInspection(f.request, [{ title: 'Bash', status: 'completed', rawInput: { command: 'echo reviewed' } }]), false);
});

test('completed without real review or validation never becomes handoff-ready', t => {
  const f = fixture(t);
  assert.equal(assessDelivery(f.request, { ...f.report, firstPassReview: null }).status, 'needs_review');
  assert.equal(captureReview(f.request, { stopReason: 'end_turn', text: f.text }, false).outcome, 'incomplete');
  assert.equal(captureReview(f.request, { stopReason: 'cancelled', text: f.text }, true).outcome, 'incomplete');
  assert.equal(captureReview(f.request, { stopReason: 'end_turn', text: 'All passed' }, true).outcome, 'incomplete');
  assert.equal(assessDelivery(f.request, f.report).status, 'awaiting_validation');
  f.report.firstPassReview.declaration.openIssues.push('save request lacks version field');
  assert.equal(assessDelivery(f.request, f.report).status, 'changes_requested');
});

test('pause, late steering and candidate changes invalidate reviewed status', t => {
  const f = fixture(t, { validation: 'not_applicable', validationReason: 'documentation-only' });
  assert.equal(assessDelivery(f.request, f.report).status, 'ready_for_controller_review');
  assert.equal(assessDelivery(f.request, { ...f.report, status: 'paused' }).status, 'needs_review');
  f.review.invalidated = true;
  assert.equal(assessDelivery(f.request, f.report).status, 'needs_review');
  delete f.review.invalidated;
  writeFileSync(join(f.cwd, 'source.mjs'), 'export const value = 2;');
  assert.match(assessDelivery(f.request, f.report).reasons.join(), /changed after review/);
});

test('controller-run checks close only matching functional paths; stale and failing checks remain blocked', t => {
  const f = fixture(t, { userPaths: ['edit-save-refresh'] });
  const preparedFile = join(f.cwd, 'prepared.json'), receiptFile = join(f.cwd, 'receipt.json');
  const command = [process.execPath, '--check', 'source.mjs'];
  const prepared = prepareCheck({ name: 'functional fixture', cwd: f.cwd, command,
    candidateFiles: ['source.mjs'], userPaths: ['edit-save-refresh'] });
  const save = (file, data) => writeFileSync(file, JSON.stringify(data));
  save(preparedFile, prepared);
  const receipt = { kind: 'tandem-command-receipt', version: 1, cwd: f.cwd, command,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    exitCode: 0, outcome: 'pass', outputTruncated: false };
  const checks = [{ preparedFile, receiptFile }];
  f.report.deliveryContract = { cwd: f.cwd, delivery: f.request.delivery, verification: checks };
  f.report.verification = assessVerification(checks);
  assert.equal(assessDelivery(f.request, f.report).status, 'awaiting_validation');
  save(receiptFile, receipt); f.report.verification = assessVerification(checks);
  assert.equal(assessDelivery(f.request, f.report).status, 'ready_for_controller_review');
  assert.equal(assessDelivery(f.request, f.report).visualReview, 'pending_controller');
  const resultFile = join(f.cwd, 'result.json'); save(resultFile, f.report);
  const cli = new URL('../../scripts/check-evidence.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [fileURLToPath(cli), 'handoff', resultFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(run().status, 0);
  save(receiptFile, { ...receipt, exitCode: 1, outcome: 'fail' });
  assert.equal(run().status, 4);
  save(receiptFile, receipt); save(preparedFile, { ...prepared, userPaths: [] });
  assert.equal(run().status, 4);
  save(preparedFile, prepared); writeFileSync(join(f.cwd, 'source.mjs'), 'changed');
  assert.equal(run().status, 4);
});

test('workflow handoff uses bound successors and the same completion semantics as execution', t => {
  const f = fixture(t, { validation: 'not_applicable', validationReason: 'text-only workflow' });
  const report = { ...f.report, workflowRunIds: ['new'], backgroundTasks: [],
    workflow: { notificationState: 'completed', runs: { old: 'stopped', new: 'completed:resumable' } } };
  assert.equal(assessDelivery(f.request, report).status, 'ready_for_controller_review');
  report.workflow.runs.new = 'running';
  report.backgroundTasks = [{ status: 'completed' }];
  assert.equal(assessDelivery(f.request, report).status, 'ready_for_controller_review');
  report.backgroundTasks[0].status = 'running';
  assert.equal(assessDelivery(f.request, report).status, 'needs_review');
  report.backgroundTasks[0].status = 'failed';
  assert.equal(assessDelivery(f.request, report).status, 'needs_review');
  report.backgroundTasks = []; report.workflow.runs.new = 'completed'; report.workflow.notificationState = null;
  assert.equal(assessDelivery(f.request, report).status, 'needs_review');
});
