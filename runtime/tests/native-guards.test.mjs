// Regression for the arrival guard (native-guards.mjs): upstream's
// orphan-session sweep can auto-allow workflow tools WITHOUT ever reaching the
// ACP client's permission path, so the backend's handleServerRequest is
// guarded at arrival with the same hash/model/run bindings the client policy
// uses. A tampered workflow must be denied here too, with a policy_denied IPC
// event, and compliant requests must pass through untouched. Also covers the
// 0.85.3 tool-policy contract: backend params stay verbatim (toolDenylist
// rides create/resume only, upstream-owned), a backend rejecting toolDenylist
// is reported as degraded policy, and the review allowlist denies unlisted
// tools at the permission boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installNativeGuards } from '../native-guards.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

const script = 'name: demo\nsteps:\n  - uses: echo\n';
const sha = createHash('sha256').update(script).digest('hex');
const BINDINGS = {
  approvedWorkflowSha256: sha,
  approvedWorkflowModel: 'GLM-5.3-Flash',
  workflowRunId: 'run-exact',
};

function makeBackend() {
  class FakeBackend {
    constructor() {
      this.proc = { pid: 777, once: () => {} };
      this.replies = [];
      this.handled = [];
      this.notifications = [];
    }
    sendReply(id, result) { this.replies.push({ id, result }); }
    request(...args) { this.handled.push(args); return 'rpc-result'; }
  }
  FakeBackend.prototype.startWatchdog = function startWatchdog() {
    this.handled.push(['watchdog']);
  };
  FakeBackend.prototype.handleNotification = function handleNotification(method, params) {
    this.notifications.push([method, params]);
  };
  FakeBackend.prototype.handleServerRequest = function handleServerRequest(req) {
    this.handled.push(['original', req.method]);
    return false;
  };
  return FakeBackend;
}

function install({ platform = 'win32', disallowedTools = [], nativeToolAllowlist,
  mapNativeSession = null } = {}) {
  const Backend = makeBackend();
  const events = [];
  installNativeGuards(Backend, {
    send: m => events.push(m),
    request: { ...BINDINGS, disallowedTools, nativeToolAllowlist },
    isPermissionRequest: method => method === 'interaction/requestPermission',
    mapNativeSession,
    platform,
  });
  return { Backend, events };
}

test('a tampered workflow script is denied at arrival, before any auto-allow', () => {
  const { Backend, events } = install();
  const backend = new Backend();
  const consumed = backend.handleServerRequest({
    id: 7,
    method: 'interaction/requestPermission',
    params: { toolName: 'CreateWorkflow', input: { script: `${script}#tampered`, subagent_model: 'GLM-5.3-Flash' } },
  });
  assert.equal(consumed, true, 'the guard consumes the request');
  assert.deepEqual(backend.replies, [{ id: 7, result: { decision: 'deny', reason: 'Controller workflow binding mismatch: workflow script/model/args/model_bindings mismatch' } }]);
  assert.deepEqual(events, [{ type: 'policy_denied', toolName: 'CreateWorkflow', reason: 'Controller workflow binding mismatch: workflow script/model/args/model_bindings mismatch' }]);
  assert.deepEqual(backend.handled, [], 'upstream handler never sees the denied request');
});

test('session/send keeps upstream params verbatim; create/resume carry the pinned review toolAllowlist', () => {
  // 0.85.3: the per-turn toolDenylist on session/send is only a
  // provider-visibility hint, and a list holding every Cron mutation tool is
  // the backend's automation-turn signal. Ordinary prompts must not carry it.
  // toolAllowlist however IS a native create/resume field (0.17.1 strict
  // schema, consumed by the runtime registry) — the review pin rides there.
  const { Backend } = install({ disallowedTools: ['Bash', 'Edit', 'CronCreate', 'CronDelete'],
    nativeToolAllowlist: ['Read', 'Grep', 'Glob'] });
  const backend = new Backend();
  const params = { sessionId: 's', content: 'review' };
  assert.equal(backend.request(1, 'session/send', params, 123), 'rpc-result');
  assert.deepEqual(backend.handled[0], [1, 'session/send', params, 123]);
  assert.equal('toolDenylist' in backend.handled[0][2], false, 'no denylist spoofing the automation-turn signal');
  const create = { cwd: 'example', toolDenylist: ['Bash', 'CronCreate'] };
  backend.request(2, 'session/create', create, 456);
  assert.deepEqual(backend.handled[1][2], { ...create, toolAllowlist: ['Read', 'Grep', 'Glob'] });
  assert.strictEqual(create.toolAllowlist, undefined, 'caller input is not mutated');
  backend.request(3, 'session/resume', { sessionId: 's', toolAllowlist: ['Read', 'Bash'] }, 789);
  assert.deepEqual(backend.handled[2][2].toolAllowlist, ['Read'], 'a caller-provided allowlist is intersected, never widened');
});

test('a backend rejecting toolDenylist on create/resume reports the degraded policy once', async () => {
  for (const message of ['Unrecognized key: toolDenylist', 'Unrecognized key: "toolDenylist" at line 1']) {
    const Backend = makeBackend();
    Backend.prototype.request = async (id, method) => ({
      id,
      error: { message: method === 'session/send' ? 'busy' : message },
    });
    const events = [];
    installNativeGuards(Backend, {
      send: m => events.push(m),
      request: { ...BINDINGS, disallowedTools: ['Bash'] },
      isPermissionRequest: method => method === 'interaction/requestPermission',
    });
    const backend = new Backend();
    await backend.request(1, 'session/create', { cwd: 'x', toolDenylist: ['Bash'] });
    await backend.request(2, 'session/resume', { sessionId: 's', toolDenylist: ['Bash'] });
    await backend.request(3, 'session/send', { sessionId: 's', content: 'hi' });
    assert.deepEqual(events.filter(e => e.type === 'tool_policy_degraded'), [{
      type: 'tool_policy_degraded',
      reason: 'backend rejects toolDenylist; ZCODE_DISALLOWED_TOOLS / the Cron* defaults are NOT applied on this backend',
    }], `reported once for ${message}, and never for session/send`);
  }
});

test('steer session events are forwarded slim: native sid mapped to ACP aliases, full-text hashed', () => {
  // The ACP sid (what the runner knows) differs from the native backend sid
  // (what session/event carries) — the guard maps through the captured
  // server's reverse index, exactly as bridge.mjs wires it.
  const { Backend, events } = install({
    mapNativeSession: sid => (sid === 'sess-native-1' ? ['sess-acp-1', 'sess-acp-2'] : []),
  });
  const backend = new Backend();
  backend.handleNotification('session/event', {
    sessionId: 'sess-native-1', seq: 7, type: 'turn.steerQueued',
    payload: { pendingInputId: 'pi-1', inputPreview: 'course correct', delivery: 'queue',
      targetTurnId: 'turn-9', queueLength: 1 },
  });
  backend.handleNotification('session/event', {
    sessionId: 'sess-native-1', seq: 8, type: 'turn.steerDrained',
    payload: { pendingInputIds: ['pi-1'], targetTurnId: 'turn-9', injectedMessageIds: ['m-1'],
      drainedInputs: [{ pendingInputId: 'pi-1', messageId: 'm-1', text: 'course correct' }] },
  });
  backend.handleNotification('session/event', {
    sessionId: 'sess-native-other', seq: 9, type: 'turn.steerDrained',
    payload: { pendingInputIds: ['pi-x'], targetTurnId: 'turn-x',
      drainedInputs: [{ pendingInputId: 'pi-x', messageId: 'm-x', text: 'foreign session' }] },
  });
  backend.handleNotification('session/event', { sessionId: 's', type: 'turn.completed', payload: {} });
  backend.handleNotification('state.updated', { sessionId: 's' });
  assert.deepEqual(events.filter(e => e.type === 'steer_event'), [
    { type: 'steer_event', kind: 'steerQueued', nativeSessionId: 'sess-native-1',
      acpSessionIds: ['sess-acp-1', 'sess-acp-2'],
      payload: { pendingInputId: 'pi-1', inputPreview: 'course correct', delivery: 'queue',
        targetTurnId: 'turn-9', queueLength: 1 } },
    { type: 'steer_event', kind: 'steerDrained', nativeSessionId: 'sess-native-1',
      acpSessionIds: ['sess-acp-1', 'sess-acp-2'],
      payload: { pendingInputIds: ['pi-1'], targetTurnId: 'turn-9',
        drainedInputs: [{ pendingInputId: 'pi-1', messageId: 'm-1',
          textSha256: sha256('course correct'), text: 'course correct' }] } },
    { type: 'steer_event', kind: 'steerDrained', nativeSessionId: 'sess-native-other',
      acpSessionIds: [], payload: { pendingInputIds: ['pi-x'], targetTurnId: 'turn-x',
        drainedInputs: [{ pendingInputId: 'pi-x', messageId: 'm-x',
          textSha256: sha256('foreign session'), text: 'foreign session' }] } },
  ], 'foreign sessions forward an empty alias list the runner will reject');
  assert.equal(backend.notifications.length, 5, 'upstream notification handling still runs for every event');
});

test('independent review allowlist denies unlisted tools at the permission boundary', () => {
  const { Backend, events } = install({ disallowedTools: ['Bash'], nativeToolAllowlist: ['Read', 'Grep', 'Glob'] });
  const backend = new Backend();
  assert.equal(backend.handleServerRequest({ id: 11, method: 'interaction/requestPermission',
    params: { toolName: 'WebSearch', input: {} } }), true);
  assert.deepEqual(backend.replies[0].result, { decision: 'deny', reason: 'Tool outside the controller allowlist: WebSearch' });
  assert.equal(events[0].type, 'policy_denied');
  assert.equal(backend.handled.length, 0, 'upstream handler never sees the denied request');
  assert.equal(backend.handleServerRequest({ id: 12, method: 'interaction/requestPermission',
    params: { toolName: 'Read', input: { file_path: 'x' } } }), false, 'allowlisted read tools pass through to the normal path');
});

test('disabled tools are denied at the native permission arrival boundary', () => {
  const { Backend, events } = install({ disallowedTools: ['Bash'] });
  const backend = new Backend();
  assert.equal(backend.handleServerRequest({ id: 9, method: 'interaction/requestPermission',
    params: { toolName: 'Bash', input: { command: 'echo no' } } }), true);
  assert.equal(backend.replies[0].result.decision, 'deny');
  assert.equal(events[0].type, 'policy_denied');
  assert.equal(backend.handled.length, 0);
});

test('an incompatible upstream request hook fails closed', () => {
  const Backend = makeBackend();
  Backend.prototype.request = undefined;
  assert.throws(() => installNativeGuards(Backend, { request: {}, send() {} }), /request hook unavailable/);
});

test('model substitution and unbound resume ids are denied at arrival', () => {
  const { Backend, events } = install();
  const backend = new Backend();
  assert.equal(backend.handleServerRequest({
    id: 8, method: 'interaction/requestPermission',
    params: { toolName: 'AmendWorkflow', input: { script, subagent_model: 'GLM-5.3' } },
  }), true);
  assert.equal(backend.handleServerRequest({
    id: 9, method: 'interaction/requestPermission',
    params: { toolName: 'ResumeWorkflowRun', input: { run_id: 'run-other' } },
  }), true);
  assert.equal(backend.replies.length, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].toolName, 'ResumeWorkflowRun');
});

test('compliant workflow requests and ordinary asks pass through untouched', () => {
  const { Backend, events } = install();
  const backend = new Backend();
  const passthrough = (id, params) => backend.handleServerRequest({
    id, method: 'interaction/requestPermission', params,
  });
  assert.equal(passthrough(1, { toolName: 'CreateWorkflow', input: { script, subagent_model: 'GLM-5.3-Flash' } }), false);
  assert.equal(passthrough(2, { toolName: 'AmendWorkflow', input: { script, subagent_model: 'GLM-5.3-Flash', run_id: 'run-exact' } }), false);
  assert.equal(passthrough(3, { toolName: 'ResumeWorkflowRun', input: { run_id: 'run-exact' } }), false);
  assert.equal(passthrough(4, { toolName: 'Bash', input: { command: 'ls' } }), false);
  // Non-permission server requests (e.g. runtime preferences) pass through too.
  assert.equal(backend.handleServerRequest({ id: 5, method: 'session/requestRuntimePreferences', params: {} }), false);
  assert.deepEqual(backend.replies, []);
  assert.deepEqual(events, []);
  assert.equal(backend.handled.filter(c => c[0] === 'original').length, 5);
});

test('startWatchdog reports the native pid over IPC; POSIX keeps the upstream watchdog', () => {
  const win = install({ platform: 'win32' });
  const winBackend = new win.Backend();
  winBackend.startWatchdog();
  assert.deepEqual(win.events, [{ type: 'native_started', pid: 777 }]);
  assert.deepEqual(winBackend.handled, [], 'Windows suppresses the POSIX negative-pid watchdog');

  const posix = install({ platform: 'linux' });
  const posixBackend = new posix.Backend();
  posixBackend.startWatchdog();
  assert.deepEqual(posix.events, [{ type: 'native_started', pid: 777 }]);
  assert.deepEqual(posixBackend.handled, [['watchdog']], 'POSIX delegates to the upstream watchdog');
});
