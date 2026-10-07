import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, readJsonFile } from '../jsonio.mjs';
import { ClientInbox, validateCommand, validateControlPayload } from '../inbox.mjs';
import { buildControlCommand, compactStatus, validateControlContext, isProcessAlive, validateRuntimeOwner } from '../control.mjs';

const CONTROL = join(import.meta.dirname, '..', 'control.mjs');

function tempInbox() {
  return mkdtempSync(join(tmpdir(), 'zcode-v3-inbox-test-'));
}

const now = Date.now();
const invocationId = 'inv-1234';
function command(overrides = {}) {
  return {
    id: 'cmd-000001-abc',
    invocationId,
    action: 'steer',
    payload: { message: 'hello' },
    createdAt: new Date(now - 1000).toISOString(),
    source: { progressUpdatedAt: new Date(now - 1000).toISOString() },
    ...overrides,
  };
}

test('payload validation enforces exact keys and bounds', () => {
  assert.equal(validateControlPayload('steer', { message: 'x' }).ok, true);
  assert.equal(validateControlPayload('steer', {}).ok, false);
  assert.equal(validateControlPayload('answer', { interactionId: 'a', optionId: 'b' }).ok, true);
  assert.equal(validateControlPayload('answer', { interactionId: 'a' }).ok, false);
  assert.equal(validateControlPayload('pause', {}).ok, true);
  assert.equal(validateControlPayload('pause', { stopWorkflow: 'yes' }).ok, false);
  assert.equal(validateControlPayload('workflow-settings', { runId: 'r', maxConcurrency: 2 }).ok, true);
  assert.equal(validateControlPayload('workflow-settings', { runId: 'r', maxConcurrency: 5 }).ok, false);
  assert.equal(validateControlPayload('workflow-settings', { runId: 'r', maxConcurrency: 0 }).ok, false);
  assert.equal(validateControlPayload('workflow-settings', { runId: 'r', subagentModel: 'GLM-5.3' }).ok, false);
  assert.equal(validateControlPayload('workflow-status', { extra: 1 }).ok, false);
  assert.equal(validateControlPayload('detonate', {}).ok, false);
});

test('command validation: duplicate, foreign, malformed, stale, future', () => {
  const seen = new Set(['cmd-000001-abc']);
  assert.equal(validateCommand(command(), { invocationId, seenIds: seen }).reason, 'duplicate');
  assert.equal(validateCommand(command({ id: 'x2' }), { invocationId, seenIds: new Set() }).reason, 'ok');
  assert.equal(validateCommand(command({ id: 'x2f', invocationId: 'other' }), { invocationId, seenIds: new Set() }).reason, 'foreign');
  assert.equal(validateCommand(command({ id: 'x3', createdAt: 'nope' }), { invocationId, seenIds: new Set() }).reason, 'malformed');
  assert.equal(validateCommand(null, { invocationId }).reason, 'malformed');
  assert.equal(validateCommand(command({ id: 'x4', createdAt: new Date(now - 11 * 60 * 1000).toISOString() }),
    { invocationId, seenIds: new Set() }).reason, 'stale');
  // A timestamp from the future is rejected (clock skew tolerance is bounded).
  assert.equal(validateCommand(command({ id: 'x5', createdAt: new Date(now + 60_000).toISOString() }),
    { invocationId, seenIds: new Set() }).reason, 'stale');
  assert.equal(validateCommand(command({ id: 'x5b', createdAt: new Date(now + 2_000).toISOString() }),
    { invocationId, seenIds: new Set() }).reason, 'ok');
  assert.equal(validateCommand(command({ id: 'x6', createdAt: new Date(now - 5000).toISOString() }),
    { invocationId, seenIds: new Set(), invocationStartedAtMs: now - 1000 }).reason, 'stale');
  // Same file, but the polling clock has moved far ahead: stale by wall time.
  assert.equal(validateCommand(command({ id: 'x6', createdAt: new Date(now - 5000).toISOString() }),
    { invocationId, seenIds: new Set(), invocationStartedAtMs: now - 1000, now: now + 20 * 60 * 1000 }).reason, 'stale');
});

test('client inbox consumes files once and deduplicates ids', () => {
  const dir = tempInbox();
  writeJsonAtomic(join(dir, 'cmd-000001-abc.json'), command());
  const inbox = new ClientInbox({ dir, invocationId, invocationStartedAtMs: now - 60_000 });
  const first = inbox.poll();
  assert.equal(first.commands.length, 1);
  assert.equal(first.skipped.length, 0);
  assert.deepEqual(readdirSync(dir), []); // consumed

  // Re-written duplicate id is ignored, a fresh id is accepted.
  writeJsonAtomic(join(dir, 'a.json'), command()); // duplicate id, already seen
  writeJsonAtomic(join(dir, 'b.json'), command({ id: 'cmd-000002-def' }));
  writeJsonAtomic(join(dir, 'c.json'), command({ invocationId: 'elsewhere', id: 'cmd-000003-xyz' }));
  const second = inbox.poll();
  assert.equal(second.commands.length, 1);
  assert.equal(second.commands[0].id, 'cmd-000002-def');
  assert.equal(second.skipped.length, 2);
  const reasons = second.skipped.map(s => s.reason).sort();
  assert.deepEqual(reasons, ['duplicate', 'foreign']);
});

test('atomic writes never expose a partial document (safe concurrency)', async () => {
  const dir = tempInbox();
  const file = join(dir, 'shared.json');
  const writers = Array.from({ length: 12 }, (_, i) =>
    writeJsonAtomic(file, { writer: i, payload: 'x'.repeat(2000) }));
  // Interleave reads while writes land.
  for (let i = 0; i < 40; i += 1) {
    const doc = readJsonFile(file);
    if (doc !== null) {
      assert.equal(typeof doc.writer, 'number');
      assert.equal(doc.payload.length, 2000);
    }
    await new Promise(r => setTimeout(r, 1));
  }
  await Promise.all(writers);
  assert.equal(readJsonFile(file).payload.length, 2000);
});

function liveProgress(overrides = {}) {
  return {
    version: 3,
    runtimeRoot: join(import.meta.dirname, '..', '..'),
    invocationId,
    status: 'running',
    updatedAt: new Date().toISOString(),
    controller: { pid: process.pid, bridgePid: null, nativePids: [] },
    controlInbox: join(tempInbox()),
    pendingInput: null,
    workflowRunIds: [],
    workflow: { runs: {} },
    phase: { index: 0, label: 't1', total: 1 },
    ...overrides,
  };
}

test('new control entry refuses legacy or foreign runtime owners', () => {
  const own = join(import.meta.dirname, '..', '..');
  assert.equal(validateRuntimeOwner({}, own).ok, false);
  assert.equal(validateRuntimeOwner({ runtimeRoot: tempInbox() }, own).ok, false);
  assert.equal(validateRuntimeOwner({ runtimeRoot: own }, own).ok, true);
});

test('control context validation: dead owner, stale state, missing prerequisites', () => {
  const dead = validateControlContext(liveProgress({ controller: { pid: 999999999 } }), 'steer', { message: 'x' });
  assert.equal(dead.ok, false);
  assert.match(dead.why, /controller pid/);

  const stale = validateControlContext(liveProgress({ status: 'completed' }), 'steer', { message: 'x' });
  assert.equal(stale.ok, false);
  assert.match(stale.why, /not live/);

  const noInbox = validateControlContext(liveProgress({ controlInbox: 'relative/path' }), 'steer', { message: 'x' });
  assert.equal(noInbox.ok, false);

  const noInput = validateControlContext(liveProgress(), 'answer', { interactionId: 'q1', optionId: 'a' });
  assert.equal(noInput.ok, false);
  assert.match(noInput.why, /no pending input/);

  const planInput = liveProgress({ pendingInput: {
    interactionId: 'p1', kind: 'plan_approval', options: [{ optionId: 'approve' }],
  } });
  const planAnswer = validateControlContext(planInput, 'answer', { interactionId: 'p1', optionId: 'approve' });
  assert.equal(planAnswer.ok, false, 'generic answer must not resolve a plan approval');

  const question = liveProgress({ pendingInput: {
    interactionId: 'q1', kind: 'question', options: [{ optionId: 'red' }, { optionId: 'blue' }],
  } });
  assert.equal(validateControlContext(question, 'answer', { interactionId: 'q1', optionId: 'red' }).ok, true);
  const wrongOption = validateControlContext(question, 'answer', { interactionId: 'q1', optionId: 'green' });
  assert.equal(wrongOption.ok, false);
  assert.match(wrongOption.why, /exact pending ordinary question/);
  const wrongId = validateControlContext(question, 'answer', { interactionId: 'q9', optionId: 'red' });
  assert.equal(wrongId.ok, false);

  const noRun = validateControlContext(liveProgress(), 'workflow-stop', { runId: 'r' });
  assert.equal(noRun.ok, false);
  assert.match(noRun.why, /no bound workflow run/);

  assert.equal(validateControlContext(liveProgress(), 'steer', { message: 'x' }).ok, true);
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
});

function runControl(args, { expectOk = true } = {}) {
  try {
    const out = execFileSync(process.execPath, [CONTROL, ...args], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    if (expectOk) throw e;
    return { failed: true, stderr: String(e.stderr ?? ''), status: e.status };
  }
}

test('control CLI writes a bound command file and returns its id; status needs no owner', () => {
  const dir = tempInbox();
  const progressFile = join(dir, 'PROGRESS.json');
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const progress = liveProgress({ controlInbox: inboxDir, pendingInput: {
    interactionId: 'q1', kind: 'question', question: 'pick', options: [{ optionId: 'red' }, { optionId: 'blue' }],
  } });
  writeJsonAtomic(progressFile, progress);

  const status = runControl(['--progress', progressFile, '--action', 'status']);
  assert.equal(status.status, 'running');
  assert.deepEqual(status.pendingInput.options, ['red', 'blue']);

  const steer = runControl(['--progress', progressFile, '--action', 'steer', '--message', 'do more']);
  assert.equal(steer.ok, true);
  assert.match(steer.commandId, /^cmd-\d{6}-[0-9a-f]{8}$/);
  const written = readJsonFile(steer.inboxFile);
  assert.equal(written.invocationId, invocationId);
  assert.deepEqual(written.payload, { message: 'do more' });

  const answer = runControl(['--progress', progressFile, '--action', 'answer',
    '--interactionId', 'q1', '--optionId', 'red']);
  assert.equal(answer.ok, true);

  const badAnswer = runControl(['--progress', progressFile, '--action', 'answer',
    '--interactionId', 'q1', '--optionId', 'green'], { expectOk: false });
  assert.ok(badAnswer.failed);
  assert.match(badAnswer.stderr, /exact pending ordinary question/);
});

test('control CLI accepts a positional JSON command document', () => {
  const dir = tempInbox();
  const progressFile = join(dir, 'PROGRESS.json');
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  writeJsonAtomic(progressFile, liveProgress({ controlInbox: inboxDir }));

  // Document form 1: {action, payload}
  const doc1 = join(dir, 'cmd1.json');
  writeJsonAtomic(doc1, { action: 'steer', payload: { message: 'from document' } });
  const r1 = runControl([progressFile, doc1]);
  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'steer');
  assert.deepEqual(readJsonFile(r1.inboxFile).payload, { message: 'from document' });

  // Document form 2: {action, ...flat payload fields}
  const doc2 = join(dir, 'cmd2.json');
  writeJsonAtomic(doc2, { action: 'steer', message: 'flat form' });
  const r2 = runControl([progressFile, doc2]);
  assert.equal(r2.ok, true);
  assert.deepEqual(readJsonFile(r2.inboxFile).payload, { message: 'flat form' });

  // Document form 3: workflow-settings with bounded maxConcurrency.
  writeJsonAtomic(progressFile, liveProgress({ controlInbox: inboxDir, workflowRunIds: ['run-1'],
    workflow: { runs: { 'run-1': 'running' } } }));
  const doc3 = join(dir, 'cmd3.json');
  writeJsonAtomic(doc3, { action: 'workflow-settings', payload: { runId: 'run-1', maxConcurrency: 2 } });
  const r3 = runControl([progressFile, doc3]);
  assert.equal(r3.ok, true);
  assert.deepEqual(readJsonFile(r3.inboxFile).payload, { runId: 'run-1', maxConcurrency: 2 });
});

test('control CLI rejects invalid actions with exit code 1', () => {
  const dir = tempInbox();
  const progressFile = join(dir, 'PROGRESS.json');
  writeJsonAtomic(progressFile, liveProgress({ controlInbox: join(dir, 'inbox') }));
  const result = runControl(['--progress', progressFile, '--action', 'steer'], { expectOk: false });
  assert.ok(result.failed);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /message/);
});

test('buildControlCommand produces unique, sort-stable ids', () => {
  const a = buildControlCommand({ progress: liveProgress(), action: 'pause', payload: {}, seq: 1 });
  const b = buildControlCommand({ progress: liveProgress(), action: 'pause', payload: {}, seq: 2 });
  assert.match(a.id, /^cmd-000001-/);
  assert.match(b.id, /^cmd-000002-/);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(compactStatus(liveProgress()).queuedControls, []);
});

test('writeFileSync fallback in helper stays usable', () => {
  const dir = tempInbox();
  writeFileSync(join(dir, 'raw.txt'), 'ok');
  assert.equal(readFileSync(join(dir, 'raw.txt'), 'utf8'), 'ok');
});
