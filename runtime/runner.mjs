// runTask — the V3 orchestrator. Transport-agnostic by design: the real
// bridge/ACP wiring comes from transport.spawnTransport; tests inject fakes.
//
// Responsibilities: isolated per-invocation XDG config, pre-initialize policy
// proof, pinned model/mode/thought readback, the phase prompt loop with
// serialized steering and pause, inbox answer handling for pendingInput,
// permission policy application, bounded background-workflow waiting, the
// optional idle control window, one fixed total deadline, graceful cancel
// followed by bounded task-owned process-tree cleanup, and early/atomic
// progress + result persistence.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildReportState, completeReport, captureQuota } from './reporting.mjs';
import { ScopeObserver } from './scope-observer.mjs';
import { inspectNativeIdentity, collectNativeIdentity, rememberCompatibilityProbe } from './native-identity.mjs';
import { buildChildEnv, buildIsolatedAcpConfig, resolvePaths, workflowModeForRequest } from './config.mjs';
import { writeJsonAtomic } from './jsonio.mjs';
import { ProgressTracker } from './progress.mjs';
import { ClientInbox } from './inbox.mjs';
import { observeWorkflowBinding } from './workflow-observation.mjs';
import { boundWorkflowEvents } from './evidence.mjs';
import {
  backgroundSettled, buildPendingInput, classifyPermissionRequest, decideToolPermission,
  isTool, mergeBackgroundTask, nativeToolName, selectOption,
} from './policy.mjs';
import { spawnTransport, probeNativeCliVersion } from './transport.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const redact = text => String(text ?? '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');

/** Validate the bridge's effective-policy proof against the request. */
export function assertPolicyProof(policy, request, expectedWorkflowMode) {
  const problems = [];
  if (policy.sessionMode !== request.mode) {
    problems.push(`session.mode=${policy.sessionMode} but request.mode=${request.mode}`);
  }
  if (policy.quotaAutoResume !== false) problems.push('quota.autoResume is not false');
  if (policy.remote !== 'disabled') problems.push(`remote is ${policy.remote}`);
  if (policy.workflowOverride?.mode !== expectedWorkflowMode) {
    problems.push(`workflow.mode=${policy.workflowOverride?.mode ?? 'unset'} but expected ${expectedWorkflowMode}`);
  }
  if (problems.length) throw new Error(`Effective bridge policy rejected: ${problems.join('; ')}`);
  return true;
}

export async function runTask({ request, config, cwd, invocationId = randomUUID(), deps = {} }) {
  const dependencyKeys = ['delay', 'setIntervalFn', 'clearIntervalFn', 'setTimeoutFn',
    'clearTimeoutFn', 'spawnTransport', 'log', 'nativeCliVersion', 'cleanupOwnedPids', 'identityRoot'];
  for (const key of Object.keys(deps)) {
    if (!dependencyKeys.includes(key)) throw new Error(`Unknown injected dependency: ${key}`);
  }
  const delay = deps.delay ?? (ms => new Promise(r => setTimeout(r, ms)));
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const spawnTransportFn = deps.spawnTransport ?? spawnTransport;
  const log = deps.log ?? (() => {});

  const paths = resolvePaths(config);
  const identityRoot = deps.identityRoot ?? resolve(MODULE_DIR, '..');
  const startedAtMs = Date.now();
  const deadlineAt = startedAtMs + request.timeoutSeconds * 1000;

  // Per-invocation control inbox lives beside the progress file.
  const progressPath = request.progressFile ? resolve(request.progressFile) : null;
  const resultPath = request.resultFile ? resolve(request.resultFile) : null;
  const inboxDir = join(progressPath ? resolve(progressPath, '..') : tmpdir(),
    config.inboxDirName, invocationId);
  mkdirSync(inboxDir, { recursive: true });

  // Per-invocation isolated XDG_CONFIG_HOME (ACP user config ONLY).
  const xdgHome = mkdtempSync(join(tmpdir(), `zcode-v3-xdg-${invocationId.slice(0, 8)}-`));
  const isolated = buildIsolatedAcpConfig({
    workflowMode: workflowModeForRequest(request),
    sessionMode: request.mode,
    quotaAutoResume: false,
  });
  const isolatedFile = join(xdgHome, ...isolated.relPath);
  mkdirSync(join(xdgHome, isolated.relPath[0]), { recursive: true });
  writeFileSync(isolatedFile, JSON.stringify(isolated.json, null, 2) + '\n');

  const tracker = new ProgressTracker({
    invocationId, cwd, request, config, progressPath,
    controllerPid: process.pid, inboxPath: inboxDir,
    runtimeRoot: resolve(MODULE_DIR, '..'),
  });

  const scopeObserver = new ScopeObserver(request, config);
  const st = {
    invocationId, tracker, request, config,
    sessionId: null, acpVersion: null, agentInfo: null,
    policy: null, policyError: null,
    tools: new Map(), trackedToolCalls: new Map(),
    backgroundTasks: new Map(), permissions: [], workflowObserved: new Set(),
    response: '', turnsTexts: new Map(),
    bytes: 0, needsAttention: false, notificationState: null,
    activeTurn: null, promptInFlight: false, promptPromise: null,
    steers: [], answers: new Map(), pausing: false, pausePayload: null, pauseCommandId: null,
    pausePromise: null, pauseError: null,
    waitingBackground: false, lastStatusRefresh: 0, boundRunsSent: new Set(),
    warnings: [], configOptions: [], quota: null, nativeCliVersion: null,
    finalized: false, interrupting: false, expectedBridgeExit: false,
    lastStopReason: null, cleanup: [],
  };

  const report = {
    version: 3, invocationId, startedAt: new Date(startedAtMs).toISOString(),
    cwd, provider: config.provider, bridgeVersion: null,
    modelRequested: request.model, thoughtRequested: request.thought, mode: request.mode,
    modelEffective: null, thoughtEffective: null, modeEffective: null,
    sessionId: null, workflowRunIds: [], status: 'starting',
    stopReason: null, turns: [], response: '', responseTruncated: false,
    replayedHistory: { chars: 0, truncated: false },
    tools: [], permissions: [], config: [], backgroundTasks: [],
    backgroundNotificationFinished: false, needsAttention: false,
    pendingInput: null, controls: [], warnings: [],
    error: null, diagnostics: null, cleanup: [], quota: null,
    effectivePolicy: null, xdgConfigHome: xdgHome, workflowObservations: [],
    nativeIdentity: inspectNativeIdentity(identityRoot, paths),
  };
  if (request.action !== 'probe' && report.nativeIdentity.comparison.compatibilityProbeRecommended) {
    st.warnings.push(`NATIVE_COMPATIBILITY_PROBE_RECOMMENDED: ${report.nativeIdentity.comparison.status}; run setup --doctor and a compatibility probe. Ordinary tasks remain allowed.`);
  }

  let transport = null;
  const nativePids = new Set();
  let policyResolve = null;
  const policyPromise = new Promise(r => { policyResolve = r; });
  const policyTimer = setTimeoutFn(() => policyResolve({ timeout: true }), config.bridgeIpcTimeoutMs);
  policyTimer.unref?.();

  const heartbeatTimer = setIntervalFn(() => tracker.heartbeat(), config.heartbeatMs);
  heartbeatTimer.unref?.();
  const deadlineTimer = setTimeoutFn(() => { void interrupt('timeout', 'Task deadline reached'); },
    request.timeoutSeconds * 1000);
  deadlineTimer.unref?.();
  const pollTimer = setIntervalFn(() => { void pollInboxOnce().catch(e => warn(`inbox poll failed: ${e.message}`)); },
    config.inboxPollMs);
  pollTimer.unref?.();
  const onSignal = () => { void interrupt('cancelled', 'interrupted by signal'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const inbox = new ClientInbox({
    dir: inboxDir, invocationId, invocationStartedAtMs: startedAtMs,
  });

  function warn(message) {
    if (st.warnings.length < 100) st.warnings.push(message);
    console.error(`[zcode-v3] ${message}`);
  }

  function terminal() { return st.finalized || st.pausing || st.interrupting; }

  // ---------- bridge events ----------
  function handleBridgeEvent(message) {
    switch (message.type) {
      case 'policy':
        st.policy = message.policy ?? null;
        clearTimeoutFn(policyTimer);
        policyResolve(message.policy ?? {});
        break;
      case 'native_started':
        if (Number.isInteger(message.pid) && message.pid > 0) {
          nativePids.add(message.pid);
          tracker.setNativePids(nativePids);
          tracker.touch({ type: 'native_started', pid: message.pid });
        }
        break;
      case 'native_exited':
        nativePids.delete(message.pid);
        tracker.setNativePids(nativePids);
        tracker.touch({ type: 'native_exited', pid: message.pid });
        break;
      case 'backend_dead':
        if (!st.expectedBridgeExit) void interrupt('failed', 'native backend reader died');
        break;
      case 'policy_denied':
        st.needsAttention = true;
        tracker.touch({ type: 'permission_denied', nativeName: message.toolName, reason: message.reason });
        break;
      case 'bridge_error':
        void interrupt('failed', message.error);
        break;
      case 'bridge_exit':
        if (!st.finalized && !st.expectedBridgeExit) {
          void interrupt('failed', `Bridge exited unexpectedly: ${message.code ?? message.signal ?? '?'}`);
        }
        break;
      default:
        break;
    }
  }

  // ---------- ACP session updates ----------
  function handleUpdate(update) {
    try {
      st.bytes += Buffer.byteLength(JSON.stringify(update ?? {}));
      const kind = update?.sessionUpdate;
      if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
        const notif = update._meta?.codexZcodeBackgroundNotification;
        if (notif) {
          st.notificationState = notif.state;
          tracker.setNotificationState(notif.state);
          tracker.touch({ type: 'background_notification', ...notif });
          return;
        }
        const text = update.content.text ?? '';
        if (st.activeTurn) {
          st.activeTurn.text = (st.activeTurn.text + text).slice(-request.maxOutputBytes);
          st.activeTurn.chars += text.length;
          if (st.activeTurn.chars > request.maxOutputBytes) {
            report.responseTruncated = true;
            tracker.flagEvidence('responseTruncated');
          }
          if (tracker.state.currentTurn) tracker.state.currentTurn.chars = st.activeTurn.chars;
          tracker.noteActivity();
        } else {
          tracker.noteReplay(text.length); // historical replay, not this turn
        }
        return;
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        mergeToolUpdate(update);
        return;
      }
      if (kind === 'config_option_update') {
        st.configOptions = update.configOptions ?? [];
        tracker.noteActivity();
        return;
      }
      tracker.noteActivity();
    } catch (e) {
      warn(`session update handling failed: ${e.message}`);
    }
  }

  function mergeToolUpdate(update) {
    const id = update.toolCallId;
    if (!id) return;
    if (update.sessionUpdate === 'tool_call') {
      st.trackedToolCalls.set(id, update);
      while (st.trackedToolCalls.size > 4096) st.trackedToolCalls.delete(st.trackedToolCalls.keys().next().value);
    }
    const retained = { ...update };
    for (const key of ['rawInput', 'rawOutput', 'content']) {
      if (key in retained) {
        const json = JSON.stringify(retained[key]);
        retained[key] = json && json.length > config.compactByteLimit
          ? { truncated: true, preview: json.slice(0, config.compactByteLimit) } : retained[key];
      }
    }
    const previous = st.tools.get(id) ?? {};
    const merged = { ...previous, ...retained,
      _meta: { ...previous._meta, ...retained._meta } };
    st.trackedToolCalls.set(id, merged);
    st.tools.set(id, merged);
    if (st.tools.size > config.maxTools) {
      st.tools.delete(st.tools.keys().next().value);
      tracker.flagEvidence('toolsTruncated');
    }
    const name = nativeToolName(merged);
    const observation = scopeObserver.observe(merged, update.rawInput);
    report.workspaceObservations = scopeObserver.records;
    if (scopeObserver.truncated) tracker.flagEvidence('workspaceObservationsTruncated');
    if (observation && observation.allowed !== true) { st.needsAttention = true; warn(`Tool scope requires attention: ${observation.reason}`); }
    if (['CreateWorkflow', 'AmendWorkflow'].includes(name) && merged.rawInput
      && !st.workflowObserved.has(id)) {
      st.workflowObserved.add(id);
      const observation = observeWorkflowBinding(request, name, merged.rawInput, cwd);
      report.workflowObservations.push({ toolCallId: id, ...observation });
      if (name === 'AmendWorkflow' && observation.matched) {
        for (const runId of [...tracker.state.workflowRunIds]) observeRun(runId, tracker.state.workflow.runs[runId]);
      }
      if (!observation.matched) {
        st.needsAttention = true;
        warn(observation.reason);
      }
    }
    tracker.setLastTool({ id, name, status: merged.status ?? null, at: new Date().toISOString() });
    tracker.touch({ id, name, kind: merged.kind, title: merged.title, status: merged.status, sessionUpdate: update.sessionUpdate });
    console.error(`[zcode-v3 tool] ${update.sessionUpdate} ${name ?? 'other'} ${id}`);
    const bg = merged._meta?.backgroundTask;
    if (bg?.taskId && bg.taskId !== tracker.state.workflow.predecessorRunId) {
      st.backgroundTasks.set(bg.taskId, mergeBackgroundTask(st.backgroundTasks.get(bg.taskId), bg, update, merged.title));
      tracker.setBackgroundTasks([...st.backgroundTasks.values()]);
      if (bg.taskId.startsWith('dwfrun-')) {
        observeRun(bg.taskId, merged.status === 'completed' ? 'completed' : 'running');
        bindRun(bg.taskId);
      }
    }
    const wr = merged._meta?.workflowRun;
    if (wr?.runId) {
      if (!tracker.state.workflowRunIds.includes(wr.runId)) {
        observeRun(wr.runId, 'running');
        bindRun(wr.runId);
      }
      const settled = parseRunSettled(merged.content);
      if (settled) {
        tracker.setWorkflowRun(wr.runId, settled);
        tracker.touch({ type: 'workflow_run_settled', runId: wr.runId, status: settled });
      }
    }
  }

  function parseRunSettled(content) {
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      const text = block?.content?.text;
      if (typeof text !== 'string') continue;
      const match = text.match(/= run settled: (\S+)/);
      if (match) return match[1];
    }
    return null;
  }

  function bindRun(runId) {
    if (!runId || st.boundRunsSent.has(runId) || !transport) return;
    st.boundRunsSent.add(runId);
    transport.ipcCall('bind-run', { runId }).catch(e => warn(`bind-run ${runId} failed: ${e.message}`));
  }

  function observeRun(runId, status) {
    if (tracker.state.workflow.predecessorRunId === runId) return;
    if (request.workflowRunId && runId !== request.workflowRunId
      && report.workflowObservations.some(o => o.tool === 'AmendWorkflow' && o.matched)) {
      tracker.state.workflow.predecessorRunId = request.workflowRunId;
      tracker.state.workflowRunIds = tracker.state.workflowRunIds.filter(id => id !== request.workflowRunId);
      st.backgroundTasks.delete(request.workflowRunId);
      tracker.setBackgroundTasks([...st.backgroundTasks.values()]);
    }
    tracker.addWorkflowRun(runId, status);
  }

  // ---------- permission requests ----------
  async function handlePermission(p) {
    if (st.finalized || st.pausing) return { outcome: { outcome: 'cancelled' } };
    const toolCallId = p?.toolCall?.toolCallId ?? '';
    const cls = classifyPermissionRequest(p, id => st.trackedToolCalls.get(id));
    if (!toolCallId) {
      st.needsAttention = true;
      report.needsAttention = true;
      warn('permission request without toolCallId — denying');
      return { outcome: { outcome: 'cancelled' } };
    }
    if (cls.kind === 'plan_approval') {
      st.needsAttention = true;
      tracker.setPendingInput(buildPendingInput({
        interactionId: toolCallId, kind: cls.kind, nativeName: cls.nativeName,
        title: p.toolCall?.title, options: p.options, rawInput: p.toolCall?.rawInput,
      }));
      return { outcome: { outcome: 'cancelled' } };
    }
    if (cls.kind === 'question') {
      const pi = buildPendingInput({
        interactionId: toolCallId, kind: cls.kind, nativeName: cls.nativeName,
        title: p.toolCall?.title, options: p.options, rawInput: p.toolCall?.rawInput,
      });
      tracker.setPendingInput(pi);
      const answer = await waitForAnswer(pi);
      if (st.finalized) return { outcome: { outcome: 'cancelled' } };
      tracker.setPendingInput(null);
      if (answer.kind === 'answer') {
        tracker.recordControl(answer.commandId, 'answer', 'started');
        tracker.recordControl(answer.commandId, 'answer', 'completed',
          `answered ${pi.interactionId} with ${answer.optionId}`);
        return { outcome: { outcome: 'selected', optionId: answer.optionId } };
      }
      if (answer.kind === 'invalid') {
        tracker.recordControl(answer.commandId, 'answer', 'rejected', answer.why);
        return { outcome: { outcome: 'cancelled' } };
      }
      if (answer.kind === 'timeout') {
        throw new Error('Task deadline reached while a question was pending');
      }
      return { outcome: { outcome: 'cancelled' } }; // paused/cancelled
    }
    const meta = st.trackedToolCalls.get(toolCallId);
    const rawInput = p.toolCall?.rawInput ?? scopeObserver.input(toolCallId) ?? meta?.rawInput;
    const decision = decideToolPermission({
      request, nativeName: cls.nativeName, acpKind: meta?.kind, rawInput,
    });
    if (cls.nativeName === 'ResumeWorkflowRun' && p.toolCall?.rawInput?.run_id === tracker.state.workflow.predecessorRunId) {
      decision.allowed = false; decision.reason = 'superseded predecessor cannot be resumed in this invocation';
    }
    const option = selectOption(p.options, decision.allowed);
    if (st.permissions.length >= config.maxPermissions) {
      st.permissions.shift();
      tracker.flagEvidence('permissionsTruncated');
    }
    st.permissions.push({
      toolCallId,
      nativeName: cls.nativeName, kind: meta?.kind ?? null, allowed: decision.allowed,
      reason: decision.reason, binding: decision.binding, title: p.toolCall?.title ?? null,
      optionId: option?.optionId ?? null, granted: decision.allowed && !!option,
      rawInput: compact(rawInput),
    });
    if (decision.allowed && option) {
      const runId = p.toolCall?.rawInput?.run_id;
      if (cls.nativeName === 'ResumeWorkflowRun' && typeof runId === 'string') {
        observeRun(runId, 'resuming');
        bindRun(runId);
      }
      tracker.touch({ type: 'permission', nativeName: cls.nativeName, allowed: true });
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
    st.needsAttention = true;
    report.needsAttention = true;
    tracker.touch({ type: 'permission_denied', nativeName: cls.nativeName, reason: decision.reason });
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  function compact(value) {
    const json = JSON.stringify(value);
    return json && json.length > config.compactByteLimit
      ? { truncated: true, preview: json.slice(0, config.compactByteLimit) } : value;
  }

  async function waitForAnswer(pi) {
    for (;;) {
      if (st.pausing || st.finalized) return { kind: 'cancelled', why: st.pausing ? 'paused' : 'finalized' };
      const queued = st.answers.get(pi.interactionId);
      if (queued) {
        st.answers.delete(pi.interactionId);
        const offered = pi.options.some(o => o.optionId === queued.optionId);
        return offered
          ? { kind: 'answer', optionId: queued.optionId, commandId: queued.commandId }
          : { kind: 'invalid', commandId: queued.commandId, why: `optionId not offered: ${queued.optionId}` };
      }
      if (Date.now() >= deadlineAt) return { kind: 'timeout' };
      await delay(200);
    }
  }

  // ---------- control inbox ----------
  async function pollInboxOnce() {
    if (st.finalized) return;
    const { commands, skipped } = inbox.poll();
    for (const s of skipped) {
      if (s.id) tracker.recordControl(`skipped:${s.id}`, 'control', 'rejected', `skipped: ${s.reason}`);
    }
    for (const cmd of commands) {
      tracker.recordControl(cmd.id, cmd.action, 'accepted', null, cmd.createdAt);
      try {
        dispatchControl(cmd);
      } catch (e) {
        tracker.recordControl(cmd.id, cmd.action, 'rejected', e.message);
      }
    }
  }

  function dispatchControl(cmd) {
    switch (cmd.action) {
      case 'steer':
      case 'ask': {
        if (st.pausing) {
          tracker.recordControl(cmd.id, cmd.action, 'rejected', 'invocation is pausing');
        } else if (st.finalized) {
          tracker.recordControl(cmd.id, cmd.action, 'rejected', 'invocation already finalized');
        } else {
          st.steers.push({ id: cmd.id, action: cmd.action, text: cmd.payload.message });
          tracker.recordControl(cmd.id, cmd.action, 'queued', 'steer queued for next foreground boundary');
        }
        break;
      }
      case 'pause': {
        tracker.recordControl(cmd.id, 'pause', 'started', 'pause in progress');
        st.pauseCommandId = cmd.id;
        beginPause(cmd.payload ?? {});
        break;
      }
      case 'answer': {
        const pi = tracker.state.pendingInput;
        if (pi?.kind !== 'question' || pi.interactionId !== cmd.payload.interactionId
          || !pi.options.some(o => o.optionId === cmd.payload.optionId)
          || st.answers.has(pi.interactionId)) {
          tracker.recordControl(cmd.id, 'answer', 'rejected', 'stale, duplicate, or non-question answer');
          break;
        }
        st.answers.set(cmd.payload.interactionId, { optionId: cmd.payload.optionId, commandId: cmd.id });
        break;
      }
      case 'workflow-status':
      case 'workflow-events':
      case 'workflow-stop':
      case 'workflow-settings': {
        const payload = { ...cmd.payload };
        if (!payload.sessionId) payload.sessionId = st.sessionId ?? undefined;
        if (cmd.action !== 'workflow-status'
          && !tracker.state.workflowRunIds.includes(payload.runId)
          && tracker.state.workflow.predecessorRunId !== payload.runId) {
          tracker.recordControl(cmd.id, cmd.action, 'rejected',
            `run ${payload.runId ?? '(missing)'} is not bound to this invocation`);
          break;
        }
        tracker.recordControl(cmd.id, cmd.action, 'started');
        void transport.ipcCall(cmd.action, payload)
          .then(result => {
            const text = JSON.stringify(result);
            const resultFile = join(inboxDir, 'results', `${cmd.id}.json`);
            mkdirSync(join(inboxDir, 'results'), { recursive: true });
            const truncated = Buffer.byteLength(text) > request.maxOutputBytes;
            if (truncated) tracker.flagEvidence('controlResultTruncated');
            writeJsonAtomic(resultFile, truncated ? { truncated, preview: text.slice(0, request.maxOutputBytes) } : result);
            tracker.recordControl(cmd.id, cmd.action, 'completed', boundedJson({ resultFile, truncated, result }));
          })
          .catch(e => tracker.recordControl(cmd.id, cmd.action, 'rejected', e.message));
        break;
      }
      default:
        tracker.recordControl(cmd.id, cmd.action, 'rejected', 'unhandled action');
    }
  }

  function boundedJson(value) {
    const json = JSON.stringify(value) ?? 'null';
    return json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
  }

  function beginPause(payload = {}) {
    if (st.pausing) return;
    st.pausing = true;
    st.pausePayload = payload;
    st.pauseTimer = setTimeoutFn(() => { void interrupt('paused'); }, config.gracefulCancelWaitMs);
    st.pauseTimer.unref?.();
    if (st.promptInFlight && st.sessionId) {
      Promise.resolve(transport.conn.cancel({ sessionId: st.sessionId })).catch(e => warn(e.message));
    }
    st.pausePromise = stopPausedWork(payload).catch(e => {
      st.pauseError = e.message;
      warn(`pause state uncertain: ${e.message}`);
    });
  }

  async function stopPausedWork(payload) {
    if (payload.stopWorkflow !== false) {
      for (const runId of tracker.state.workflowRunIds) {
        const status = String(tracker.state.workflow.runs[runId] ?? '');
        if (!/^(completed|failed|cancelled|stopped)/.test(status)) {
          const stopped = await transport.ipcCall('workflow-stop', { sessionId: st.sessionId, runId });
          tracker.setWorkflowRun(runId, stopped.run.status);
        }
      }
    }
  }

  // ---------- turns ----------
  async function runPromptTurn({ label, text }) {
    st.promptInFlight = true;
    st.activeTurn = { label, text: '', chars: 0 };
    tracker.setCurrentTurn({ label, chars: 0 });
    tracker.touch({ type: 'turn_started', label });
    try {
      const promise = transport.conn.prompt({
        sessionId: st.sessionId, prompt: [{ type: 'text', text }],
      });
      st.promptPromise = promise;
      const response = await promise;
      st.lastStopReason = response.stopReason ?? null;
      return { ...response, text: st.activeTurn.text, chars: st.activeTurn.chars };
    } finally {
      st.promptPromise = null;
      st.promptInFlight = false;
      const turn = st.activeTurn;
      st.activeTurn = null;
      tracker.setCurrentTurn(null);
      if (turn) {
        tracker.touch({ type: 'turn_finished', label, stopReason: st.lastStopReason, chars: turn.chars });
      }
    }
  }

  function recordTurn(label, result) {
    const text = result.text ?? '';
    st.response = st.response.length + text.length > request.maxOutputBytes
      ? (st.response + text).slice(-request.maxOutputBytes) : st.response + text;
    if (st.response.length >= request.maxOutputBytes) {
      report.responseTruncated = true;
      tracker.flagEvidence('responseTruncated');
    }
    const entry = {
      label, stopReason: result.stopReason ?? null, chars: result.chars ?? text.length,
        preview: text.slice(0, 2000), previewTruncated: text.length > 2000, truncated: text.length > 2000,
    };
    tracker.addTurn(entry);
    report.turns.push(entry);
    if (report.turns.length > config.maxTurns) {
      report.turns.shift();
      tracker.flagEvidence('turnsTruncated');
    }
  }

  async function drainSteers() {
    while (st.steers.length > 0 && !terminal() && !st.needsAttention) {
      const steer = st.steers.shift();
      const label = `steer:${steer.id.slice(-8)}`;
      tracker.setPhase(tracker.state.phase.index, label);
      tracker.recordControl(steer.id, steer.action, 'started');
      try {
        const result = await runPromptTurn({ label, text: steer.text });
        recordTurn(label, result);
        writeResultEarly();
        if (result.stopReason === 'end_turn' && !st.needsAttention) {
          tracker.recordControl(steer.id, steer.action, 'completed', `turn ended end_turn (${result.chars} chars)`);
        } else if (!st.pausing) {
          tracker.recordControl(steer.id, steer.action, 'rejected', `turn ended ${result.stopReason}`);
        } else {
          tracker.recordControl(steer.id, steer.action, 'rejected', `paused mid-turn (${result.stopReason})`);
        }
      } catch (e) {
        if (st.pausing) {
          tracker.recordControl(steer.id, steer.action, 'rejected', `paused: ${e.message}`);
        } else {
          tracker.recordControl(steer.id, steer.action, 'rejected', e.message);
          throw e;
        }
      }
    }
  }

  async function runPhases() {
    for (let index = 0; index < request.prompts.length; index += 1) {
      if (terminal() || st.needsAttention) break;
      await drainSteers();
      if (terminal() || st.needsAttention) break;
      const item = request.prompts[index];
      tracker.setPhase(index, item.label);
      tracker.setStatus('running');
      const previousToolIds = new Set(st.tools.keys());
      const result = await runPromptTurn({ label: item.label, text: item.text });
      recordTurn(item.label, result);
      writeResultEarly();
      if (terminal()) break;
      if (result.stopReason !== 'end_turn') {
        throw new Error(`Turn ended: ${result.stopReason}`);
      }
      for (const name of item.requiredTools) {
        const completed = [...st.tools.entries()].some(([id, t]) =>
          !previousToolIds.has(id) && isTool(t, name) && t.status === 'completed');
        if (!completed) throw new Error(`Required tool not completed in ${item.label}: ${name}`);
      }
      if (st.needsAttention) break; // denial: no remaining normal phase prompts
      if (request.waitForBackground && index === 0) {
        const launched = [...st.tools.values()].some(t =>
          ['CreateWorkflow', 'ResumeWorkflowRun', 'AmendWorkflow'].some(n => isTool(t, n)) && t.status === 'completed');
        if (!launched) throw new Error('No completed native workflow launch/resume call');
        tracker.setStatus('waiting_background');
        await waitBackgroundSettle();
        if (terminal()) break;
      }
    }
    if (!terminal()) {
      await drainSteers(); // trailing steers accepted before completion
    }
  }

  async function waitBackgroundSettle() {
    const notificationFinished = () => st.notificationState === 'completed';
    for (;;) {
      if (terminal() || st.needsAttention) return;
      if (Date.now() >= deadlineAt) throw new Error('Task deadline reached while waiting for background work');
      if (Date.now() - st.lastStatusRefresh > 10_000 && tracker.state.workflowRunIds.length > 0 && transport) {
        st.lastStatusRefresh = Date.now();
        try {
          const res = await transport.ipcCall('workflow-status', { sessionId: st.sessionId });
          for (const row of res?.runs ?? []) {
            if (tracker.state.workflowRunIds.includes(row.runId)) {
              tracker.setWorkflowRun(row.runId, row.resumable ? `${row.status}:resumable` : String(row.status));
            }
          }
        } catch (e) {
          warn(`workflow-status refresh failed: ${e.message}`);
        }
      }
      const tasks = [...st.backgroundTasks.values()];
      if (st.notificationState === 'failed') throw new Error('Background completion notification failed');
      if (tasks.some(t => t.status === 'failed')) throw new Error('Native background task failed');
      if (backgroundSettled(tasks, notificationFinished())) return;
      const runs = tracker.state.workflow.runs;
      const bound = tracker.state.workflowRunIds;
      const nonePending = !tasks.some(t => !['completed', 'failed'].includes(t.status));
      const runsSettled = bound.length > 0 && bound.every(id => {
        const status = String(runs[id] ?? 'running');
        return /^(completed|failed|cancelled|stopped)/.test(status);
      });
      if (runsSettled && bound.some(id => !String(runs[id]).startsWith('completed'))) {
        throw new Error('Native workflow stopped or failed; inspect state before recovery');
      }
      if (nonePending && runsSettled && notificationFinished()) return;
      // The management resume command has no following foreground prompt.
      // Native 0.16.9 may emit no notification turn for that path. A journal
      // terminal state is sufficient to return its result, but is NOT recorded
      // as a completed notification or a safe conversational handoff.
      if (nonePending && runsSettled && request.action === 'workflow-resume'
        && st.notificationState === null) {
        report.notificationDisposition = 'not_observed_no_foreground_handoff';
        return;
      }
      await delay(1000);
    }
  }

  async function idleWindow() {
    if (!request.idleSeconds || st.needsAttention || terminal()) return;
    tracker.setStatus('idle_window');
    let until = Date.now() + request.idleSeconds * 1000;
    while (Date.now() < until && Date.now() < deadlineAt && !terminal()) {
      const before = report.turns.length;
      await drainSteers();
      if (report.turns.length > before) {
        until = Date.now() + request.idleSeconds * 1000; // activity extends the window
        continue;
      }
      await delay(400);
    }
  }

  // ---------- result persistence ----------
  function buildReport() {
    return buildReportState(report, st, tracker, progressPath, inboxDir);
  }

  function writeResultEarly() {
    if (!resultPath) return;
    try {
      writeJsonAtomic(resultPath, { ...buildReport(), status: tracker.status, incomplete: true });
    } catch (e) {
      warn(`early result write failed: ${e.message}`);
    }
  }

  function stopTree() {
    const owned = [...nativePids];
    const bridgePid = transport?.pid;
    if (bridgePid && transport?.child?.exitCode === null) owned.push(bridgePid);
    st.cleanup = deps.cleanupOwnedPids ? deps.cleanupOwnedPids(owned) : owned.map(pid => {
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      if (!alive()) return { pid, ok: true, alreadyExited: true };
      try {
        if (process.platform === 'win32') {
          execFileSync(paths.taskkillPath, ['/PID', String(pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: config.cleanupTimeoutMs });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        return { pid, ok: !alive() };
      } catch (e) {
        return alive() ? { pid, ok: false, error: e.message } : { pid, ok: true, alreadyExited: true };
      }
    });
    nativePids.clear();
    tracker.setNativePids([]);
    report.cleanup = st.cleanup;
  }

  async function finalize(status, { error = null, exitCode = null } = {}) {
    if (!st.finalizationPromise) st.finalizationPromise = finish(status, { error, exitCode });
    return st.finalizationPromise;
  }

  async function finish(status, { error = null, exitCode = null } = {}) {
    st.finalized = true;
    tracker.setStatus('closing');
    st.expectedBridgeExit = true;
    if (st.pauseTimer) clearTimeoutFn(st.pauseTimer);
    if (st.pausePromise) await st.pausePromise;
    if (st.pauseError) { status = 'needs_attention'; error = st.pauseError; }
    clearIntervalFn(pollTimer);
    const closingInbox = inbox.poll();
    for (const item of closingInbox.skipped) if (item.id) tracker.recordControl(`skipped:${item.id}`, 'control', 'rejected', `skipped at close: ${item.reason}`);
    for (const cmd of closingInbox.commands) tracker.recordControl(cmd.id, cmd.action, 'rejected', 'invocation closing before acceptance', cmd.createdAt);
    clearIntervalFn(heartbeatTimer);
    clearTimeoutFn(deadlineTimer);
    clearTimeoutFn(policyTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (status === 'paused' && st.pauseCommandId) {
      tracker.recordControl(st.pauseCommandId, 'pause', 'completed', 'invocation paused');
    }
    for (const [interactionId, queued] of [...st.answers]) {
      st.answers.delete(interactionId);
      tracker.recordControl(queued.commandId, 'answer', 'rejected', 'no pending question at finalize');
    }
    tracker.dropQueuedControls(st.pausing ? 'paused' : 'finalized');
    tracker.setStatus(status);
    tracker.setError(error ? redact(error) : null);
    report.status = status;
    report.error = error ? redact(error) : null;
    report.finishedAt = new Date().toISOString();
    report.diagnostics = transport ? redact(transport.stderr()) : null;
    if (request.quotaSnapshots && transport && status === 'completed') {
      report.quotaSnapshots.after = await captureQuota(transport.conn);
    }
    buildReport();
    if (st.activeTurn) report.interruptedTurn = { label: st.activeTurn.label,
      chars: st.activeTurn.chars, preview: st.activeTurn.text.slice(-4000), incomplete: true };
    if (transport) {
      try { await transport.dispose({ graceMs: 3000 }); } catch { /* bounded above */ }
    }
    stopTree();
    if (st.cleanup.some(item => !item.ok)) {
      status = 'needs_attention';
      report.status = status;
      report.error = [report.error, 'Owned process cleanup could not be confirmed'].filter(Boolean).join('; ');
      tracker.setStatus(status);
      tracker.setError(report.error);
    }
    try { rmSync(xdgHome, { recursive: true, force: true }); } catch { /* best effort */ }
    if (request.action === 'probe' && status === 'completed' && report.nativeIdentity) {
      try {
        report.nativeIdentity.probeRecord = rememberCompatibilityProbe(identityRoot, report.nativeIdentity,
          { model: report.modelEffective, thought: report.thoughtEffective, mode: report.modeEffective });
      } catch {
        report.nativeIdentity.probeRecord = { recorded: false, reason: 'Local probe cache could not be written.' };
      }
    }
    completeReport(report, request, paths);
    if (resultPath) writeJsonAtomic(resultPath, report);
    tracker.write('final');
    const code = exitCode ?? exitCodeOf(status);
    st.finalCode = code;
    console.error(`[zcode-v3] final status=${status} exit=${code} session=${st.sessionId ?? '-'}`);
    return code;
  }

  function exitCodeOf(status) {
    if (status === 'completed') return 0;
    if (status === 'paused') return 3;
    if (status === 'timeout' || status === 'cancelled') return 2;
    return 1;
  }

  async function interrupt(reason, error = null) {
    if (st.finalized || st.interrupting) return;
    st.interrupting = true;
    st.interruptReason = reason;
    if (st.sessionId && transport) {
      Promise.resolve(transport.conn.cancel({ sessionId: st.sessionId })).catch(() => {});
    }
    if (st.promptPromise) {
      await Promise.race([st.promptPromise.catch(() => {}), delay(config.gracefulCancelWaitMs)]);
    }
    const status = ['timeout', 'cancelled', 'paused'].includes(reason) ? reason : 'failed';
    await finalize(status, { error: error ?? reason });
  }

  // ---------- main flow ----------
  let exitCode = 1;
  try {
    if (request.action === 'probe') {
      st.nativeCliVersion = deps.nativeCliVersion ? await deps.nativeCliVersion(paths)
        : await probeNativeCliVersion({ nodeBin: paths.nodeBin, zcodeBin: paths.zcodeBin });
      report.nativeIdentity = await collectNativeIdentity(identityRoot, paths,
        { cliProbe: async () => st.nativeCliVersion });
    }
    transport = await spawnTransportFn({
      bridgePath: join(MODULE_DIR, 'bridge.mjs'),
      cwd, env: buildChildEnv(config, paths, request, xdgHome),
      onEvent: handleBridgeEvent,
      ipcTimeoutMs: config.bridgeIpcTimeoutMs,
    });
    tracker.setBridgePid(transport.pid);
    transport.on({ sessionUpdate: handleUpdate, requestPermission: handlePermission });

    const policy = await policyPromise;
    if (!policy || policy.timeout) throw new Error('bridge did not report its effective policy');
    assertPolicyProof(policy, request, workflowModeForRequest(request));

    const init = await transport.conn.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'codex-zcode-native-v3', version: '1.2.0' },
      clientCapabilities: {}, // no elicitation: all interactions arrive as request_permission
    });
    st.acpVersion = init?.agentInfo?.version ?? null;
    st.agentInfo = init?.agentInfo ?? null;
    if (request.quotaSnapshots) report.quotaSnapshots = { before: await captureQuota(transport.conn), after: null };

    if (request.action === 'quota') {
      tracker.setStatus('running');
      report.quotaObservation = await captureQuota(transport.conn);
      st.quota = report.quotaObservation.value ?? null;
      exitCode = await finalize('completed');
      return { exitCode, report };
    }

    tracker.setStatus('initializing');
    if (request.sessionId) {
      await transport.conn.resumeSession({ sessionId: request.sessionId, cwd, mcpServers: [] });
      st.sessionId = request.sessionId;
    } else {
      const created = await transport.conn.newSession({ cwd, mcpServers: [] });
      st.sessionId = created?.sessionId ?? null;
      if (!st.sessionId) throw new Error('session/new returned no sessionId');
    }
    tracker.setSession(st.sessionId);
    tracker.touch({ type: request.sessionId ? 'session_resumed' : 'session_created' });

    const applyAndVerify = async (configId, value) => {
      const result = await transport.conn.setSessionConfigOption({
        sessionId: st.sessionId, configId, value,
      });
      st.configOptions = result?.configOptions ?? [];
      const current = st.configOptions.find(o => o.id === configId)?.currentValue;
      if (current !== value) throw new Error(`${configId} selection mismatch: ${current}`);
      return current;
    };
    report.modelEffective = await applyAndVerify('model', `${config.provider}\\${request.model}`);
    report.modeEffective = await applyAndVerify('mode', request.mode);
    report.thoughtEffective = await applyAndVerify('thought', request.thought);
    tracker.setEffective({
      model: report.modelEffective, thought: report.thoughtEffective, mode: report.modeEffective,
    });

    if (request.action === 'probe') {
      exitCode = await finalize('completed');
      return { exitCode, report };
    }

    if (request.action === 'workflow-status') {
      tracker.setStatus('running');
      const status = await transport.ipcCall('workflow-status', { sessionId: st.sessionId });
      report.workflowStatus = status;
      exitCode = await finalize('completed');
      return { exitCode, report };
    }

    if (request.action === 'workflow-events') {
      await transport.ipcCall('bind-run', { runId: request.workflowRunId });
      const events = await transport.ipcCall('workflow-events', {
        sessionId: st.sessionId, runId: request.workflowRunId, afterSequence: request.afterSequence,
      });
      report.workflowEvents = boundWorkflowEvents(events, request.maxOutputBytes);
      if (report.workflowEvents.truncated) tracker.flagEvidence('eventsTruncated');
      exitCode = await finalize('completed');
      return { exitCode, report };
    }

    if (request.action === 'workflow-resume') {
      tracker.setStatus('running');
      tracker.addWorkflowRun(request.workflowRunId, 'stopped');
      await transport.ipcCall('bind-run', { runId: request.workflowRunId });
      const resumed = await transport.ipcCall('workflow-resume', {
        sessionId: st.sessionId, runId: request.workflowRunId,
      });
      tracker.setWorkflowRun(request.workflowRunId, 'running');
      tracker.touch({ type: 'workflow_resumed', ...resumed });
      tracker.setStatus('waiting_background');
      await waitBackgroundSettle();
      if (st.pausing) {
        exitCode = await finalize('paused');
        return { exitCode, report };
      }
      const runStatus = String(tracker.state.workflow.runs[request.workflowRunId] ?? '');
      if (/^failed/.test(runStatus)) throw new Error(`Workflow run failed: ${request.workflowRunId}`);
      exitCode = await finalize('completed');
      return { exitCode, report };
    }

    tracker.setStatus('running');
    if (request.workflowRunId && (request.nativeWorkflow || request.waitForBackground)) {
      const state = await transport.ipcCall('workflow-status', { sessionId: st.sessionId });
      const row = state.runs.find(item => item.runId === request.workflowRunId);
      if (!row) throw new Error('Requested workflow predecessor is not in this session');
      tracker.addWorkflowRun(row.runId, row.status);
      await transport.ipcCall('bind-run', { runId: row.runId });
    }
    await runPhases();
    if (st.pausing) {
      exitCode = await finalize('paused');
      return { exitCode, report };
    }
    if (!st.needsAttention) {
      await idleWindow();
    }
    const finalStatus = st.interruptReason ?? (st.pausing ? 'paused' : st.needsAttention ? 'needs_attention' : 'completed');
    exitCode = await finalize(finalStatus);
    return { exitCode, report };
  } catch (e) {
    if (st.interruptReason) {
      exitCode = await finalize(st.interruptReason, { error: e.message ?? String(e) });
    } else if (st.pausing) {
      exitCode = await finalize('paused');
    } else {
      exitCode = await finalize('failed', { error: e.message ?? String(e) });
    }
    return { exitCode, report };
  }
}
