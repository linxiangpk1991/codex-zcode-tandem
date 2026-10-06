// bridge.mjs — the spawned ACP bridge adapter (child of run-task.mjs).
//
// Upstream zcode-acp-server 0.65.1 owns transport and inference end to end;
// this file adds ONLY the seams a headless controller needs, using upstream's
// own modules rather than reimplementing v4 business rules:
//   1. effective-policy proof: the isolated XDG_CONFIG_HOME config read back
//      through upstream's own accessors and reported over IPC;
//   2. capture of the ZcodeAcpServer instance (initialize hook) so native
//      backend PIDs and the workflow management API are reachable;
//   3. Windows PID tracking over IPC (upstream's negative-PID watchdog is
//      POSIX-only; the owning client reaps the tree it spawned);
//   4. the background notification TURN BOUNDARY (upstream forwards the
//      notification text but not its completion boundary; without it a
//      following prompt can consume the notification as its own reply);
//   5. a narrowly allowlisted workflow op adapter over upstream
//      settings/workflow.js (status/events/settings/stop/resume) with exact
//      run binding, cwd/session identity checks and pre-resume state readback.
// The V2 dynamicWorkflowEnabled injection monkey patch is GONE: the formal
// workflow gate now consumes the isolated config's workflow.mode.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { installNativeGuards } from './native-guards.mjs';

const PKG = 'zcode-acp-server/dist';

/** Effective policy of THIS bridge process, via upstream's own accessors. */
export async function snapshotEffectivePolicy(env = process.env, upstream = null) {
  const u = upstream ?? await importUpstreamAt();
  const override = u.workflowOverrideNow(env);
  return {
    configPath: u.userConfigPath(env),
    sessionMode: u.initialSessionMode(env),
    quotaAutoResume: u.quotaAutoResumeEnabled(env),
    workflowOverride: override ? { mode: override.mode, enabled: override.enabled, source: override.source } : null,
    remote: u.parseRemoteConfig(env) ? 'enabled' : 'disabled',
  };
}

async function importUpstreamAt(root = PKG) {
  const [userConfig, settings, gate, remote] = await Promise.all([
    import(`${root}/config/user-config.js`),
    import(`${root}/config/settings.js`),
    import(`${root}/config/workflow-gate.js`),
    import(`${root}/remote/config.js`),
  ]);
  return {
    loadUserConfig: userConfig.loadUserConfig,
    userConfigPath: userConfig.userConfigPath,
    initialSessionMode: settings.initialSessionMode,
    quotaAutoResumeEnabled: settings.quotaAutoResumeEnabled,
    workflowOverrideNow: gate.workflowOverrideNow,
    parseRemoteConfig: remote.parseRemoteConfig,
  };
}

/**
 * Retain the ZcodeAcpServer instance main() creates by wrapping initialize.
 * The wrapper changes no behavior — it observes `this` once and delegates.
 */
export function captureServerViaInitialize(ServerClass, onCapture) {
  if (ServerClass.prototype.__zcodeV3Capture) {
    if (onCapture) ServerClass.prototype.__zcodeV3CaptureHooks.push(onCapture);
    return () => ServerClass.prototype.__zcodeV3CaptureServer ?? null;
  }
  const hooks = onCapture ? [onCapture] : [];
  let captured = null;
  const original = ServerClass.prototype.initialize;
  ServerClass.prototype.initialize = function wrappedInitialize(...args) {
    if (!captured) {
      captured = this;
      for (const hook of hooks.splice(0)) hook(this);
    }
    return original.apply(this, args);
  };
  Object.defineProperty(ServerClass.prototype, '__zcodeV3Capture', { value: true });
  Object.defineProperty(ServerClass.prototype, '__zcodeV3CaptureHooks', { value: hooks });
  Object.defineProperty(ServerClass.prototype, '__zcodeV3CaptureServer', {
    get: () => captured, configurable: true,
  });
  return () => captured;
}

/**
 * Background notification boundary: forward start/end of the model's
 * background-notification turn to the client with an explicit marker (empty
 * text chunk + _meta.codexZcodeBackgroundNotification), so the controller can
 * tell "notification finished" from "still summarizing".
 */
export function installNotificationBoundaryPatch(ListenerClass) {
  if (ListenerClass.prototype.__zcodeV3Boundary) return;
  const handleEvent = ListenerClass.prototype.handleEvent;
  ListenerClass.prototype.handleEvent = function wrappedHandleEvent(event) {
    const previous = this.activeNotifyTurnId;
    handleEvent.call(this, event);
    let state = null;
    if (event?.type === 'turn.started' && event.payload?.inputSource === 'background_task' && this.activeNotifyTurnId) {
      state = 'started';
    } else if (previous && !this.activeNotifyTurnId
      && (event?.type === 'turn.completed' || event?.type === 'turn.failed')) {
      state = event.type === 'turn.completed' ? 'completed' : 'failed';
    }
    if (state) {
      const turnId = event.turnId ?? event.payload?.turnId ?? previous ?? '';
      void this.server.notifyByZcodeSid(this.zcodeSid, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { codexZcodeBackgroundNotification: { state, turnId } },
      }).catch(e => console.error(`[zcode-v3 bridge] boundary delivery failed: ${e.message}`));
    }
  };
  Object.defineProperty(ListenerClass.prototype, '__zcodeV3Boundary', { value: true });
}

/**
 * Track the native backend PID(s) over IPC. The captured server's backend can
 * be REPLACED mid-run (respawn, sandbox restart), so identity is polled.
 */
export function createPidTracker({ getServer, send, intervalMs = 1000,
  setIntervalFn = (fn, ms) => setInterval(fn, ms), clearIntervalFn = clearInterval }) {
  let lastBackend = null;
  let lastPid = null;
  let deadReported = false;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const backend = getServer()?.backend ?? null;
    if (backend !== lastBackend) {
      if (lastPid) send({ type: 'native_exited', pid: lastPid });
      deadReported = false;
      lastBackend = backend;
      lastPid = backend?.proc?.pid ?? null;
      if (lastPid) send({ type: 'native_started', pid: lastPid });
    }
    if (backend?.isDead && !deadReported) {
      deadReported = true;
      send({ type: 'backend_dead', pid: lastPid });
    }
  };
  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();
  tick();
  return {
    stop() { stopped = true; clearIntervalFn(timer); },
    pids() { return lastPid ? [lastPid] : []; },
  };
}

function sameDir(a, b) {
  if (!a || !b) return false;
  try { a = realpathSync(a); b = realpathSync(b); } catch { /* retain fail-closed lexical comparison */ }
  if (process.platform === 'win32') return a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');
  return a === b;
}

/**
 * The allowlisted workflow op adapter. Every op reuses upstream
 * settings/workflow.js against the captured server. Ops address EXACTLY the
 * bound run ids (parent binds what it observed launching/approving) and the
 * invocation's own session and cwd. There is deliberately no generic RPC
 * passthrough, no model/script edit, and no replay on unknown outcomes.
 */
export function createWorkflowOps({ getServer, expectedCwd, workflow }) {
  const boundRuns = new Set();
  const requireServer = () => {
    const server = getServer();
    if (!server) throw opError('not_ready', 'bridge server not captured yet');
    return server;
  };
  const requireSession = (server, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) throw opError('session_mismatch', 'sessionId required');
    const zcodeSid = server.resolveSid(sessionId);
    if (!zcodeSid) throw opError('session_mismatch', `session ${sessionId} is not owned by this bridge`);
    const cwd = server.sessionCwds.get(sessionId);
    if (expectedCwd && (!cwd || !sameDir(cwd, expectedCwd))) {
      throw opError('session_mismatch', 'session cwd does not match this invocation');
    }
    return zcodeSid;
  };
  const requireBoundRun = (payload) => {
    const runId = payload?.runId;
    if (typeof runId !== 'string' || !runId) throw opError('not_bound', 'runId required');
    if (!boundRuns.has(runId)) throw opError('not_bound', `run ${runId} is not bound to this invocation`);
    return runId;
  };
  const asError = (e) => ({
    message: e?.message ?? String(e),
    reason: e?.reason ?? null,
    code: e?.code ?? null,
  });
  async function readBoundRun(server, payload) {
    const zcodeSid = requireSession(server, payload.sessionId);
    const runId = requireBoundRun(payload);
    const state = await workflow.conversationRuns(server, zcodeSid, 64);
    const row = (state?.runs ?? []).find(r => r?.runId === runId);
    if (!row) throw opError('run-state', 'bound run not present in this session');
    return row;
  }
  const ops = {
    async 'bind-run'(payload) {
      const runId = payload?.runId;
      if (typeof runId !== 'string' || !runId) throw opError('not_bound', 'runId required');
      boundRuns.add(runId);
      return { bound: [...boundRuns] };
    },
    async 'workflow-status'(payload) {
      const server = requireServer();
      const zcodeSid = requireSession(server, payload?.sessionId);
      const result = await workflow.conversationRuns(server, zcodeSid, 64);
      return { runs: result?.runs ?? [] };
    },
    async 'workflow-events'(payload) {
      const server = requireServer();
      const zcodeSid = requireSession(server, payload.sessionId);
      const runId = requireBoundRun(payload);
      await readBoundRun(server, payload);
      return workflow.runEvents(server, zcodeSid, runId, payload.afterSequence);
    },
    async 'workflow-stop'(payload) {
      const server = requireServer();
      requireSession(server, payload.sessionId);
      const runId = requireBoundRun(payload);
      const before = await readBoundRun(server, payload);
      if (!['running', 'pending'].includes(before.status)) return { stopped: runId, run: before, alreadySettled: true };
      try { await workflow.stopWorkflowRun(server, { runId, acpSessionId: payload.sessionId }); }
      catch (e) {
        if (e.reason !== 'not_running') throw e;
        const after = await readBoundRun(server, payload);
        if (['running', 'pending'].includes(after.status)) throw e;
        return { stopped: runId, run: after, alreadySettled: true };
      }
      let run;
      for (let i = 0; i < 20; i += 1) {
        run = await readBoundRun(server, payload);
        if (!['running', 'pending'].includes(run.status)) return { stopped: runId, run };
        await new Promise(r => setTimeout(r, 250));
      }
      throw opError('unknown_outcome', 'stop accepted but terminal state not confirmed; read back before retry');
    },
    async 'workflow-settings'(payload) {
      const server = requireServer();
      requireSession(server, payload.sessionId);
      const runId = requireBoundRun(payload);
      const keys = Object.keys(payload ?? {});
      if (keys.some(k => !['sessionId', 'runId', 'maxConcurrency'].includes(k))) {
        throw opError('forbidden_key', 'workflow-settings accepts only maxConcurrency');
      }
      if (!Number.isInteger(payload.maxConcurrency) || payload.maxConcurrency < 1 || payload.maxConcurrency > 4) {
        throw opError('invalid_value', 'maxConcurrency must be an integer within 1..4');
      }
      await readBoundRun(server, payload);
      const result = await workflow.amendRunSettings(server, {
        acpSessionId: payload.sessionId, runId, maxConcurrency: payload.maxConcurrency,
      });
      return { acknowledgement: result, run: await readBoundRun(server, payload) };
    },
    async 'workflow-resume'(payload) {
      const server = requireServer();
      requireSession(server, payload.sessionId);
      const runId = requireBoundRun(payload);
      // Pre-resume readback: the run must be stopped and resumable right now.
      const zcodeSid = requireSession(server, payload.sessionId);
      const state = await workflow.conversationRuns(server, zcodeSid, 64);
      const row = (state?.runs ?? []).find(r => r?.runId === runId);
      if (!row) throw opError('run-state', 'bound run not present in run list');
      if (!['stopped', 'cancelled', 'failed'].includes(row.status) || row.resumable !== true) {
        throw opError('run-state', `run is ${row.status} (resumable=${row.resumable}) — refusing to resume`);
      }
      await workflow.resumeWorkflowRun(server, { runId, acpSessionId: payload.sessionId });
      return { accepted: runId, run: await readBoundRun(server, payload) };
    },
  };
  return {
    bindRun(runId) { if (runId) boundRuns.add(runId); },
    boundRuns: () => [...boundRuns],
    async handle(op, payload) {
      const fn = ops[op];
      if (!fn) throw opError('unknown_op', `unsupported op: ${op}`);
      return fn(payload ?? {});
    },
    asError,
  };
}

function opError(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  e.isOpError = true;
  return e;
}

/**
 * Bridge entry point. Environment (set by run-task.mjs) carries the isolated
 * XDG_CONFIG_HOME and pinned engine/provider env. Sends one 'policy' IPC
 * message immediately, then hands the process to upstream main().
 */
export async function bridgeMain({ env = process.env, send = m => process.send?.(m),
  upstreamRoot = PKG } = {}) {
  const [indexMod, serverMod, listenerMod, workflowMod, upstream] = await Promise.all([
    import(`${upstreamRoot}/index.js`),
    import(`${upstreamRoot}/server.js`),
    import(`${upstreamRoot}/handlers/background-tasks.js`),
    import(`${upstreamRoot}/settings/workflow.js`),
    importUpstreamAt(upstreamRoot),
  ]);
  installNotificationBoundaryPatch(listenerMod.BackgroundTaskListener);
  const getServer = captureServerViaInitialize(serverMod.ZcodeAcpServer);
  const backendMod = await import(`${upstreamRoot}/backend/client.js`);
  const adapterMod = await import(`${upstreamRoot}/interaction/adapter.js`);
  installNativeGuards(backendMod.ZcodeBackend, {
    send, request: JSON.parse(env.CODEX_ZCODE_BINDINGS ?? '{}'),
    isPermissionRequest: adapterMod.isPermissionRequest,
  });
  const workflow = {
    conversationRuns: workflowMod.conversationRuns,
    runEvents: workflowMod.runEvents,
    resumeWorkflowRun: workflowMod.resumeWorkflowRun,
    stopWorkflowRun: workflowMod.stopWorkflowRun,
    amendRunSettings: workflowMod.amendRunSettings,
  };
  const ops = createWorkflowOps({
    getServer, expectedCwd: process.cwd(), workflow,
  });
  const policy = await snapshotEffectivePolicy(env, upstream);
  send({ type: 'policy', policy });
  let tracker = createPidTracker({ getServer, send });
  const ensureTracker = () => {
    if (!tracker) tracker = createPidTracker({ getServer, send });
  };
  process.on('message', message => {
    if (!message || message.v3ipc !== true || typeof message.id !== 'string') return;
    Promise.resolve()
      .then(async () => {
        if (message.op === 'ping') return { pong: true };
        ensureTracker();
        return ops.handle(message.op, message.payload);
      })
      .then(result => send({ v3ipc: true, id: message.id, ok: true, result }))
      .catch(e => send({
        v3ipc: true, id: message.id, ok: false,
        error: ops.asError(e),
      }));
  });
  process.on('disconnect', () => process.exit(0));
  await indexMod.main();
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && basename(entry) === 'bridge.mjs'
      && realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  bridgeMain().catch(e => {
    console.error(`[zcode-v3 bridge] fatal: ${e.stack ?? e.message}`);
    process.exit(1);
  });
}
