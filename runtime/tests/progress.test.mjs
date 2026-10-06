import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile } from '../jsonio.mjs';
import { buildConfig } from '../config.mjs';
import { normalizeRequest } from '../request.mjs';
import { ProgressTracker } from '../progress.mjs';

const config = buildConfig({ maxControls: 3, maxTurns: 2, replayCharLimit: 100 });

function makeTracker({ progressPath = null } = {}) {
  const request = normalizeRequest(buildConfig(), {
    cwd: process.cwd(), prompt: 'x', timeoutSeconds: 60, idleSeconds: 0,
  });
  return new ProgressTracker({
    invocationId: 'inv-test', cwd: 'C:\\tmp', request, config,
    progressPath, controllerPid: 4242, inboxPath: 'C:\\tmp\\inbox',
  });
}

test('snapshots are atomic and carry the full observable state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-v3-progress-'));
  const file = join(dir, 'PROGRESS.json');
  const tracker = makeTracker({ progressPath: file });
  tracker.setSession('sess-1');
  tracker.setPhase(0, 'turn-1');
  tracker.setEffective({ model: 'builtin:bigmodel-coding-plan\\GLM-5.3', thought: 'max', mode: 'build' });
  tracker.touch({ type: 'turn_started', label: 'turn-1' });
  tracker.recordControl('cmd-1', 'steer', 'queued', 'waiting');
  tracker.recordControl('cmd-1', 'steer', 'accepted', 'picked up');
  tracker.setPendingInput({ interactionId: 'q1', kind: 'question', options: [] });

  const snap = readJsonFile(file);
  assert.equal(snap.version, 3);
  assert.equal(snap.invocationId, 'inv-test');
  assert.equal(snap.sessionId, 'sess-1');
  assert.equal(snap.controller.pid, 4242);
  assert.equal(snap.model.effective, 'builtin:bigmodel-coding-plan\\GLM-5.3');
  assert.equal(snap.thought.effective, 'max');
  assert.equal(snap.mode.effective, 'build');
  assert.equal(snap.status, 'needs_input');
  assert.equal(snap.pendingInput.interactionId, 'q1');
  assert.equal(snap.controls.queue.length, 1);
  assert.ok(snap.activity.lastActivityAt);
  assert.equal(snap.controlInbox, 'C:\\tmp\\inbox');
  assert.ok(snap.deadline.timeoutSeconds === 60);
});

test('last actual activity is distinct from heartbeat timestamp', async () => {
  const tracker = makeTracker();
  tracker.touch({ type: 'a' });
  const activityAt = tracker.state.activity.lastActivityAt;
  await new Promise(r => setTimeout(r, 25));
  tracker.heartbeat();
  assert.notEqual(tracker.state.activity.lastHeartbeatAt, activityAt);
  assert.equal(tracker.state.activity.lastActivityAt, activityAt);
});

test('controls history is bounded and flags truncation; queue drains to history', () => {
  const tracker = makeTracker();
  for (let i = 0; i < 6; i += 1) {
    tracker.recordControl(`cmd-${i}`, 'steer', 'queued', null);
    tracker.recordControl(`cmd-${i}`, 'steer', 'completed', null);
  }
  assert.equal(tracker.state.controls.history.length, 3);
  assert.equal(tracker.state.controls.queue.length, 0);
  assert.equal(tracker.state.evidence.controlsTruncated, true);

  tracker.recordControl('cmd-live', 'pause', 'accepted', null);
  assert.equal(tracker.state.controls.queue.length, 1);
  tracker.dropQueuedControls('paused');
  assert.equal(tracker.state.controls.queue.length, 0);
  const dropped = tracker.state.controls.history.at(-1);
  assert.equal(dropped.id, 'cmd-live');
  assert.equal(dropped.state, 'rejected');
  assert.equal(dropped.detail, 'paused');
});

test('replay accounting is capped, flagged in evidence, and snapshots are deep', () => {
  const tracker = makeTracker();
  tracker.noteReplay(60);
  tracker.noteReplay(60);
  assert.equal(tracker.state.replay.chars, 100);
  assert.equal(tracker.state.replay.truncated, true);
  // Requirement: truncation is flagged in the evidence aggregate, never silent.
  assert.equal(tracker.state.evidence.replayTruncated, true,
    'replay truncation must set evidence.replayTruncated');
  const snap = tracker.snapshot();
  snap.replay.chars = 0;
  snap.controls.history.push({ id: 'evil' });
  assert.equal(tracker.state.replay.chars, 100);
  assert.equal(tracker.state.controls.history.length, 0);
});

test('turns and workflow run bookkeeping are bounded', () => {
  const tracker = makeTracker();
  tracker.addTurn({ label: 'a', stopReason: 'end_turn' });
  tracker.addTurn({ label: 'b', stopReason: 'end_turn' });
  tracker.addTurn({ label: 'c', stopReason: 'end_turn' });
  assert.equal(tracker.state.turns.length, 2);
  assert.equal(tracker.state.evidence.turnsTruncated, true);
  tracker.addWorkflowRun('run-1', 'running');
  tracker.setWorkflowRun('run-1', 'completed');
  assert.deepEqual(tracker.state.workflowRunIds, ['run-1']);
  assert.equal(tracker.state.workflow.runs['run-1'], 'completed');
  tracker.setWorkflowRun('run-unknown', 'failed'); // not bound: ignored
  assert.equal(tracker.state.workflow.runs['run-unknown'], undefined);
});

test('oversized events are compacted, not dropped silently', () => {
  const tracker = makeTracker();
  tracker.touch({ type: 'tool_call', raw: 'x'.repeat(config.compactByteLimit + 10) });
  assert.ok(tracker.state.lastEvent.truncated);
  assert.ok(tracker.state.lastEvent.preview.length <= config.compactByteLimit);
});
