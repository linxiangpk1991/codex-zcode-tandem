// Protocol-level tests for the runner using a fully offline, in-memory fake
// transport (same surface as transport.spawnTransport: spawn({onEvent}) wires
// the event callback and emits the effective policy asynchronously, because
// the runner registers handlers after spawn resolves). No network, no native
// spawn, no inference. Covers: serialized steering, pause (incl. bound
// workflow stop with state readback), strict answer handling for ordinary
// questions, plan-approval denial, permission denials, end_turn/requiredTools
// gating, notification-required background settle, deadline, policy proof,
// probe/quota/workflow actions, early result persistence, replay separation,
// the policy_denied arrival-guard event and native PID tracking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { buildConfig } from '../config.mjs';
import { normalizeRequest } from '../request.mjs';
import { assertPolicyProof, runTask } from '../runner.mjs';
import { writeJsonAtomic, readJsonFile } from '../jsonio.mjs';

const CONFIG = buildConfig({
  inboxPollMs: 25, heartbeatMs: 1000, gracefulCancelWaitMs: 400, bridgeIpcTimeoutMs: 2000,
}, {});
const DISABLED_POLICY = {
  configPath: 'C:\\tmp\\xdg\\zcode-acp\\config.json',
  sessionMode: 'build',
  quotaAutoResume: false,
  remote: 'disabled',
  workflowOverride: { mode: 'disabled', enabled: false, source: 'override' },
};
const ONDEMAND_POLICY = {
  ...DISABLED_POLICY,
  workflowOverride: { mode: 'onDemand', enabled: true, source: 'override' },
};

class FakeTransport {
  constructor({ policy = DISABLED_POLICY, script = [], workflowRuns = [], ipcHandlers = {} } = {}) {
    this.policy = policy;
    this.script = script;
    this.workflowRuns = workflowRuns;
    this.ipcHandlers = ipcHandlers;
    this.handlers = {};
    this.pid = 999_999;
    this.child = { exitCode: null };
    this.spawnOpts = null;
    this.onEventSink = null;
    this.ipcOps = [];
    this.promptLog = [];
    this.pending = [];
    this.inFlight = 0;
    this.cancelCount = 0;
    this.initializeCalls = 0;
    this.disposed = false;
    this.conn = {
      initialize: async () => {
        this.initializeCalls += 1;
        return { agentInfo: { name: 'zcode-acp-server', version: '0.65.1' } };
      },
      newSession: async () => ({ sessionId: 'sess-1', modes: [], configOptions: [] }),
      resumeSession: async () => ({ modes: [], configOptions: [] }),
      setSessionConfigOption: async ({ configId, value }) =>
        ({ configOptions: [{ id: configId, currentValue: value }] }),
      extMethod: async method => ({ method }),
      cancel: async () => { this.cancelCount += 1; },
      prompt: params => {
        if (this.inFlight > 0) return Promise.reject(new Error('concurrent prompt detected'));
        this.inFlight += 1;
        const index = this.promptLog.length;
        this.promptLog.push(params.prompt[0].text);
        const behavior = this.script[index] ?? 'end_turn';
        if (behavior === 'hold') {
          return new Promise((resolve, reject) => {
            this.pending.push({
              index,
              resolve: v => { this.inFlight -= 1; resolve(v); },
              reject: e => { this.inFlight -= 1; reject(e); },
            });
          });
        }
        this.inFlight -= 1;
        return Promise.resolve({ stopReason: behavior });
      },
    };
  }

  /** The spawnTransport seam: wire onEvent and emit the policy asynchronously. */
  spawn(opts) {
    this.spawnOpts = opts;
    this.onEventSink = opts.onEvent;
    setTimeout(() => this.onEventSink?.({ type: 'policy', policy: this.policy }), 0);
    return Promise.resolve(this);
  }

  on(handler) { Object.assign(this.handlers, handler); }
  emitEvent(message) { this.onEventSink?.(message); }
  emitUpdate(update) { this.handlers.sessionUpdate?.(update); }
  emitPermission(p) { return this.handlers.requestPermission(p); }
  resolvePrompt(text, stopReason = 'end_turn') {
    const entry = this.pending.find(e => this.promptLog[e.index] === text) ?? this.pending[0];
    if (entry) entry.resolve({ stopReason });
  }
  async ipcCall(op, payload) {
    this.ipcOps.push([op, payload]);
    const handler = this.ipcHandlers[op]
      ?? {
        'bind-run': async () => ({ bound: [] }),
        'workflow-status': async () => ({ runs: this.workflowRuns }),
        'workflow-stop': async ({ runId }) => ({ stopped: runId, run: { runId, status: 'cancelled' } }),
        'workflow-resume': async ({ runId }) => ({ accepted: runId, run: { runId, status: 'running' } }),
      }[op];
    if (!handler) throw new Error(`no handler for ${op}`);
    return handler(payload);
  }
  stderr() { return ''; }
  waitExit() { return Promise.resolve({ code: 0, signal: null }); }
  async dispose() {
    this.disposed = true;
    this.child.exitCode = 0;
    for (const entry of this.pending.splice(0)) entry.reject(new Error('transport disposed'));
    return { code: 0, signal: null };
  }
}

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'zcode-v3-runner-'));
}

function beginRun({ raw, fakeOpts = {}, invocationId }) {
  const dir = makeTemp();
  const id = invocationId ?? `inv-${randomUUID().slice(0, 8)}`;
  const request = normalizeRequest(CONFIG, {
    cwd: dir,
    progressFile: join(dir, 'PROGRESS.json'),
    resultFile: join(dir, 'RESULT.json'),
    ...raw,
  });
  const fake = new FakeTransport(fakeOpts);
  const task = runTask({
    request, config: CONFIG, cwd: dir, invocationId: id,
    deps: {
      spawnTransport: opts => fake.spawn(opts),
      cleanupOwnedPids: () => [],
      nativeCliVersion: async () => ({ version: '3.9.9' }),
      identityRoot: dir,
    },
  });
  return { fake, task, dir, invocationId: id, request,
    progressPath: join(dir, 'PROGRESS.json'), resultPath: join(dir, 'RESULT.json') };
}

function writeControl(dir, invocationId, action, payload, overrides = {}) {
  writeJsonAtomic(join(dir, CONFIG.inboxDirName, invocationId, `cmd-${randomUUID().slice(0, 12)}.json`), {
    id: `cmd-${randomUUID().slice(0, 8)}`,
    invocationId, action, payload,
    createdAt: new Date().toISOString(),
    source: { progressUpdatedAt: null },
    ...overrides,
  });
}

async function waitFor(cond, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

function askQuestion(fake, toolCallId, title, options) {
  fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId, title,
    _meta: { claudeCode: { toolName: 'AskUserQuestion' } },
  });
  return fake.emitPermission({ options, toolCall: { toolCallId, title, rawInput: {} } });
}

// ---------- phases, steering serialization ----------

test('phase prompts run serialized; a steer interleaves before remaining prompts', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2', 'p3'] },
    fakeOpts: { script: ['hold'] },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run.dir, run.invocationId, 'steer', { message: 'steer-1' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1, 3000, 'steer queued');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode, report } = await run.task;
  assert.deepEqual(run.fake.promptLog, ['p1', 'steer-1', 'p2', 'p3']);
  assert.equal(exitCode, 0);
  assert.equal(report.status, 'completed');
  const steer = report.controls.find(c => c.action === 'steer');
  assert.equal(steer.state, 'completed');
  assert.match(steer.detail, /end_turn/);
  assert.ok(steer.submittedAt && steer.acceptedAt && steer.startedAt && steer.completedAt);
  assert.ok(steer.queueDurationMs >= 0 && steer.executionDurationMs >= 0);
  assert.equal(report.verification.outcome, 'not_run', 'end_turn alone is not test acceptance');
});

// ---------- pause ----------

test('pause mid-turn cancels the foreground turn, skips later prompts, exits paused', async () => {
  const run = beginRun({ raw: { prompts: ['p1', 'p2'] }, fakeOpts: { script: ['hold', 'end_turn'] } });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  writeControl(run.dir, run.invocationId, 'steer', { message: 'never-runs' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1, 3000, 'steer queued');
  writeControl(run.dir, run.invocationId, 'pause', {});
  await waitFor(() => run.fake.cancelCount === 1, 3000, 'cancel');
  run.fake.resolvePrompt('p1', 'cancelled');
  const { exitCode, report } = await run.task;
  assert.equal(run.fake.promptLog.length, 1, 'p2 must not run after pause');
  assert.equal(exitCode, 3);
  assert.equal(report.status, 'paused');
  assert.equal(report.sessionId, 'sess-1');
  const steer = report.controls.find(c => c.action === 'steer');
  assert.equal(steer.state, 'rejected');
  assert.equal(steer.startedAt, undefined, 'unexecuted queued work stays unstarted');
  const pause = report.controls.find(c => c.action === 'pause' && c.state === 'completed');
  assert.ok(pause, 'pause control completed');
});

test('pause stops only the bound active workflow via the bridge IPC readback', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: { script: ['hold'], policy: ONDEMAND_POLICY },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'first prompt');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'cw1', title: 'CreateWorkflow: demo',
    status: 'completed', _meta: { claudeCode: { toolName: 'CreateWorkflow' } },
  });
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'cw1',
    _meta: { workflowRun: { runId: 'run-7', sequence: 1 } },
  });
  await waitFor(() => run.fake.ipcOps.some(([op]) => op === 'bind-run'), 3000, 'bind-run');
  writeControl(run.dir, run.invocationId, 'pause', {});
  await waitFor(() => run.fake.cancelCount === 1, 3000, 'cancel');
  run.fake.resolvePrompt('p1', 'cancelled');
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 3);
  const stop = run.fake.ipcOps.find(([op]) => op === 'workflow-stop');
  assert.ok(stop, 'workflow-stop issued');
  assert.equal(stop[1].runId, 'run-7');
  assert.equal(stop[1].sessionId, 'sess-1');
  assert.equal(report.workflow.runs['run-7'], 'cancelled', 'tracker adopts the stopped run state');
});

// ---------- answers: ordinary questions only, exact options ----------

test('amendment binds predecessor before prompting and reconciles a successor card arriving first', async () => {
  const script = 'verified amendment';
  const run = beginRun({
    raw: { prompts: ['amend'], waitForBackground: true, sessionId: 'sess-1', workflowRunId: 'dwfrun-old',
      approvedWorkflowSha256: createHash('sha256').update(script).digest('hex'),
      approvedWorkflowModel: 'account:bigmodel-individual-coding-plan/GLM-5.3$max' },
    fakeOpts: { script: ['hold'], policy: ONDEMAND_POLICY,
      workflowRuns: [{ runId: 'dwfrun-old', status: 'stopped', resumable: true }] },
  });
  await waitFor(() => run.fake.promptLog.length === 1);
  assert.ok(run.fake.ipcOps.some(([op, p]) => op === 'bind-run' && p.runId === 'dwfrun-old'));
  run.fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'bg-new', status: 'running',
    _meta: { backgroundTask: { taskId: 'dwfrun-new' } } });
  run.fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'amend', title: 'AmendWorkflow',
    rawInput: { script, subagent_model: 'GLM-5.3$max', run_id: 'dwfrun-old' },
    _meta: { claudeCode: { toolName: 'AmendWorkflow' } } });
  run.fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'late-old', status: 'running',
    _meta: { backgroundTask: { taskId: 'dwfrun-old' } } });
  writeControl(run.dir, run.invocationId, 'pause', {});
  await waitFor(() => run.fake.cancelCount === 1);
  run.fake.resolvePrompt('amend', 'cancelled');
  const { report } = await run.task;
  assert.deepEqual(report.workflowRunIds, ['dwfrun-new']);
  assert.equal(report.workflow.predecessorRunId, 'dwfrun-old');
  assert.equal(report.workflowObservations[0].matched, true);
  assert.deepEqual(run.fake.ipcOps.filter(([op]) => op === 'workflow-stop').map(([, p]) => p.runId), ['dwfrun-new']);
});

test('a question stays pending through an invalid answer, then a valid exact answer resolves it', async () => {
  const run = beginRun({ raw: { prompts: ['p1'] }, fakeOpts: { script: ['hold'] } });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  const question = askQuestion(run.fake, 'q1', 'Which color?', [
    { optionId: 'red', kind: 'allow_once', name: 'red' },
    { optionId: '__skip__', kind: 'reject_once', name: 'Skip' },
  ]);
  await waitFor(() => readJsonFile(run.progressPath)?.pendingInput?.interactionId === 'q1', 3000, 'pendingInput');

  // Invalid optionId: control rejected, question REMAINS pending.
  writeControl(run.dir, run.invocationId, 'answer', { interactionId: 'q1', optionId: 'green' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.history?.some(
    c => c.action === 'answer' && c.state === 'rejected'), 3000, 'invalid answer rejected');
  assert.equal(readJsonFile(run.progressPath).pendingInput.interactionId, 'q1',
    'question must remain pending after an invalid answer');

  // A stale interactionId is rejected too.
  writeControl(run.dir, run.invocationId, 'answer', { interactionId: 'q-old', optionId: 'red' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.history?.filter(
    c => c.action === 'answer' && c.state === 'rejected').length === 2, 3000, 'stale answer rejected');
  assert.equal(readJsonFile(run.progressPath).pendingInput.interactionId, 'q1');

  // Now the exact offered option resolves the SAME question.
  writeControl(run.dir, run.invocationId, 'answer', { interactionId: 'q1', optionId: 'red' });
  const outcome = await question;
  assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'red' } });
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 0);
  const answers = report.controls.filter(c => c.action === 'answer');
  assert.equal(answers.filter(c => c.state === 'rejected').length, 2);
  const done = answers.find(c => c.state === 'completed');
  assert.ok(done);
  assert.match(done.detail, /q1 with red/);
  assert.equal(report.pendingInput, null);
});

test('plan approval is denied, recorded, and NOT answerable through the generic answer action', async () => {
  const run = beginRun({ raw: { prompts: ['p1'] }, fakeOpts: { script: ['hold'] } });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'Exit plan mode',
    _meta: { claudeCode: { toolName: 'ExitPlanMode' } },
  });
  const approval = run.fake.emitPermission({
    options: [{ optionId: 'approve', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }],
    toolCall: { toolCallId: 'p1', title: 'Exit plan mode', rawInput: { plan: 'do things' } },
  });
  const outcome = await approval; // decided immediately: denied headless
  assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
  await waitFor(() => readJsonFile(run.progressPath)?.pendingInput?.kind === 'plan_approval', 3000, 'plan pendingInput');
  writeControl(run.dir, run.invocationId, 'answer', { interactionId: 'p1', optionId: 'approve' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.history?.some(
    c => c.action === 'answer' && c.state === 'rejected'), 3000, 'answer on plan approval rejected');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode, report } = await run.task;
  assert.equal(report.status, 'needs_attention', 'plan approval denial needs attention');
  assert.equal(exitCode, 1);
});

// ---------- permission denials ----------

test('a denied tool grant sets needs_attention and blocks remaining prompts', async () => {
  const run = beginRun({
    raw: { prompts: ['p1', 'p2'], allowToolKinds: ['read'] },
    fakeOpts: { script: ['hold', 'end_turn'] },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash: rm -rf',
    kind: 'execute', _meta: { claudeCode: { toolName: 'Bash' } },
  });
  const grant = run.fake.emitPermission({
    options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    toolCall: { toolCallId: 't1', title: 'Bash: rm -rf', rawInput: { command: 'rm -rf x' } },
  });
  const outcome = await grant;
  assert.equal(outcome.outcome.optionId, 'deny');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 1);
  assert.equal(report.status, 'needs_attention');
  assert.equal(run.fake.promptLog.length, 1, 'p2 must not run after a denial');
  assert.equal(report.needsAttention, true);
  assert.equal(report.permissions[0].allowed, false);
  assert.match(report.permissions[0].reason, /kind execute not allowed/);
});

test('unknown tools are denied even when the ACP kind is allowlisted', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], allowToolKinds: ['read', 'edit', 'execute', 'search'] },
    fakeOpts: { script: ['hold'] },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'u1', title: 'TotallySafeTool: payload',
    kind: 'execute', _meta: { claudeCode: { toolName: 'TotallySafeTool' } },
  });
  const grant = run.fake.emitPermission({
    options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    toolCall: { toolCallId: 'u1', title: 'TotallySafeTool: payload', rawInput: {} },
  });
  const outcome = await grant;
  assert.equal(outcome.outcome.outcome, 'selected');
  assert.equal(outcome.outcome.optionId, 'deny');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.equal(report.permissions[0].reason, 'unknown tool — denied');
  assert.equal(report.status, 'needs_attention');
});

// ---------- success gating ----------

test('non-end_turn stop reasons fail the run; missing required tools fail too', async () => {
  const refused = beginRun({ raw: { prompts: ['p1'] }, fakeOpts: { script: ['refusal'] } });
  const refusedResult = await refused.task;
  assert.equal(refusedResult.exitCode, 1);
  assert.match(refusedResult.report.error, /Turn ended: refusal/);

  const missing = beginRun({ raw: { prompts: [{ text: 'p1', requiredTools: ['Bash'] }] } });
  const missingResult = await missing.task;
  assert.equal(missingResult.exitCode, 1);
  assert.match(missingResult.report.error, /Required tool not completed/);
});

test('a completed required tool within the turn passes the gate', async () => {
  const run = beginRun({
    raw: { prompts: [{ text: 'p1', requiredTools: ['Bash'] }], allowToolKinds: ['execute'],
      workspace: { ownedPaths: [], preservedPaths: [], commands: ['npm test'] } },
    fakeOpts: { script: ['hold'] },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'b1', title: 'Bash: npm test',
    rawInput: { command: 'npm test' },
    kind: 'execute', _meta: { claudeCode: { toolName: 'Bash' } },
  });
  run.fake.emitUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed' });
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode } = await run.task;
  assert.equal(exitCode, 0);
});

test('observed unapproved shell without a permission callback requires attention', async () => {
  const run = beginRun({ raw: { prompts: ['p1', 'must-not-run'], allowToolKinds: ['execute'],
    workspace: { ownedPaths: [], preservedPaths: [], commands: ['git status --short'] } }, fakeOpts: { script: ['hold'] } });
  await waitFor(() => run.fake.promptLog.length === 1);
  run.fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'uncalled', title: 'Bash', status: 'completed',
    _meta: { claudeCode: { toolName: 'Bash' } }, rawInput: { command: 'git stash push' } });
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.equal(report.status, 'needs_attention');
  assert.equal(run.fake.promptLog.length, 1);
  assert.equal(report.workspaceObservations[0].postHoc, true);
  assert.equal(report.summary.observedPolicyViolations, 1);
});

test('deadline cancellation returned by native prompt remains timeout, not generic failure', async () => {
  const run = beginRun({ raw: { prompts: ['p1'], timeoutSeconds: 1 }, fakeOpts: { script: ['hold'] } });
  run.fake.conn.cancel = async () => run.fake.resolvePrompt('p1', 'cancelled');
  const { report, exitCode } = await run.task;
  assert.equal(report.status, 'timeout');
  assert.equal(exitCode, 2);
});

test('deadline resolving as end_turn cannot launch the next phase', async () => {
  const run = beginRun({ raw: { prompts: ['p1', 'never'], timeoutSeconds: 1 }, fakeOpts: { script: ['hold'] } });
  run.fake.conn.cancel = async () => run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.equal(report.status, 'timeout');
  assert.deepEqual(run.fake.promptLog, ['p1']);
});

test('deadline in a steer cannot dispatch a second queued steer', async () => {
  const run = beginRun({ raw: { prompts: ['p1'], timeoutSeconds: 1 }, fakeOpts: { script: ['hold', 'hold'] } });
  run.fake.conn.cancel = async () => run.fake.resolvePrompt('s1', 'end_turn');
  await waitFor(() => run.fake.promptLog.length === 1);
  writeControl(run.dir, run.invocationId, 'steer', { message: 's1' });
  writeControl(run.dir, run.invocationId, 'steer', { message: 's2' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 2);
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.equal(report.status, 'timeout');
  assert.deepEqual(run.fake.promptLog, ['p1', 's1']);
});

test('control submitted before closing is explicitly rejected when it never reached a boundary', async () => {
  const run = beginRun({ raw: { prompts: ['p1'] } });
  run.fake.conn.prompt = async () => {
    writeControl(run.dir, run.invocationId, 'steer', { message: 'too late' });
    const progress = readJsonFile(run.progressPath);
    writeJsonAtomic(join(progress.controlInbox, 'foreign-at-close.json'), { id: 'foreign-at-close', invocationId: 'other' });
    return { stopReason: 'end_turn' };
  };
  const { report } = await run.task;
  assert.equal(report.controls.find(c => c.action === 'steer').state, 'rejected');
  assert.equal(report.controls.find(c => c.id === 'skipped:foreign-at-close').state, 'rejected');
});

test('foreign duplicate id cannot overwrite the lifecycle of a queued steer', async () => {
  const run = beginRun({ raw: { prompts: ['p1'] }, fakeOpts: { script: ['hold'] } });
  await waitFor(() => run.fake.promptLog.length === 1);
  writeControl(run.dir, run.invocationId, 'steer', { message: 'valid steer' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1);
  const progress = readJsonFile(run.progressPath), id = progress.controls.queue[0].id;
  writeJsonAtomic(join(progress.controlInbox, 'foreign.json'), { id, invocationId: 'foreign', action: 'steer',
    createdAt: new Date().toISOString(), payload: { message: 'bad' } });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.history?.some(c => c.id === `skipped:${id}`));
  assert.equal(readJsonFile(run.progressPath).controls.queue[0].id, id);
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await run.task;
  assert.equal(report.controls.find(c => c.id === id).state, 'completed');
});

// ---------- background settle: notification REQUIRED ----------

function launchWorkflow(fake) {
  fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'cw1', title: 'CreateWorkflow: demo',
    status: 'completed', _meta: { claudeCode: { toolName: 'CreateWorkflow' } },
  });
  fake.emitUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'cw1',
    _meta: { workflowRun: { runId: 'run-7', sequence: 1 } },
  });
}

test('journal completion alone does NOT settle: pending until the completed notification', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: {
      script: ['hold'], policy: ONDEMAND_POLICY,
      workflowRuns: [{ runId: 'run-7', status: 'completed', resumable: false }],
    },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  launchWorkflow(run.fake);
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => readJsonFile(run.progressPath)?.status === 'waiting_background', 3000, 'waiting');
  // The journal refresh already said completed, but settle must NOT happen.
  await new Promise(r => setTimeout(r, 700));
  assert.equal(readJsonFile(run.progressPath).status, 'waiting_background',
    'no notification yet: still waiting');
  assert.equal(run.fake.promptLog.length, 1);
  run.fake.emitUpdate({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' },
    _meta: { codexZcodeBackgroundNotification: { state: 'completed', turnId: 't9' } },
  });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 0);
  assert.equal(report.status, 'completed');
  assert.equal(report.backgroundNotificationFinished, true);
  assert.deepEqual(report.workflowRunIds, ['run-7']);
  assert.ok(run.fake.ipcOps.some(([op, payload]) => op === 'bind-run' && payload.runId === 'run-7'));
});

test('background settle succeeds through task status plus completed notification', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: { script: ['hold'], policy: ONDEMAND_POLICY },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  launchWorkflow(run.fake);
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'bg1', title: '[background] demo',
    _meta: { backgroundTask: { taskId: 'run-7' } },
  });
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => readJsonFile(run.progressPath)?.status === 'waiting_background', 3000, 'waiting');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'bg1', status: 'completed',
    _meta: { backgroundTask: { taskId: 'run-7' } },
  });
  run.fake.emitUpdate({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' },
    _meta: { codexZcodeBackgroundNotification: { state: 'completed', turnId: 't9' } },
  });
  const { exitCode } = await run.task;
  assert.equal(exitCode, 0);
});

test('a failed background notification fails the run', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: { script: ['hold'], policy: ONDEMAND_POLICY },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  launchWorkflow(run.fake);
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => readJsonFile(run.progressPath)?.status === 'waiting_background', 3000, 'waiting');
  run.fake.emitUpdate({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' },
    _meta: { codexZcodeBackgroundNotification: { state: 'failed', turnId: 't9' } },
  });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 1);
  assert.match(report.error, /notification failed/);
});

test('a journal-stopped or failed run fails the wait instead of settling', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: {
      script: ['hold'], policy: ONDEMAND_POLICY,
      workflowRuns: [{ runId: 'run-7', status: 'cancelled', resumable: true }],
    },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  launchWorkflow(run.fake);
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 1);
  assert.match(report.error, /stopped or failed/);
});

test('a failed native background task fails the wait', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: { script: ['hold'], policy: ONDEMAND_POLICY },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  launchWorkflow(run.fake);
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'bg1', title: '[background] demo',
    _meta: { backgroundTask: { taskId: 'run-7' } },
  });
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => readJsonFile(run.progressPath)?.status === 'waiting_background', 3000, 'waiting');
  run.fake.emitUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'bg1', status: 'failed',
    _meta: { backgroundTask: { taskId: 'run-7' } },
  });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 1);
  assert.match(report.error, /background task failed/);
});

test('a steer stays queued while the background phase is unsettled, then runs', async () => {
  const run = beginRun({
    raw: { prompts: ['p1'], waitForBackground: true },
    fakeOpts: { script: ['hold'], policy: ONDEMAND_POLICY },
  });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  launchWorkflow(run.fake);
  run.fake.resolvePrompt('p1', 'end_turn');
  await waitFor(() => readJsonFile(run.progressPath)?.status === 'waiting_background', 3000, 'waiting');
  writeControl(run.dir, run.invocationId, 'steer', { message: 'followup' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1, 3000, 'steer queued');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(run.fake.promptLog.length, 1, 'steer must not run while the workflow is unsettled');
  run.fake.workflowRuns = [{ runId: 'run-7', status: 'completed' }];
  run.fake.emitUpdate({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' },
    _meta: { codexZcodeBackgroundNotification: { state: 'completed', turnId: 't9' } },
  });
  const { exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(run.fake.promptLog, ['p1', 'followup']);
});

// ---------- deadline / policy proof / arrival guard ----------

test('the fixed deadline fails the run as timeout', async () => {
  const run = beginRun({ raw: { prompts: ['p1'], timeoutSeconds: 1 }, fakeOpts: { script: ['hold'] } });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 2);
  assert.equal(report.status, 'timeout');
});

test('a wrong policy proof fails before initialize', async () => {
  const bad = { ...DISABLED_POLICY, sessionMode: 'yolo', quotaAutoResume: true, remote: 'enabled' };
  const run = beginRun({ raw: { prompts: ['p1'] }, fakeOpts: { policy: bad, script: ['end_turn'] } });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 1);
  assert.match(report.error, /Effective bridge policy rejected/);
  assert.match(report.error, /session.mode=yolo/);
  assert.equal(run.fake.initializeCalls, 0, 'initialize must not run after a failed policy proof');
  assert.equal(run.fake.promptLog.length, 0);
  assert.throws(() => assertPolicyProof(bad, { mode: 'build' }, 'disabled'), /rejected/);
});

test('a mismatched workflow gate mode is rejected by the proof', () => {
  assert.throws(() => assertPolicyProof(DISABLED_POLICY, { mode: 'build' }, 'onDemand'), /workflow.mode/);
  assert.equal(assertPolicyProof(ONDEMAND_POLICY, { mode: 'build' }, 'onDemand'), true);
});

test('a policy_denied arrival-guard event marks the run needs_attention', async () => {
  const run = beginRun({ raw: { prompts: ['p1', 'p2'] }, fakeOpts: { script: ['hold', 'end_turn'] } });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  run.fake.emitEvent({ type: 'policy_denied', toolName: 'CreateWorkflow', reason: 'binding mismatch' });
  run.fake.resolvePrompt('p1', 'end_turn');
  const { exitCode, report } = await run.task;
  assert.equal(report.status, 'needs_attention');
  assert.equal(exitCode, 1);
  assert.equal(run.fake.promptLog.length, 1, 'no further phase prompts after a denial');
});

// ---------- actions ----------

test('ordinary run performs only cheap identity comparison and recommends probe without blocking', async () => {
  const run = beginRun({ raw: { prompt: 'normal task' } });
  const { report } = await run.task;
  assert.equal(report.status, 'completed');
  assert.equal(report.nativeCliVersion, null);
  assert.equal(report.nativeIdentity.source, 'local-metadata');
  assert.equal(report.nativeIdentity.nativeSha256, null);
  assert.equal(report.nativeIdentity.comparison.status, 'not_verified');
  assert.ok(report.warnings.some(w => w.startsWith('NATIVE_COMPATIBILITY_PROBE_RECOMMENDED')));
});

test('probe action: readbacks without any prompt, reports versions', async () => {
  const run = beginRun({ raw: { action: 'probe' } });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 0);
  assert.equal(report.status, 'completed');
  assert.equal(run.fake.promptLog.length, 0);
  assert.equal(report.modelEffective, `builtin:bigmodel-coding-plan\\${report.modelRequested}`);
  assert.equal(report.modeEffective, 'build');
  assert.equal(report.thoughtEffective, 'max');
  assert.equal(report.acpVersion, '0.65.1');
  assert.deepEqual(report.nativeCliVersion, { version: '3.9.9' });
  assert.equal(report.effectivePolicy.sessionMode, 'build');
  assert.equal(report.nativeIdentity.probeRecord.recorded, false, 'mock transport never establishes a real-source baseline');
});

test('quota action reports usage stats and skips sessions', async () => {
  const run = beginRun({ raw: { action: 'quota' } });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(report.quota, { method: 'account/usage_stats' });
  assert.equal(report.summary.quota.status, 'unknown', 'successful transport is not a successful GLM provider');
  assert.equal(run.fake.promptLog.length, 0);
  assert.equal(report.sessionId, null);
});

test('workflow-status action returns the bound session run list', async () => {
  const run = beginRun({
    raw: { action: 'workflow-status', sessionId: 'sess-1' },
    fakeOpts: { policy: ONDEMAND_POLICY, workflowRuns: [{ runId: 'run-4', status: 'stopped', resumable: true }] },
  });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 0);
  assert.deepEqual(report.workflowStatus, { runs: [{ runId: 'run-4', status: 'stopped', resumable: true }] });
  assert.deepEqual(run.fake.ipcOps.map(([op]) => op), ['workflow-status']);
});

test('management resume returns terminal journal state without claiming a notification', async () => {
  const run = beginRun({
    raw: { action: 'workflow-resume', sessionId: 'sess-1', workflowRunId: 'run-9' },
    fakeOpts: {
      policy: ONDEMAND_POLICY,
      workflowRuns: [{ runId: 'run-9', status: 'completed', resumable: false }],
    },
  });
  const taskPromise = run.task;
  const { exitCode, report } = await taskPromise;
  assert.equal(exitCode, 0);
  assert.equal(report.backgroundNotificationFinished, false);
  assert.equal(report.notificationDisposition, 'not_observed_no_foreground_handoff');
  assert.deepEqual(run.fake.ipcOps.map(([op]) => op), ['bind-run', 'workflow-resume', 'workflow-status']);
  assert.deepEqual(report.workflowRunIds, ['run-9']);
});

test('workflow-resume surfaces a failed run without replay', async () => {
  const run = beginRun({
    raw: { action: 'workflow-resume', sessionId: 'sess-1', workflowRunId: 'run-9' },
    fakeOpts: { policy: ONDEMAND_POLICY, workflowRuns: [{ runId: 'run-9', status: 'failed', resumable: false }] },
  });
  const { exitCode, report } = await run.task;
  assert.equal(exitCode, 1);
  assert.match(report.error, /stopped or failed|Workflow run failed/);
  assert.equal(run.fake.ipcOps.filter(([op]) => op === 'workflow-resume').length, 1, 'no retry after failure');
});

// ---------- persistence and bookkeeping ----------

test('incomplete results persist early for continuation', async () => {
  const run = beginRun({ raw: { prompts: ['p1', 'p2'] }, fakeOpts: { script: ['end_turn', 'hold'] } });
  const taskPromise = run.task;
  await waitFor(() => existsSync(run.resultPath), 3000, 'early result');
  const early = readJsonFile(run.resultPath);
  assert.equal(early.incomplete, true);
  assert.equal(early.turns.length, 1);
  run.fake.resolvePrompt('p2', 'end_turn');
  const { report } = await taskPromise;
  assert.equal(report.incomplete, undefined);
});

test('out-of-turn chunks are kept out of the turn response (replay separation)', async () => {
  const run = beginRun({ raw: { prompts: ['p1'] }, fakeOpts: { script: ['hold'] } });
  const taskPromise = (() => {
    // Historical replay arriving after session creation, before any prompt.
    const start = run.task;
    return start;
  })();
  await waitFor(() => run.fake.spawnOpts !== null, 1000, 'spawn');
  run.fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYD'.repeat(40) } });
  await waitFor(() => run.fake.promptLog.length === 1, 3000, 'prompt');
  run.fake.resolvePrompt('p1', 'end_turn');
  const { report } = await taskPromise;
  assert.equal(report.response.includes('REPLAYD'), false);
  assert.equal(report.replayedHistory.chars, 280);
  assert.equal(report.replayedHistory.truncated, false);
});

test('native PID events land in the progress controller block', async () => {
  const run = beginRun({ raw: { prompts: ['p1'] } });
  await waitFor(() => run.fake.spawnOpts !== null, 1000, 'spawn');
  run.fake.emitEvent({ type: 'native_started', pid: 4242 });
  await waitFor(() => readJsonFile(run.progressPath)?.controller?.nativePids?.includes(4242), 3000, 'native pid');
  run.fake.emitEvent({ type: 'native_exited', pid: 4242 });
  await waitFor(() => !readJsonFile(run.progressPath)?.controller?.nativePids?.includes(4242), 3000, 'native pid gone');
  const { exitCode } = await run.task;
  assert.equal(exitCode, 0);
});

const DELIVERY_RAW = {
  prompt: 'implement', allowToolKinds: ['read', 'edit'],
  workspace: { ownedPaths: ['note.txt'] },
  delivery: { candidateFiles: ['note.txt'], validation: 'not_applicable', validationReason: 'plain text edit' },
};
function emitReview(run) {
  run.fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'review-read', title: 'Read',
    kind: 'read', status: 'completed', rawInput: { file_path: join(run.dir, 'note.txt') },
    _meta: { claudeCode: { toolName: 'Read' } } });
  run.fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text',
    text: '```tandem-review\n' + JSON.stringify({ reviewedFiles: ['note.txt'], fixedIssues: [],
      openIssues: [], summary: 'Read the final text.' }) + '\n```' } });
}

test('automatic review executes after implementation and is surfaced in result/summary/progress', async () => {
  const run = beginRun({ raw: DELIVERY_RAW, fakeOpts: { script: ['end_turn', 'hold'] } });
  writeFileSync(join(run.dir, 'note.txt'), 'done');
  await waitFor(() => run.fake.promptLog.length === 2);
  assert.match(run.fake.promptLog[1], /required first-pass review/);
  emitReview(run); run.fake.resolvePrompt(run.fake.promptLog[1]);
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 0);
  assert.equal(report.delivery.status, 'ready_for_controller_review');
  assert.equal(report.summary.delivery.status, report.delivery.status);
  assert.equal(readJsonFile(run.progressPath).delivery.status, report.delivery.status);
});

test('an end_turn without review evidence exits 4, not successful handoff', async () => {
  const run = beginRun({ raw: DELIVERY_RAW });
  const { report, exitCode } = await run.task;
  assert.equal(report.status, 'completed');
  assert.equal(exitCode, 4);
  assert.equal(report.delivery.status, 'needs_review');
});

test('a late steering turn invalidates the just-completed review even if files stay unchanged', async () => {
  const run = beginRun({ raw: DELIVERY_RAW, fakeOpts: { script: ['end_turn', 'hold'] } });
  writeFileSync(join(run.dir, 'note.txt'), 'done');
  await waitFor(() => run.fake.promptLog.length === 2);
  writeControl(run.dir, run.invocationId, 'steer', { message: 'A new requirement must be checked' });
  await waitFor(() => readJsonFile(run.progressPath)?.controls?.queue?.length === 1);
  emitReview(run); run.fake.resolvePrompt(run.fake.promptLog[1]);
  const { report, exitCode } = await run.task;
  assert.equal(exitCode, 4);
  assert.equal(report.firstPassReview.invalidated, true);
  assert.match(report.delivery.reasons.join(), /subsequent steering/);
});

test('pause cannot skip review; a resumed request gets a fresh review turn', async () => {
  const run = beginRun({ raw: DELIVERY_RAW, fakeOpts: { script: ['hold'] } });
  await waitFor(() => run.fake.promptLog.length === 1);
  writeControl(run.dir, run.invocationId, 'pause', {});
  await waitFor(() => run.fake.cancelCount > 0);
  run.fake.resolvePrompt('implement', 'cancelled');
  const paused = await run.task;
  assert.equal(paused.exitCode, 3);
  assert.equal(paused.report.delivery.status, 'needs_review');
  const resumed = beginRun({ raw: { ...DELIVERY_RAW, sessionId: 'sess-1', prompt: 'finish remaining work' },
    fakeOpts: { script: ['end_turn', 'hold'] } });
  writeFileSync(join(resumed.dir, 'note.txt'), 'done');
  await waitFor(() => resumed.fake.promptLog.length === 2);
  emitReview(resumed); resumed.fake.resolvePrompt(resumed.fake.promptLog[1]);
  assert.equal((await resumed.task).exitCode, 0);
});
