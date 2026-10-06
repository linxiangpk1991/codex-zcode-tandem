// Bridge-side adapter tests: config isolation proof against the REAL upstream
// config modules (filesystem only, no spawn, no network), the allowlisted
// workflow op adapter against a STATEFUL fake workflow layer (upstream
// settings/workflow.js signatures: every callback receives the server first),
// the notification-boundary patch on the REAL upstream BackgroundTaskListener,
// server capture and PID tracking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIsolatedAcpConfig } from '../config.mjs';
import {
  captureServerViaInitialize, createPidTracker, createWorkflowOps,
  installNotificationBoundaryPatch, snapshotEffectivePolicy,
} from '../bridge.mjs';
import { BackgroundTaskListener } from 'zcode-acp-server/dist/handlers/background-tasks.js';

const flush = () => new Promise(r => setImmediate(r));

function isolatedXdg({ workflowMode = 'onDemand' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'zcode-v3-xdg-test-'));
  const isolated = buildIsolatedAcpConfig({ workflowMode });
  const dir = join(home, ...isolated.relPath.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ...isolated.relPath), JSON.stringify(isolated.json));
  return { home, isolated };
}

function baseEnv(extra = {}) {
  return {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: null, // set per test
    ...extra,
  };
}

test('config isolation: isolated XDG config wins over a hostile ambient env', async () => {
  const { home } = isolatedXdg({ workflowMode: 'onDemand' });
  const hostile = baseEnv({
    XDG_CONFIG_HOME: home,
    ZCODE_ACP_MODE: 'yolo',          // env must NOT beat the config file
    ZCODE_ACP_QUOTA_AUTO_RESUME: '1',
    ZCODE_ACP_REMOTE: '1',
    ZCODE_ACP_REMOTE_TOKEN: 'token', // remote would enable without isolation
    ZCODE_DYNAMIC_WORKFLOW_MODE: 'alwaysOn',
  });
  const policy = await snapshotEffectivePolicy(hostile);
  assert.equal(policy.sessionMode, 'build');
  assert.equal(policy.quotaAutoResume, false);
  assert.equal(policy.remote, 'disabled');
  assert.equal(policy.workflowOverride.mode, 'onDemand');
  assert.equal(policy.workflowOverride.source, 'override');
  assert.ok(policy.configPath.startsWith(home));
});

test('config isolation: disabled gate mode is provable too', async () => {
  const { home } = isolatedXdg({ workflowMode: 'disabled' });
  const policy = await snapshotEffectivePolicy(baseEnv({ XDG_CONFIG_HOME: home }));
  assert.equal(policy.workflowOverride.mode, 'disabled');
  assert.equal(policy.workflowOverride.enabled, false);
});

test('without the isolated file the ambient env WOULD leak (why isolation matters)', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'zcode-v3-xdg-empty-'));
  const policy = await snapshotEffectivePolicy(baseEnv({
    XDG_CONFIG_HOME: empty,
    ZCODE_ACP_QUOTA_AUTO_RESUME: '1',
    ZCODE_ACP_REMOTE: '1',
    ZCODE_ACP_REMOTE_TOKEN: 'token',
  }));
  assert.equal(policy.quotaAutoResume, true);
  assert.equal(policy.remote, 'enabled');
});

// ---------- workflow op adapter (stateful fake) ----------

function fakeServer({ cwd = 'C:\\work', sid = 'sess-acp', withCwd = true } = {}) {
  const cwds = new Map();
  if (withCwd) cwds.set(sid, cwd);
  return {
    resolveSid: id => (id === sid ? 'zsid-1' : undefined),
    sessionCwds: cwds,
    backend: { proc: { pid: 4242 }, isDead: false },
  };
}

/**
 * Stateful fake of upstream settings/workflow.js. Callback signatures mirror
 * upstream exactly: (server, ...) — server recorded so argument mismatches
 * fail loudly. stopWorkflowRun flips the run to a terminal native state;
 * resumeWorkflowRun flips it back to running.
 */
function statefulWorkflow(initialRuns, { onStop, onResume, onAmend } = {}) {
  const store = { runs: new Map(initialRuns.map(r => [r.runId, { ...r }])) };
  const calls = [];
  const wf = {
    calls, store,
    async conversationRuns(server, zcodeSid, limit) {
      assert.ok(server && typeof server.resolveSid === 'function', 'conversationRuns must receive the server');
      calls.push(['conversationRuns', server, zcodeSid, limit]);
      return { runs: [...store.runs.values()] };
    },
    async runEvents(server, zcodeSid, runId, afterSequence) {
      calls.push(['runEvents', server, zcodeSid, runId, afterSequence]);
      return { events: [{ sequence: (afterSequence ?? 0) + 1 }] };
    },
    async stopWorkflowRun(server, input) {
      calls.push(['stopWorkflowRun', server, input]);
      if (onStop) return onStop(store, input);
      store.runs.get(input.runId).status = 'cancelled';
      return { cancelled: true };
    },
    async amendRunSettings(server, input) {
      calls.push(['amendRunSettings', server, input]);
      if (onAmend) return onAmend(store, input);
      return { runId: input.runId, toolCallId: 'tc-1' };
    },
    async resumeWorkflowRun(server, input) {
      calls.push(['resumeWorkflowRun', server, input]);
      if (onResume) return onResume(store, input);
      store.runs.get(input.runId).status = 'running';
      return {};
    },
  };
  return wf;
}

function opsFor(server, wf) {
  return createWorkflowOps({ getServer: () => server, expectedCwd: 'C:\\work', workflow: wf });
}

test('unknown ops and arbitrary RPC are refused', async () => {
  const ops = opsFor(fakeServer(), statefulWorkflow([]));
  await assert.rejects(() => ops.handle('session/create', {}), /unsupported op/);
  await assert.rejects(() => ops.handle('v4/command', {}), /unsupported op/);
  await assert.rejects(() => ops.handle('', {}), /unsupported op/);
});

test('ops require a captured server, a known session and a matching cwd', async () => {
  const wf = statefulWorkflow([]);
  const noServer = createWorkflowOps({ getServer: () => null, expectedCwd: 'C:\\work', workflow: wf });
  await assert.rejects(() => noServer.handle('workflow-status', { sessionId: 'sess-acp' }),
    /bridge server not captured/);

  const ops = opsFor(fakeServer(), wf);
  await assert.rejects(() => ops.handle('workflow-status', { sessionId: 'stranger' }), /not owned by this bridge/);
  await assert.rejects(() => ops.handle('workflow-status', {}), /sessionId required/);
  await assert.rejects(() => opsFor(fakeServer({ withCwd: false }), wf)
    .handle('workflow-status', { sessionId: 'sess-acp' }), /cwd does not match/);
  await assert.rejects(() => opsFor(fakeServer({ cwd: 'D:\\elsewhere' }), wf)
    .handle('workflow-status', { sessionId: 'sess-acp' }), /cwd does not match/);
});

test('run ops enforce exact bound run ids AND run-session membership', async () => {
  const wf = statefulWorkflow([{ runId: 'run-1', status: 'completed', resumable: false }]);
  const ops = opsFor(fakeServer(), wf);
  await ops.handle('bind-run', { runId: 'run-1' });
  await assert.rejects(() => ops.handle('workflow-events', { sessionId: 'sess-acp', runId: 'run-2' }),
    /not bound to this invocation/);
  await assert.rejects(() => ops.handle('workflow-stop', { sessionId: 'sess-acp' }), /runId required/);

  // Bound but not a member of this session's run list.
  await ops.handle('bind-run', { runId: 'run-ghost' });
  await assert.rejects(() => ops.handle('workflow-events', { sessionId: 'sess-acp', runId: 'run-ghost' }),
    /not present in this session/);

  const events = await ops.handle('workflow-events', { sessionId: 'sess-acp', runId: 'run-1', afterSequence: 5 });
  assert.deepEqual(events, { events: [{ sequence: 6 }] });
  const eventsCall = wf.calls.find(c => c[0] === 'runEvents');
  assert.equal(eventsCall[1] instanceof Object, true, 'runEvents receives the server');
  assert.equal(eventsCall[2], 'zsid-1', 'runEvents receives the zcode session id');
  assert.equal(eventsCall[3], 'run-1');
  assert.equal(eventsCall[4], 5);
});

test('workflow-settings allows only maxConcurrency 1..4 and returns ack + run readback', async () => {
  const wf = statefulWorkflow([{ runId: 'run-1', status: 'running', resumable: false }]);
  const ops = opsFor(fakeServer(), wf);
  await ops.handle('bind-run', { runId: 'run-1' });
  const result = await ops.handle('workflow-settings', { sessionId: 'sess-acp', runId: 'run-1', maxConcurrency: 3 });
  assert.deepEqual(result.acknowledgement, { runId: 'run-1', toolCallId: 'tc-1' });
  assert.equal(result.run.runId, 'run-1');
  assert.equal(result.run.status, 'running', 'actual run state read back after the mutation');
  await assert.rejects(() => ops.handle('workflow-settings',
    { sessionId: 'sess-acp', runId: 'run-1', maxConcurrency: 0 }), /integer within 1\.\.4/);
  await assert.rejects(() => ops.handle('workflow-settings',
    { sessionId: 'sess-acp', runId: 'run-1', maxConcurrency: 9 }), /integer within 1\.\.4/);
  await assert.rejects(() => ops.handle('workflow-settings',
    { sessionId: 'sess-acp', runId: 'run-1', maxConcurrency: 2, subagentModel: 'GLM-5.3' }),
    /accepts only maxConcurrency/);
  await assert.rejects(() => ops.handle('workflow-settings',
    { sessionId: 'sess-acp', runId: 'run-1', maxConcurrency: 2, script: 'x' }),
    /accepts only maxConcurrency/);
  assert.equal(wf.calls.filter(c => c[0] === 'amendRunSettings').length, 1);
});

test('workflow-stop reads the terminal native state and reports the transition', async () => {
  const wf = statefulWorkflow([{ runId: 'run-1', status: 'running', resumable: false }]);
  const ops = opsFor(fakeServer(), wf);
  await ops.handle('bind-run', { runId: 'run-1' });
  const stopped = await ops.handle('workflow-stop', { sessionId: 'sess-acp', runId: 'run-1' });
  assert.equal(stopped.stopped, 'run-1');
  assert.equal(stopped.run.status, 'cancelled', 'post-stop state comes from the journal readback');
  assert.equal(stopped.alreadySettled, undefined);

  // Already settled: no stop command is issued, the read state is returned.
  const wf2 = statefulWorkflow([{ runId: 'run-2', status: 'completed', resumable: false }]);
  const ops2 = opsFor(fakeServer(), wf2);
  await ops2.handle('bind-run', { runId: 'run-2' });
  const settled = await ops2.handle('workflow-stop', { sessionId: 'sess-acp', runId: 'run-2' });
  assert.equal(settled.alreadySettled, true);
  assert.equal(settled.run.status, 'completed');
  assert.equal(wf2.calls.filter(c => c[0] === 'stopWorkflowRun').length, 0);

  // Accepted but never terminal: unknown_outcome, never a silent success.
  const wf3 = statefulWorkflow([{ runId: 'run-3', status: 'running', resumable: false }],
    { onStop: () => { /* accepted but state never changes */ } });
  const ops3 = opsFor(fakeServer(), wf3);
  await ops3.handle('bind-run', { runId: 'run-3' });
  await assert.rejects(() => ops3.handle('workflow-stop', { sessionId: 'sess-acp', runId: 'run-3' }),
    /terminal state not confirmed/);
});

test('workflow-resume allows stopped/cancelled/failed only when resumable, with readback', async () => {
  for (const status of ['stopped', 'cancelled', 'failed']) {
    const wf = statefulWorkflow([{ runId: 'run-1', status, resumable: true }]);
    const ops = opsFor(fakeServer(), wf);
    await ops.handle('bind-run', { runId: 'run-1' });
    const result = await ops.handle('workflow-resume', { sessionId: 'sess-acp', runId: 'run-1' });
    assert.equal(result.accepted, 'run-1');
    assert.equal(result.run.status, 'running', 'post-resume state read back');
  }
  for (const row of [{ status: 'running', resumable: false }, { status: 'completed', resumable: false },
    { status: 'stopped', resumable: false }, { status: 'failed', resumable: false },
    { status: 'pending', resumable: true }]) {
    const wf = statefulWorkflow([{ runId: 'run-1', ...row }]);
    const ops = opsFor(fakeServer(), wf);
    await ops.handle('bind-run', { runId: 'run-1' });
    await assert.rejects(() => ops.handle('workflow-resume', { sessionId: 'sess-acp', runId: 'run-1' }),
      /refusing to resume/);
  }
});

test('workflow-resume never replays a rejected attempt', async () => {
  const wf = statefulWorkflow([{ runId: 'run-1', status: 'stopped', resumable: true }],
    { onResume: () => { throw new Error('session_busy'); } });
  const ops = opsFor(fakeServer(), wf);
  await ops.handle('bind-run', { runId: 'run-1' });
  await assert.rejects(() => ops.handle('workflow-resume', { sessionId: 'sess-acp', runId: 'run-1' }),
    /session_busy/);
  assert.equal(wf.calls.filter(c => c[0] === 'resumeWorkflowRun').length, 1, 'exactly one attempt, no retry');
});

// ---------- notification boundary on the REAL upstream listener ----------

test('background notification boundary markers ride the real listener', async () => {
  installNotificationBoundaryPatch(BackgroundTaskListener);
  const sent = [];
  const server = {
    notifyByZcodeSid: async (sid, update) => { sent.push(update); return true; },
    notifyTurnActiveSince: new Map(),
    dispatchedToolCalls: new Map(),
    terminalSentData: new Map(),
    workflowRunNames: new Map(),
    backgroundListeners: new Map(),
    sessionAutoAllows: new Map(),
  };
  const listener = new BackgroundTaskListener(server, 'zsid-1');

  listener.handleEvent({ type: 'turn.started', turnId: 't1', payload: { inputSource: 'user' } });
  await flush();
  assert.equal(sent.length, 0, 'normal turns carry no boundary marker');

  listener.handleEvent({ type: 'turn.started', payload: { inputSource: 'background_task' } });
  await flush();
  assert.equal(sent.length, 0, 'missing native turn id must not start a phantom notification');

  listener.handleEvent({ type: 'turn.started', turnId: 't9', payload: { inputSource: 'background_task' } });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]._meta.codexZcodeBackgroundNotification.state, 'started');
  assert.equal(sent[0]._meta.codexZcodeBackgroundNotification.turnId, 't9');

  listener.handleEvent({ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'done: ok' } });
  await flush();
  assert.equal(sent.length, 2, 'the original forwarding still happens');
  assert.equal(sent[1].content.text, 'done: ok');

  listener.handleEvent({ type: 'turn.completed', turnId: 't9', payload: {} });
  await flush();
  const boundary = sent.at(-1)._meta.codexZcodeBackgroundNotification;
  assert.equal(boundary.state, 'completed');
  assert.equal(boundary.turnId, 't9');

  listener.handleEvent({ type: 'turn.started', turnId: 't10', payload: { inputSource: 'background_task' } });
  await flush();
  listener.handleEvent({ type: 'turn.failed', turnId: 't10', payload: {} });
  await flush();
  assert.equal(sent.at(-1)._meta.codexZcodeBackgroundNotification.state, 'failed');
});

// ---------- server capture + PID tracker ----------

test('stop races accept not_running only after authoritative terminal readback', async () => {
  for (const terminal of [true, false]) {
    const wf = statefulWorkflow([{ runId: 'run-1', status: 'running' }], {
      onStop: store => {
        if (terminal) store.runs.get('run-1').status = 'completed';
        throw Object.assign(new Error('not running'), { reason: 'not_running' });
      },
    });
    const ops = opsFor(fakeServer(), wf);
    await ops.handle('bind-run', { runId: 'run-1' });
    const result = ops.handle('workflow-stop', { sessionId: 'sess-acp', runId: 'run-1' });
    if (terminal) assert.equal((await result).run.status, 'completed');
    else await assert.rejects(() => result, /not running/);
  }
});

test('initialize hook captures the first server instance and stays transparent', async () => {
  class FakeServer {
    async initialize(params) { return { ok: true, params }; }
  }
  const getServer = captureServerViaInitialize(FakeServer);
  const a = new FakeServer();
  const result = await a.initialize({ x: 1 });
  assert.deepEqual(result, { ok: true, params: { x: 1 } });
  assert.equal(getServer(), a);
  new FakeServer();
  assert.equal(getServer(), a, 'only the first instance is captured');
});

test('PID tracker reports lifecycle, reader death (in place) and respawn over IPC', () => {
  const events = [];
  let server = { backend: { proc: { pid: 100 }, isDead: false } };
  let tick = () => {};
  const tracker = createPidTracker({
    getServer: () => server,
    send: m => events.push(m),
    intervalMs: 1000,
    setIntervalFn: (fn) => { tick = fn; return 1; },
    clearIntervalFn: () => {},
  });
  assert.deepEqual(events, [{ type: 'native_started', pid: 100 }]);

  // Reader death on the SAME backend object: no respawn noise, one event.
  server.backend.isDead = true;
  tick();
  assert.deepEqual(events.slice(1), [{ type: 'backend_dead', pid: 100 }]);
  tick();
  assert.equal(events.length, 2, 'dead reported once per generation');

  // Respawn: a genuinely NEW backend object swaps identity.
  server = { backend: { proc: { pid: 200 }, isDead: false } };
  tick();
  assert.deepEqual(events.slice(2), [
    { type: 'native_exited', pid: 100 },
    { type: 'native_started', pid: 200 },
  ]);
  assert.equal(server.backend.isDead, false);

  tracker.stop();
  server = { backend: { proc: { pid: 300 }, isDead: false } };
  tick();
  assert.equal(events.length, 4, 'stopped tracker stays silent');
});
