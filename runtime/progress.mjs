// Atomic progress snapshots (PROGRESS.json). One object, written on a 15s
// heartbeat AND on every meaningful event, always via temp+rename. Retained
// evidence is bounded; truncation is flagged, never silent. "Last actual
// activity" (a real protocol event) is tracked separately from the heartbeat
// timestamp so a controller can distinguish a live phase from a stalled one.
import { writeJsonAtomic } from './jsonio.mjs';

const CONTROL_STATES = ['queued', 'accepted', 'started', 'completed', 'rejected', 'ignored'];

export class ProgressTracker {
  constructor(opts) {
    const { invocationId, cwd, request, config, progressPath, controllerPid, inboxPath, now } = opts;
    this.now = now ?? (() => new Date());
    this.path = progressPath;
    this.config = config;
    this.startedAt = this.now().toISOString();
    this.state = {
      version: 3,
      runtimeRoot: opts.runtimeRoot ?? null,
      invocationId,
      startedAt: this.startedAt,
      updatedAt: this.startedAt,
      cwd,
      provider: config.provider,
      model: { requested: request.model, effective: null },
      thought: { requested: request.thought, effective: null },
      mode: { requested: request.mode, effective: null },
      sessionId: null,
      workflowRunIds: [],
      status: 'starting',
      phase: { index: -1, label: null, total: request.prompts?.length ?? 0 },
      controller: { pid: controllerPid ?? process.pid, bridgePid: null, nativePids: [] },
      currentTurn: null,
      turns: [],
      lastEvent: null,
      lastTool: null,
      activity: { lastActivityAt: null, lastHeartbeatAt: null, eventsSeen: 0, bytesSeen: null,
        bytesScope: 'not measured; event count is not token or network usage' },
      controls: { queue: [], history: [] },
      pendingInput: null,
      workflow: { mode: request.nativeWorkflow || request.waitForBackground ? 'onDemand' : 'disabled', runs: {}, notificationState: null },
      backgroundTasks: [],
      replay: { chars: 0, truncated: false },
      evidence: {
        toolsTruncated: false, permissionsTruncated: false, responseTruncated: false,
        replayTruncated: false, eventsTruncated: false, controlsTruncated: false,
        turnsTruncated: false,
      },
      controlInbox: inboxPath,
      deadline: {
        startedAt: this.startedAt, timeoutSeconds: request.timeoutSeconds, idleSeconds: request.idleSeconds,
      },
      error: null,
      quotaPause: null,
    };
  }

  get invocationId() { return this.state.invocationId; }
  get status() { return this.state.status; }
  get pendingInput() { return this.state.pendingInput; }

  snapshot() {
    this.refreshControlAges();
    return JSON.parse(JSON.stringify(this.state));
  }

  write(reason = 'event') {
    this.refreshControlAges();
    this.state.updatedAt = this.now().toISOString();
    this.state.activity.lastHeartbeatAt = this.state.updatedAt;
    if (!this.path) return;
    try {
      writeJsonAtomic(this.path, this.state);
    } catch (e) {
      console.error(`[zcode-v3 progress] ${e.message} (${reason})`);
    }
  }

  heartbeat() { this.write('heartbeat'); }

  /** Record a real protocol event (distinguishes activity from heartbeat). */
  touch(event = null, bytes = null) {
    this.state.activity.lastActivityAt = this.now().toISOString();
    this.state.activity.eventsSeen += 1;
    if (Number.isFinite(bytes)) this.state.activity.bytesSeen = (this.state.activity.bytesSeen ?? 0) + bytes;
    if (event) {
      this.state.lastEvent = compactEvent(event, this.config.compactByteLimit);
    }
    this.write('event');
  }

  noteActivity() {
    this.state.activity.lastActivityAt = this.now().toISOString();
  }

  setStatus(status, extra = {}) {
    this.state.status = status;
    Object.assign(this.state, extra);
    this.write('status');
  }

  setEffective({ model, thought, mode } = {}) {
    if (model !== undefined) this.state.model.effective = model;
    if (thought !== undefined) this.state.thought.effective = thought;
    if (mode !== undefined) this.state.mode.effective = mode;
    this.write('effective');
  }

  setSession(sessionId) {
    this.state.sessionId = sessionId;
    this.write('session');
  }

  setBridgePid(pid) { this.state.controller.bridgePid = pid; }
  setNativePids(pids) { this.state.controller.nativePids = [...pids]; }

  setPhase(index, label) {
    this.state.phase = { ...this.state.phase, index, label };
    this.write('phase');
  }

  setCurrentTurn(turn) {
    this.state.currentTurn = turn;
    this.write('turn');
  }

  addTurn(turn) {
    this.state.turns.push(turn);
    if (this.state.turns.length > this.config.maxTurns) {
      this.state.turns.shift();
      this.state.evidence.turnsTruncated = true;
    }
  }

  setLastTool(tool) {
    this.state.lastTool = tool;
  }

  noteReplay(chars) {
    const r = this.state.replay;
    r.chars += chars;
    if (r.chars > this.config.replayCharLimit) {
      r.chars = this.config.replayCharLimit;
      r.truncated = true;
      this.state.evidence.replayTruncated = true;
    }
  }

  flagEvidence(flag) {
    this.state.evidence[flag] = true;
  }

  setPendingInput(pi) {
    this.state.pendingInput = pi;
    this.state.status = pi ? 'needs_input' : this.state.status === 'needs_input' ? 'running' : this.state.status;
    this.write('pendingInput');
  }

  addWorkflowRun(runId, status = 'launched') {
    if (!runId) return;
    if (!this.state.workflowRunIds.includes(runId)) this.state.workflowRunIds.push(runId);
    this.state.workflow.runs[runId] = status;
    this.write('workflow');
  }

  setWorkflowRun(runId, status) {
    if (runId && this.state.workflow.runs[runId] !== undefined) {
      this.state.workflow.runs[runId] = status;
      this.write('workflow');
    }
  }

  setNotificationState(state) {
    this.state.workflow.notificationState = state;
    this.write('notification');
  }

  setBackgroundTasks(tasks) {
    this.state.backgroundTasks = tasks.slice(-50);
  }

  setQuotaPause(info) {
    this.state.quotaPause = info;
    this.write('quota');
  }

  setError(error) {
    this.state.error = error;
    this.write('error');
  }

  /** Queue/ack lifecycle for control commands (accepted/completed/rejected + why). */
  recordControl(id, action, state, detail = null, submittedAt = null) {
    if (!CONTROL_STATES.includes(state)) throw new Error(`bad control state: ${state}`);
    const queue = this.state.controls.queue;
    const history = this.state.controls.history;
    const existing = queue.findIndex(c => c.id === id);
    const previous = existing >= 0 ? queue[existing] : history.find(c => c.id === id);
    const at = this.now().toISOString();
    const entry = { ...previous, id, action, state, detail, at,
      submittedAt: previous?.submittedAt ?? submittedAt ?? at,
      transitions: [...(previous?.transitions ?? []), { state, at }].slice(-12) };
    if (state === 'accepted') entry.acceptedAt ??= at;
    if (state === 'started') entry.startedAt ??= at;
    if (entry.startedAt) { entry.queueAgeMs = 0; entry.queueWarning = null; }
    if (['completed', 'rejected', 'ignored'].includes(state)) entry.finishedAt = at;
    if (state === 'completed') entry.completedAt = at;
    entry.queueDurationMs = entry.startedAt ? Date.parse(entry.startedAt) - Date.parse(entry.submittedAt) : null;
    entry.executionDurationMs = entry.startedAt && entry.finishedAt ? Date.parse(entry.finishedAt) - Date.parse(entry.startedAt) : null;
    if (existing >= 0) queue.splice(existing, 1);
    if (['queued', 'accepted', 'started'].includes(state)) {
      queue.push(entry);
    } else {
      history.push(entry);
      if (history.length > this.config.maxControls) {
        history.shift();
        this.state.evidence.controlsTruncated = true;
      }
    }
    this.write('control');
    return entry;
  }

  refreshControlAges() {
    const now = this.now().getTime();
    for (const entry of this.state.controls.queue) {
      entry.queueAgeMs = entry.startedAt ? 0 : Math.max(0, now - Date.parse(entry.submittedAt));
      entry.queueWarning = !entry.startedAt && entry.queueAgeMs >= (this.config.queueWarningMs ?? 300_000)
        ? 'waiting_for_foreground_boundary' : null;
    }
  }

  dropQueuedControls(reason) {
    for (const c of this.state.controls.queue.slice()) {
      this.recordControl(c.id, c.action, 'rejected', reason);
    }
  }
}

function compactEvent(event, limit) {
  const json = JSON.stringify(event);
  if (json && json.length > limit) {
    return { truncated: true, preview: json.slice(0, limit) };
  }
  return event;
}
