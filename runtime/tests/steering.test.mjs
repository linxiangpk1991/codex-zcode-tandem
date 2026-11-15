// Steering tests against the REAL upstream 0.85.3 wire shapes:
//   InitializeResponse._meta.steering = { supported: true, timings: ["now","next"] }
//   _session/steering request { sessionId, prompt: ContentBlock[],
//     _meta.steering.priority: "now"|"next" }
//   replies { outcome: "injected" | "queued" | "startedNewTurn" }
//          | { outcome: "promptRequired", reason: "noRunningTurn" }
// Covers: live injection, native queue (priority next), fallback when the
// extension is not negotiated, the promptRequired and no-running-turn idle
// races, unknown acknowledgements (timeout / unexpected reply) that are never
// replayed, ask's serialized follow-up semantics, late steering after review,
// admission-time invalidation of firstPassReview, quality-loop steer revision
// closure, and denial semantics (pause rejection, priority validation,
// degraded tool policy refusing delivery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Duplex, Writable, Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { buildConfig } from '../config.mjs';
import { normalizeRequest } from '../request.mjs';
import { runTask } from '../runner.mjs';
import { runQualityLoop } from '../quality-loop.mjs';
import { ProgressTracker } from '../progress.mjs';
import { readJsonFile, writeJsonAtomic } from '../jsonio.mjs';
import { validateControlPayload } from '../inbox.mjs';
import { FakeTransport } from './support/fake-transport.mjs';

const CONFIG = buildConfig({
  inboxPollMs: 25, heartbeatMs: 1000, gracefulCancelWaitMs: 400, bridgeIpcTimeoutMs: 2000,
}, {});
const FAST_ACK_CONFIG = buildConfig({
  inboxPollMs: 25, heartbeatMs: 1000, gracefulCancelWaitMs: 400, bridgeIpcTimeoutMs: 2000,
  steerAckTimeoutMs: 300, steerDrainWaitMs: 1500,
}, {});
const FAST_DRAIN_CONFIG = buildConfig({
  inboxPollMs: 25, heartbeatMs: 1000, gracefulCancelWaitMs: 400, bridgeIpcTimeoutMs: 2000,
  steerAckTimeoutMs: 300, steerDrainWaitMs: 400,
}, {});
// Exactly what zcode-acp-server 0.85.3 advertises (server.js initialize).
const NATIVE_STEERING_META = { supported: true, timings: ['now', 'next'] };

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'zcode-v3-steer-'));
}

function beginRun({ raw, config = CONFIG, fakeOpts = {}, reviewOpts = {}, invocationId }) {
  const dir = makeTemp();
  const id = invocationId ?? `inv-${randomUUID().slice(0, 8)}`;
  const request = normalizeRequest(config, {
    cwd: dir,
    progressFile: join(dir, 'PROGRESS.json'),
    resultFile: join(dir, 'RESULT.json'),
    ...raw,
  });
  const fake = new FakeTransport(fakeOpts);
  const reviews = []; let spawned = false;
  const task = runTask({
    request, config, cwd: dir, invocationId: id,
    deps: {
      spawnTransport: opts => {
        if (!spawned) { spawned = true; return fake.spawn(opts); }
        const reviewer = new FakeTransport({ ...reviewOpts, sessionId: `review-${reviews.length + 1}` });
        reviews.push(reviewer); return reviewer.spawn(opts);
      },
      cleanupOwnedPids: () => [],
      nativeCliVersion: async () => ({ version: '3.9.9' }),
      identityRoot: dir,
    },
  });
  return { fake, reviews, task, dir, invocationId: id, request,
    progressPath: join(dir, 'PROGRESS.json'), resultPath: join(dir, 'RESULT.json') };
}

function writeControl(run, action, payload) {
  writeJsonAtomic(join(run.dir, CONFIG.inboxDirName, run.invocationId, `cmd-${randomUUID().slice(0, 12)}.json`), {
    id: `cmd-${randomUUID().slice(0, 8)}`,
    invocationId: run.invocationId, action, payload,
    createdAt: new Date().toISOString(),
    source: { progressUpdatedAt: null },
  });
}

async function waitFor(cond, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

function controlEntry(doc, id) {
  const pool = Array.isArray(doc?.controls) ? doc.controls
    : [...(doc?.controls?.queue ?? []), ...(doc?.controls?.history ?? [])];
  return pool.find(c => c.id === id);
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Real turn.steerDrained shape (docs/PROTOCOL.md), as the bridge guard
 * forwards it: the native backend sid mapped to OUR ACP aliases (session/new
 * issues a random acpSid ≠ native sid), full-text identity as sha256.
 */
function drainedEvent(text, { pendingInputId = 'pi-1', targetTurnId = 'turn-9',
  acpSessionIds = ['sess-1'] } = {}) {
  return { type: 'steer_event', kind: 'steerDrained', nativeSessionId: 'sess-native-1',
    acpSessionIds,
    payload: { pendingInputIds: [pendingInputId], targetTurnId, injectedMessageIds: ['m-1'],
      drainedInputs: [{ pendingInputId, messageId: 'm-1',
        textSha256: sha256(text), text }] } };
}

const DELIVERY_RAW = {
  prompt: 'implement', allowToolKinds: ['read', 'edit'],
  workspace: { ownedPaths: ['note.txt'] },
  delivery: { candidateFiles: ['note.txt'], validation: 'not_applicable', validationReason: 'plain text edit' },
};
function emitReview(run, fake = run.reviews.at(-1), declaration = null) {
  fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'review-read', title: 'Read',
    kind: 'read', status: 'completed', rawInput: { file_path: join(run.dir, 'note.txt') },
    _meta: { claudeCode: { toolName: 'Read' } } });
  fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text',
    text: '```tandem-review\n' + JSON.stringify(declaration ?? { reviewedFiles: ['note.txt'],
      fixedIssues: [], openIssues: [], summary: 'Read the final text.' }) + '\n```' } });
}

// ---------- negotiation & live injection ----------

test('initialize advertises steering; a live steer (now) sends the real request shape and is not replayed as a prompt', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'] },
    fakeOpts: { script: ['hold', 'end_turn'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'injected' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'live-fix', priority: 'now' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  // Exact upstream contract (handlers/steering.js): text-only ContentBlock,
  // priority under _meta.steering, no idleBehavior auto-start.
  assert.deepEqual(run.fake.steeringCalls[0], {
    sessionId: 'sess-1',
    prompt: [{ type: 'text', text: 'live-fix' }],
    _meta: { steering: { priority: 'now' } },
  });
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(run.fake.promptLog, ['p1', 'p2'], 'an injected steer never becomes its own session/prompt');
  assert.equal(report.steering.negotiated.supported, true);
  assert.deepEqual(report.steering.negotiated.timings, ['now', 'next']);
  assert.equal(report.steering.mode, '_session/steering');
  assert.match(report.steering.boundary, /not that the change is implemented/);
  const steer = report.steering.events.find(e => e.outcome === 'injected');
  assert.ok(steer, 'injection recorded as an event');
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'completed');
  assert.match(entry.detail, /injected/);
  assert.match(entry.detail, /end_turn/);
  assert.ok(entry.acceptedAt && entry.startedAt && entry.completedAt, 'interface acceptance, outcome and completion are distinct timestamps');
});

test('priority next maps to a native queue outcome; only the real turn.steerDrained event completes it', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'] },
    fakeOpts: { script: ['hold', 'end_turn'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'queued' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'queue-me', priority: 'next' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  assert.equal(run.fake.steeringCalls[0]._meta.steering.priority, 'next');
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.some(c => c.action === 'steer'), 3000, 'steer started');
  const steerId = readJsonFile(run.progressPath).controls.queue.find(c => c.action === 'steer').id;
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => run.fake.inFlight === 0, 3000, 'p1 done');
  assert.equal(run.fake.promptLog.length, 1, 'the next foreground turn waits for the native queue');
  assert.notEqual(controlEntry(readJsonFile(run.progressPath), steerId)?.state, 'completed',
    'foreground completion is NOT drain proof');
  // A drain event for a DIFFERENT ACP session is foreign and must not complete it.
  run.fake.emitEvent(drainedEvent('queue-me', { acpSessionIds: ['sess-other-conversation'] }));
  await new Promise(r => setTimeout(r, 120));
  assert.notEqual(controlEntry(readJsonFile(run.progressPath), steerId)?.state, 'completed',
    'foreign-session drain events are rejected');
  run.fake.emitEvent(drainedEvent('queue-me'));
  run.fake.emitEvent({ type: 'native_turn', kind: 'started', turnId: 'native-queue-1', acpSessionIds: ['sess-1'] });
  await waitFor(() => controlEntry(readJsonFile(run.progressPath), steerId)?.state === 'completed', 3000, 'drain event');
  await new Promise(r => setTimeout(r, 180));
  assert.equal(run.fake.promptLog.length, 1, 'a drained input does not mean its native turn finished');
  run.fake.emitEvent({ type: 'native_turn', kind: 'completed', turnId: 'native-queue-1', acpSessionIds: ['sess-1'] });
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(run.fake.promptLog, ['p1', 'p2'], 'the native queue owns delivery; the runner does not re-send it');
  const entry = report.controls.find(c => c.id === steerId);
  assert.match(entry.detail, /turn\.steerDrained/);
  assert.match(entry.detail, /pi-1/);
  assert.match(entry.detail, new RegExp(`textSha256=${sha256('queue-me').slice(0, 12)}`));
});

// ---------- fallbacks and idle races ----------

test('without the extension negotiated the original boundary queue is kept verbatim', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'] },
    fakeOpts: { script: ['hold', 'end_turn'] }, // no steeringMeta: pre-extension bridge
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'boundary-fix' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1, 3000, 'steer queued');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(run.fake.promptLog, ['p1', 'boundary-fix', 'p2']);
  assert.equal(report.steering.negotiated.supported, false);
  assert.equal(report.steering.mode, 'foreground boundary queue');
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'completed');
  assert.match(entry.detail, /end_turn/);
  assert.equal(run.fake.steeringCalls.length, 0);
});

test('promptRequired (idle race at the bridge) falls back to the boundary queue', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'] },
    fakeOpts: { script: ['hold', 'end_turn'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'race-lost' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1, 3000, 'fallback queued');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.deepEqual(run.fake.promptLog, ['p1', 'race-lost', 'p2'], 'the steer runs as the next foreground turn');
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'completed');
});

test('a steer arriving with no foreground turn running queues without spending the round trip', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], idleSeconds: 1 },
    fakeOpts: { script: ['end_turn'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'injected' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  await waitFor(() => run.fake.inFlight === 0 && readJsonFile(run.progressPath)?.status === 'idle_window', 3000, 'idle window');
  writeControl(run, 'steer', { message: 'idle-steer' });
  await waitFor(() => run.fake.promptLog.length === 2, 3000, 'boundary steer turn');
  assert.equal(run.fake.steeringCalls.length, 0, 'no live attempt while idle: the bridge would only answer promptRequired');
  const { report } = await run.task;
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'completed');
  assert.ok(entry.transitions.some(t => t.state === 'queued'), 'it was queued before running, never sent live');
});

// ---------- unknown acknowledgements ----------

test('a steering acknowledgement that times out is declared unknown and never replayed', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'] },
    config: FAST_ACK_CONFIG,
    fakeOpts: { script: ['hold', 'end_turn'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => new Promise(() => {}) }, // never acknowledges
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'maybe-lost' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(run.fake.promptLog, ['p1', 'p2'], 'an unknown outcome is not re-sent as a prompt either');
  assert.equal(run.fake.steeringCalls.length, 1, 'exactly one attempt; no replay over _session/steering');
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'unknown');
  assert.match(entry.detail, /outcome unknown/);
  assert.match(entry.detail, /not replayed/);
  assert.equal(report.steering.events.find(e => e.id === entry.id).outcome, 'unknown');
  assert.ok(report.steering.unknownCount >= 1);
});

test('an unexpected reply shape is also an unknown outcome, not a silent success', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'] },
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'weird', extra: true }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'odd-reply' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'unknown');
  assert.match(entry.detail, /unexpected steering reply/);
});

// ---------- ask semantics & denials ----------

test('ask never steers live: it stays a serialized foreground follow-up turn', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'] },
    fakeOpts: { script: ['hold', 'end_turn'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'injected' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'ask', { message: 'why this design?' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1, 3000, 'ask queued');
  assert.match(readJsonFile(run.progressPath).controls.queue[0].detail, /ask stays serialized/);
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.equal(run.fake.steeringCalls.length, 0, 'ask is never sent over _session/steering');
  assert.deepEqual(run.fake.promptLog, ['p1', 'why this design?', 'p2']);
  const entry = report.controls.find(c => c.action === 'ask');
  assert.equal(entry.state, 'completed');
});

test('steer and ask are rejected while the invocation is pausing or closing', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'] },
    fakeOpts: { script: ['hold'] },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'pause', {});
  await waitFor(() => run.fake.cancelCount > 0, 3000, 'cancel observed');
  writeControl(run, 'steer', { message: 'too late' });
  const { report } = await run.task;
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'rejected');
  assert.match(entry.detail, /pausing|finalized|closing/);
});

test('steer priority payloads are validated up front; ask has no priority field', () => {
  assert.equal(validateControlPayload('steer', { message: 'x' }).ok, true, 'priority is optional');
  assert.equal(validateControlPayload('steer', { message: 'x', priority: 'now' }).ok, true);
  assert.equal(validateControlPayload('steer', { message: 'x', priority: 'next' }).ok, true);
  const bad = validateControlPayload('steer', { message: 'x', priority: 'later' });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /must be "now" or "next"/);
  const ask = validateControlPayload('ask', { message: 'x', priority: 'now' });
  assert.equal(ask.ok, false, 'ask deliberately has no priority: serial follow-up only');
  assert.match(ask.why, /unsupported payload key/);
});

// ---------- invalidation & the quality loop ----------

test('a live steer admitted during the implementation turn invalidates any existing review and reaches the reviewer as a requirement', async () => {
  const run = beginRun({
    raw: DELIVERY_RAW,
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'injected' }) },
    reviewOpts: { script: ['hold'] },
  });
  writeFileSync(join(run.dir, 'note.txt'), 'done');
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'implementation turn');
  writeControl(run, 'steer', { message: 'also check the trailing newline' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  run.fake.resolvePrompt('implement', 'end_turn');
  await waitFor(() => run.reviews[0]?.promptLog.length === 1, 3000, 'review turn');
  assert.match(run.reviews[0].promptLog[0], /also check the trailing newline/, 'the steer text is review requirements data');
  emitReview(run); run.reviews[0].resolvePrompt(run.reviews[0].promptLog[0]);
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.equal(report.delivery.status, 'ready_for_controller_review', 'the fresh review covers the steered work');
  assert.equal(report.firstPassReview.invalidated, undefined);
});

test('a live steer admitted during a repair turn re-reviews instead of letting the old review pass', async () => {
  const run = beginRun({
    raw: DELIVERY_RAW,
    fakeOpts: { script: ['end_turn', 'hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'injected' }) },
    reviewOpts: { script: ['hold'] },
  });
  writeFileSync(join(run.dir, 'note.txt'), 'done');
  await waitFor(() => run.reviews[0]?.promptLog.length === 1, 3000, 'review turn');
  emitReview(run, run.reviews[0], { reviewedFiles: ['note.txt'], fixedIssues: [],
    openIssues: ['note.txt: trailing newline missing'], summary: 'Found a defect.' });
  run.reviews[0].resolvePrompt(run.reviews[0].promptLog[0]);
  await waitFor(() => run.fake.promptLog.length === 2 && run.fake.inFlight === 1, 3000, 'repair turn');
  assert.match(run.fake.promptLog[1], /tandem:repair-1|Independent review or real validation/);
  // The repair turn is foreground on the implementation session: inject
  // mid-turn, exactly like a controller course correction during fixes.
  writeControl(run, 'steer', { message: 'one more requirement arrived late' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  run.fake.resolvePrompt(run.fake.promptLog[1], 'end_turn');
  await waitFor(() => run.reviews[1]?.promptLog.length === 1, 3000, 'second review');
  assert.match(run.reviews[1].promptLog[0], /one more requirement arrived late/);
  emitReview(run, run.reviews[1]); run.reviews[1].resolvePrompt(run.reviews[1].promptLog[0]);
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.equal(report.qualityLoop.status, 'passed');
  assert.equal(report.qualityLoop.reviews.length, 2);
  const steer = report.controls.find(c => c.action === 'steer');
  assert.equal(steer.state, 'completed');
  assert.match(steer.detail, /injected; live turn ended end_turn/);
});

test('the quality loop closes on steerRevision even without a foreground turn (pure loop-level check)', async () => {
  const dir = makeTemp();
  writeFileSync(join(dir, 'note.txt'), 'done');
  const config = CONFIG;
  const request = normalizeRequest(config, { cwd: dir, ...DELIVERY_RAW,
    progressFile: join(dir, 'P.json'), resultFile: join(dir, 'R.json') });
  const tracker = new ProgressTracker({ invocationId: 'inv-quality', cwd: dir, request, config,
    progressPath: null, controllerPid: process.pid, inboxPath: dir });
  const st = { sessionId: 'impl-session', steerRevision: 0, steeringRequirements: [], needsAttention: false };
  const report = {};
  const reviewTools = [{ status: 'completed',
    _meta: { claudeCode: { toolName: 'Read' } }, rawInput: { file_path: join(dir, 'note.txt') } }];
  const reviewText = '```tandem-review\n' + JSON.stringify({ reviewedFiles: ['note.txt'],
    fixedIssues: [], openIssues: [], summary: 'clean' }) + '\n```';
  const reviewRequests = [];
  let round = 0;
  const runQuality = runQualityLoop({
    request, config, report, st, tracker, directory: dir,
    deadlineAt: Date.now() + 60_000,
    runTask: async ({ request: child }) => {
      reviewRequests.push(child);
      round += 1;
      if (round === 1) {
        // A live steer admitted while the round-1 review ran.
        st.steerRevision += 1;
        st.steeringRequirements.push('mid-review live steer');
      }
      return { exitCode: 0, report: { status: 'completed', sessionId: `review-${round}`,
        stopReason: 'end_turn', response: reviewText, tools: reviewTools,
        evidence: {}, responseTruncated: false, cleanup: [], metrics: null } };
    },
    deps: {},
    runPromptTurn: async () => { throw new Error('no repairs expected'); },
    recordTurn: () => {},
    terminal: () => false,
    writeResultEarly: () => {},
  });
  await runQuality;
  assert.equal(report.qualityLoop.status, 'passed', 'the steered round re-reviews once and then passes');
  assert.equal(report.qualityLoop.reviews.length, 2);
  assert.equal(report.qualityLoop.reviews[0].invalidated, true, 'the stale review is explicitly invalidated');
  assert.equal(report.qualityLoop.reviews[1].invalidated, undefined);
  assert.match(reviewRequests[1].prompts[0].text, /mid-review live steer/,
    'round 2 requirements include the steer');
  assert.doesNotMatch(reviewRequests[0].prompts[0].text, /mid-review live steer/,
    'round 1 was built before the steer existed');
});

test('a degraded tool policy (backend rejected toolDenylist) refuses delivery', async () => {
  const run = beginRun({
    raw: DELIVERY_RAW,
    fakeOpts: { script: ['end_turn'] },
    reviewOpts: { script: ['hold'] },
  });
  writeFileSync(join(run.dir, 'note.txt'), 'done');
  await waitFor(() => run.reviews[0]?.promptLog.length === 1, 3000, 'review turn');
  run.fake.emitEvent({ type: 'tool_policy_degraded',
    reason: 'backend rejects toolDenylist; ZCODE_DISALLOWED_TOOLS / the Cron* defaults are NOT applied on this backend' });
  emitReview(run); run.reviews[0].resolvePrompt(run.reviews[0].promptLog[0]);
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 4, 'exit 4: not ready for controller review');
  assert.equal(report.delivery.status, 'needs_review');
  assert.ok(report.delivery.reasons.some(r => /tool policy was not applied/.test(r)));
  assert.ok(report.warnings.some(w => w.includes('TOOL_POLICY_NOT_APPLIED')));
  assert.equal(report.evidence.toolPolicyDegraded, true);
});

// ---------- drain proof via real steer lifecycle events ----------

test('queued steers complete only on the real turn.steerDrained event; drain output is not replay', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], idleSeconds: 1 },
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'queued' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'native-queue', priority: 'next' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.some(c => c.action === 'steer'), 3000, 'steer started');
  const steerId = readJsonFile(run.progressPath).controls.queue.find(c => c.action === 'steer').id;
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => run.fake.inFlight === 0 && readJsonFile(run.progressPath)?.status === 'idle_window', 3000, 'idle window');
  assert.notEqual(controlEntry(readJsonFile(run.progressPath), steerId)?.state, 'completed',
    'the queue ack alone is not completion');
  // The backend delivers the queued steer as its own turn at the boundary
  // (turn state) and persists the input (turn.steerDrained carries the text).
  run.fake.emitTurnState(true);
  run.fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'steer drain output' } });
  run.fake.emitEvent(drainedEvent('native-queue'));
  run.fake.emitTurnState(false);
  await waitFor(() => controlEntry(readJsonFile(run.progressPath), steerId)?.state === 'completed', 3000, 'drain completion');
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  const entry = report.controls.find(c => c.id === steerId);
  assert.match(entry.detail, /turn\.steerDrained/);
  assert.equal(report.replayedHistory.chars, 0, 'drain output is neither response nor replay');
  assert.deepEqual(run.fake.promptLog, ['p1'], 'the native queue delivered the text; the runner never re-sent it');
});

test('a drain event that arrives BEFORE the ack still completes the steer (real ordering race)', async () => {
  const holder = {};
  const run = beginRun({
    raw: { prompts: ['p1'], idleSeconds: 1 },
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => {
        // The backend queues, drains and only then does our ack resolve.
        holder.fake.emitEvent({ type: 'steer_event', kind: 'steerQueued', sessionId: 'sess-native-1', acpSessionIds: ['sess-1'],
          payload: { pendingInputId: 'pi-9', inputPreview: 'early-event', delivery: 'queue',
            targetTurnId: 't-9', queueLength: 1 } });
        holder.fake.emitEvent(drainedEvent('early-event', { pendingInputId: 'pi-9', targetTurnId: 't-9' }));
        return { outcome: 'queued' };
      } },
  });
  holder.fake = run.fake;
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'early-event', priority: 'next' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  const entry = report.controls.find(c => c.action === 'steer');
  assert.equal(entry.state, 'completed', 'the pre-ack drain event completes the steer at admission');
  assert.match(entry.detail, /turn\.steerDrained/);
  assert.match(entry.detail, /pi-9/);
  assert.deepEqual(run.fake.promptLog, ['p1'], 'never re-sent');
});

test('without any drain event the run ends needs_attention after a bounded wait, never a fabricated completion', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'] },
    config: FAST_DRAIN_CONFIG,
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'queued' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'never-drained', priority: 'next' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report, exitCode } = await run.task;
  assert.equal(report.status, 'needs_attention');
  assert.equal(exitCode, 1);
  assert.match(report.error, /never observed drained/);
  assert.match(report.error, /turn\.steerDrained/);
  const entry = report.controls.find(c => c.action === 'steer');
  assert.notEqual(entry.state, 'completed', 'no event, no fabricated drained state');
  assert.equal(report.steering.pendingAtClose.awaitingDrain.length, 1,
    'the unconsumed pending input is persisted at close, not silently dropped');
  assert.equal(report.steering.pendingAtClose.awaitingDrain[0].textSha256, sha256('never-drained'));
});

test('two identical queued steers never share one drained receipt (hash + one-time pendingInputId)', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'] },
    config: FAST_DRAIN_CONFIG,
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => ({ outcome: 'queued' }) },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run, 'steer', { message: 'twin steer text', priority: 'next' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'first steering request');
  writeControl(run, 'steer', { message: 'twin steer text', priority: 'next' });
  await waitFor(() => run.fake.steeringCalls.length === 2, 3000, 'second steering request');
  await waitFor(() => (readJsonFile(run.progressPath)?.controls?.queue ?? [])
    .filter(c => c.action === 'steer' && c.state === 'started').length === 2, 3000, 'both queued');
  run.fake.resolvePrompt('p1', 'end_turn');
  // ONE drained receipt for one pendingInputId, identical full text.
  run.fake.emitEvent(drainedEvent('twin steer text', { pendingInputId: '' }));
  assert.equal((readJsonFile(run.progressPath)?.controls?.queue ?? [])
    .filter(c => c.action === 'steer' && c.state === 'started').length, 2,
    'a receipt without an input identity cannot complete either request');
  run.fake.emitEvent(drainedEvent('twin steer text', { pendingInputId: 'pi-a' }));
  await new Promise(r => setTimeout(r, 150));
  const progress = readJsonFile(run.progressPath);
  const started = (progress.controls.queue ?? []).filter(c => c.action === 'steer' && c.state === 'started');
  assert.equal(started.length, 1, 'exactly one twin completed; the receipt is one-time');
  const { report, exitCode } = await run.task;
  assert.equal(report.status, 'needs_attention', 'the second twin is unresolved');
  assert.equal(exitCode, 1);
  assert.match(report.error, /1 queued steer\(s\) were never observed drained/);
  assert.equal(report.steering.pendingAtClose.awaitingDrain.length, 1);
});

test('an unknown steering outcome refuses a ready handoff even after a clean fresh review', async () => {
  const run = beginRun({
    raw: DELIVERY_RAW,
    config: FAST_ACK_CONFIG,
    fakeOpts: { script: ['hold'], steeringMeta: NATIVE_STEERING_META,
      steeringHandler: () => new Promise(() => {}) }, // never acknowledges
    reviewOpts: { script: ['hold'] },
  });
  writeFileSync(join(run.dir, 'note.txt'), 'done');
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'implementation turn');
  writeControl(run, 'steer', { message: 'maybe-lost requirement' });
  await waitFor(() => run.fake.steeringCalls.length === 1, 3000, 'steering request');
  // Let the 300ms ack timeout declare the unknown BEFORE the review starts, so
  // the loop is deterministic: one review that already carries the requirement.
  await waitFor(() => (readJsonFile(run.progressPath)?.controls?.history ?? [])
    .some(c => c.state === 'unknown'), 3000, 'unknown recorded');
  run.fake.resolvePrompt('implement', 'end_turn');
  await waitFor(() => run.reviews[0]?.promptLog.length === 1, 3000, 'review turn');
  assert.match(run.reviews[0].promptLog[0], /maybe-lost requirement/);
  emitReview(run); run.reviews[0].resolvePrompt(run.reviews[0].promptLog[0]);
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 4, 'unknown steering blocks ready_for_controller_review');
  assert.equal(report.delivery.status, 'needs_review');
  assert.ok(report.delivery.reasons.some(r => /steering outcome is unknown/.test(r)));
  assert.ok(report.steering.unknownCount >= 1, 'the sticky unknown counter — not the bounded events log — carries the uncertainty');
});

// ---------- SDK wire confirmation ----------

test('SDK ClientSideConnection sends extension method names verbatim (no prefix)', async () => {
  const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..',
    'node_modules', 'zcode-acp-server', 'package.json'));
  const sdkPath = require.resolve('@agentclientprotocol/sdk');
  const acp = await import(pathToFileURL(sdkPath));
  const frames = [];
  const duplex = new Duplex({ write(chunk, _enc, cb) { frames.push(String(chunk)); cb(); }, read() {} });
  const conn = new acp.ClientSideConnection(() => ({}),
    acp.ndJsonStream(Writable.toWeb(duplex), Readable.toWeb(duplex)));
  const pending = conn.request('_session/steering', { sessionId: 's', prompt: [{ type: 'text', text: 'x' }] });
  await waitFor(() => frames.length > 0, 3000, 'wire frame');
  const methods = frames.flatMap(f => f.split('\n')).filter(Boolean).map(l => JSON.parse(l).method);
  assert.ok(methods.includes('_session/steering'),
    `the wire method is the full name; got ${JSON.stringify(methods)}`);
  void pending.catch(() => {});
  duplex.destroy();
});
