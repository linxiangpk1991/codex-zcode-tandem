const DISABLED_POLICY = {
  configPath: 'C:\\tmp\\xdg\\zcode-acp\\config.json',
  sessionMode: 'build',
  quotaAutoResume: false,
  remote: 'disabled',
  workflowOverride: { mode: 'disabled', enabled: false, source: 'override' },
};

export class FakeTransport {
  constructor({ policy = DISABLED_POLICY, script = [], workflowRuns = [], ipcHandlers = {},
    modeReadback = null, sessionId = "sess-1" } = {}) {
    this.policy = policy;
    this.script = script;
    this.workflowRuns = workflowRuns;
    this.ipcHandlers = ipcHandlers;
    this.modeReadback = modeReadback;
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
        return { agentInfo: { name: 'zcode-acp-server', version: '0.72.0' } };
      },
      newSession: async () => ({ sessionId, modes: [], configOptions: [] }),
      resumeSession: async () => ({ modes: [], configOptions: [] }),
      setSessionConfigOption: async ({ configId, value }) => ({
        configOptions: [{
          id: configId,
          currentValue: configId === 'mode' && this.modeReadback !== null ? this.modeReadback : value,
        }],
      }),
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
