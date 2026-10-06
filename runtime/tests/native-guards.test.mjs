// Regression for the arrival guard (native-guards.mjs): upstream's
// orphan-session sweep can auto-allow workflow tools WITHOUT ever reaching the
// ACP client's permission path, so the backend's handleServerRequest is
// guarded at arrival with the same hash/model/run bindings the client policy
// uses. A tampered workflow must be denied here too, with a policy_denied IPC
// event, and compliant requests must pass through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installNativeGuards } from '../native-guards.mjs';

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
    }
    sendReply(id, result) { this.replies.push({ id, result }); }
  }
  FakeBackend.prototype.startWatchdog = function startWatchdog() {
    this.handled.push(['watchdog']);
  };
  FakeBackend.prototype.handleServerRequest = function handleServerRequest(req) {
    this.handled.push(['original', req.method]);
    return false;
  };
  return FakeBackend;
}

function install({ platform = 'win32' } = {}) {
  const Backend = makeBackend();
  const events = [];
  installNativeGuards(Backend, {
    send: m => events.push(m),
    request: BINDINGS,
    isPermissionRequest: method => method === 'interaction/requestPermission',
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
  assert.deepEqual(backend.replies, [{ id: 7, result: { decision: 'deny', reason: 'Controller workflow binding mismatch' } }]);
  assert.deepEqual(events, [{ type: 'policy_denied', toolName: 'CreateWorkflow', reason: 'Controller workflow binding mismatch' }]);
  assert.deepEqual(backend.handled, [], 'upstream handler never sees the denied request');
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
