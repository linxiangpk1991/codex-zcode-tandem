import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig } from '../config.mjs';
import { normalizeRequest } from '../request.mjs';
import { prepareCheck, assessVerification } from '../verification.mjs';
import { runQualityLoop, independentReviewRequest } from '../quality-loop.mjs';
import { observedCandidateInspection, assessDelivery } from '../delivery.mjs';

function fixture(t, { broken = true, execute = true, reviewFinds = true, fix = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-quality-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
  const config = buildConfig({}, {});
  const source = join(cwd, 'source.mjs');
  writeFileSync(source, `export const value = ${broken ? 0 : 1};`);
  writeFileSync(join(cwd, 'check.mjs'), "import { value } from './source.mjs'; if (value !== 1) process.exit(7);");
  const preparedFile = join(cwd, 'prepared.json'), receiptFile = join(cwd, 'receipt.json');
  writeFileSync(preparedFile, JSON.stringify(prepareCheck({ name: 'value', cwd,
    command: [process.execPath, 'check.mjs'], candidateFiles: ['source.mjs', 'check.mjs'], userPaths: ['value'] })));
  const request = normalizeRequest(config, { cwd, prompt: 'value must equal 1', allowToolKinds: ['read', 'edit'],
    workspace: { ownedPaths: ['source.mjs'] }, delivery: { candidateFiles: ['source.mjs'], userPaths: ['value'], visualReview: 'not_required' },
    verification: [{ preparedFile, receiptFile, execute }] });
  const st = { sessionId: 'developer', steeringRequirements: [] }, report = { status: 'completed' };
  const tracker = { state: { phase: { index: 0 } }, write() {}, setPhase() {}, touch() {} };
  const developerTurns = [], reviewRequests = [];
  const runTask = async ({ request: child }) => {
    reviewRequests.push(child);
    const openIssues = reviewFinds && readFileSync(source, 'utf8').includes('= 0') ? ['source.mjs: value is 0, required 1'] : [];
    return { exitCode: 0, report: { status: 'completed', sessionId: `review-${reviewRequests.length}`, stopReason: 'end_turn',
      response: '```tandem-review\n' + JSON.stringify({ reviewedFiles: ['source.mjs'], fixedIssues: [], openIssues, summary: 'Inspected source.' }) + '\n```',
      tools: [{ title: 'Read', status: 'completed', rawInput: { file_path: source } }], evidence: {}, metrics: {} } };
  };
  const run = () => runQualityLoop({ request, config, report, st, tracker, directory: cwd,
    deadlineAt: Date.now() + 15000, runTask, deps: {}, terminal: () => !!st.pausing,
    writeResultEarly() {}, recordTurn() {}, runPromptTurn: async turn => {
      developerTurns.push(turn); if (fix && turn.phase === 'repair') writeFileSync(source, 'export const value = 1;');
      return { stopReason: 'end_turn', text: 'done' };
    } });
  return { cwd, request, config, st, report, developerTurns, reviewRequests, run, preparedFile, receiptFile };
}

test('default development gate uses fresh read-only review, repairs in original session, verifies and reviews again', async t => {
  const f = fixture(t); await f.run();
  assert.equal(f.report.qualityLoop.status, 'passed');
  assert.equal(f.report.qualityLoop.repairs, 1);
  assert.equal(f.reviewRequests.length, 2);
  assert.equal(f.developerTurns.length, 1);
  assert.equal(f.developerTurns[0].phase, 'repair');
  assert.equal(assessVerification(f.request.verification).outcome, 'pass');
  assert.equal(assessDelivery(f.request, f.report).status, 'ready_for_controller_review');
  for (const r of f.reviewRequests) {
    assert.equal(r.sessionId, undefined); assert.equal(r.delivery, null); assert.equal(r.nativeWorkflow, false);
    assert.deepEqual(r.allowToolKinds, ['read', 'search']);
    assert.deepEqual(r.nativeToolAllowlist, ['Read', 'Glob', 'Grep']);
    assert.ok(r.disallowedTools.includes('Bash')); assert.ok(r.disallowedTools.includes('Edit'));
  }
});

test('a real failing check triggers repair even when the reviewer misses the bug', async t => {
  const f = fixture(t, { reviewFinds: false }); await f.run();
  assert.equal(f.report.qualityLoop.repairs, 1);
  assert.equal(f.report.qualityLoop.checks[0].exitCode, 7);
  assert.equal(f.report.qualityLoop.checks.at(-1).exitCode, 0);
  assert.equal(f.report.qualityLoop.status, 'passed');
});

test('unresolved findings stop after two repairs and cannot produce ready handoff', async t => {
  const f = fixture(t, { fix: false }); await f.run();
  assert.equal(f.report.qualityLoop.repairs, 2); assert.equal(f.reviewRequests.length, 3);
  assert.equal(f.report.qualityLoop.status, 'blocked_repair_limit');
  assert.equal(assessDelivery(f.request, f.report).status, 'changes_requested');
});

test('without an execution grant missing receipts stay blocked, not fabricated', async t => {
  const f = fixture(t, { broken: false, execute: false }); await f.run();
  assert.equal(f.report.qualityLoop.status, 'blocked_validation');
  assert.equal(existsSync(f.receiptFile), false);
  assert.equal(f.developerTurns[0].phase, 'validation');
  assert.equal(assessDelivery(f.request, f.report).status, 'awaiting_validation');
});

test('editing a prepared command after dispatch cannot change the executable check', async t => {
  const f = fixture(t, { broken: false });
  const tampered = JSON.parse(readFileSync(f.preparedFile));
  tampered.command = [process.execPath, '-e', 'process.exit(91)'];
  writeFileSync(f.preparedFile, JSON.stringify(tampered));
  await f.run();
  const receipt = JSON.parse(readFileSync(f.receiptFile));
  assert.deepEqual(receipt.command, [process.execPath, 'check.mjs']);
  assert.equal(receipt.exitCode, 0);
});

test('every declared file must have review read evidence; a model declaration is insufficient', t => {
  const f = fixture(t);
  const request = { ...f.request, delivery: { ...f.request.delivery, candidateFiles: ['source.mjs', 'check.mjs'] } };
  assert.equal(observedCandidateInspection(request, [{ title: 'Read', status: 'completed', rawInput: { path: 'source.mjs' } }]), false);
  assert.equal(observedCandidateInspection(request, ['source.mjs', 'check.mjs'].map(path => ({ title: 'Read', status: 'completed', rawInput: { path } }))), true);
  const child = independentReviewRequest(f.request, f.config, f.cwd, 1, 100, 'original requirements');
  assert.equal(child.prompts.length, 1); assert.equal(child.checkExecutions.length, 0);
});
