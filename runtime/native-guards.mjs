import { createHash } from 'node:crypto';
import { resumeRunApproved } from './policy.mjs';
import { inspectWorkflowBinding } from './workflow-contract.mjs';

// Guard at request arrival too: upstream's orphan-session sweep can otherwise
// auto-allow workflow tools without reaching the ACP client permission path.
//
// Tool policy against zcode-acp-server 0.85.3 + native backend 0.17.1:
//   - toolDenylist is upstream-owned: it rides session/create and
//     session/resume only (projected onto runtimeConfig.toolDisallowlist, a
//     registry-level removal). The bridge never adds it to session/send —
//     there it is only a provider-visibility hint, and a per-turn list holding
//     every Cron mutation tool is the backend's automation-turn signal
//     (isAutomationMutationRestrictedTurn), which ordinary prompts must not
//     spoof. What this seam owns is DETECTING the compat fallback: when the
//     backend rejects the key, upstream drops it and the tool policy is NOT
//     applied — reported so the controller can refuse delivery.
//   - toolAllowlist IS a native field (0.17.1 session/create|resume strict
//     schema `toolAllowlist: array().optional()`, consumed by the runtime
//     registry as `allowedTools`). The ACP layer does not forward one, so the
//     controller-pinned review allowlist (Read/Glob/Grep) is injected here on
//     create/resume, intersected with anything the caller already sent. The
//     permission path below denies unlisted tools as the second, honest seam;
//     neither claims an OS sandbox.
//   - turn.steerQueued / turn.steerDrained (PROTOCOL.md, app-server 0.15.2+)
//     arrive as `session/event` notifications; slim copies are forwarded over
//     IPC so live-steer drain completion is proven by real events only.
const REJECTS_TOOL_DENYLIST_KEY = message => !!message
  && /unrecognized/i.test(message) && /\btoolDenylist\b/i.test(message);

/** SHA256 over the FULL text — identity for drain correlation. */
const sha256Text = text => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/**
 * Slim copies of the steer lifecycle payloads (bounded, no full echo). The
 * drained input's identity is the sha256 of its FULL text, computed BEFORE
 * the log copy is truncated — a long steer correlates by hash, never by a
 * truncated prefix. steerQueued's inputPreview may itself be truncated
 * upstream, so it is a display hint only, never identity.
 */
function slimSteerPayload(type, payload) {
  if (type === 'turn.steerQueued') {
    return {
      pendingInputId: String(payload?.pendingInputId ?? ''),
      inputPreview: String(payload?.inputPreview ?? '').slice(0, 2000),
      delivery: String(payload?.delivery ?? ''),
      targetTurnId: String(payload?.targetTurnId ?? ''),
      queueLength: Number.isInteger(payload?.queueLength) ? payload.queueLength : null,
    };
  }
  const drained = Array.isArray(payload?.drainedInputs) ? payload.drainedInputs : [];
  return {
    pendingInputIds: (Array.isArray(payload?.pendingInputIds) ? payload.pendingInputIds : [])
      .map(id => String(id)).slice(0, 20),
    targetTurnId: String(payload?.targetTurnId ?? ''),
    drainedInputs: drained.slice(0, 20).map(d => {
      const text = String(d?.text ?? '');
      return {
        pendingInputId: String(d?.pendingInputId ?? ''),
        messageId: String(d?.messageId ?? ''),
        textSha256: sha256Text(text),
        text: text.slice(0, 2000),
      };
    }),
  };
}

export function installNativeGuards(Backend, { send, request, isPermissionRequest,
  mapNativeSession = null, answerProviderAuth = null, platform = process.platform }) {
  const backendRequest = Backend.prototype.request;
  if (typeof backendRequest !== 'function') throw new Error('Native backend request hook unavailable; cannot enforce tool policy');
  let toolPolicyDegradedReported = false;
  Backend.prototype.request = function (id, method, params, timeoutMs) {
    if ((method === 'session/create' || method === 'session/resume')) {
      if (Array.isArray(request.nativeToolAllowlist) && request.nativeToolAllowlist.length > 0) {
        params = { ...params, toolAllowlist: params?.toolAllowlist
          ? request.nativeToolAllowlist.filter(tool => params.toolAllowlist.includes(tool))
          : [...request.nativeToolAllowlist] };
      }
    }
    const observesDenylist = (method === 'session/create' || method === 'session/resume')
      && Array.isArray(params?.toolDenylist) && params.toolDenylist.length > 0;
    const result = backendRequest.call(this, id, method, params, timeoutMs);
    if (observesDenylist && !toolPolicyDegradedReported && typeof result?.then === 'function') {
      result.then(resp => {
        if (!REJECTS_TOOL_DENYLIST_KEY(resp?.error?.message)) return;
        toolPolicyDegradedReported = true;
        send({ type: 'tool_policy_degraded',
          reason: 'backend rejects toolDenylist; ZCODE_DISALLOWED_TOOLS / the Cron* defaults are NOT applied on this backend' });
      }).catch(() => { /* observation only */ });
    }
    return result;
  };
  const handleNotification = Backend.prototype.handleNotification;
  if (typeof handleNotification === 'function') {
    Backend.prototype.handleNotification = function (method, params) {
      try {
        const type = method === 'session/event' ? params?.type : null;
        if (['turn.started', 'turn.completed', 'turn.failed'].includes(type)) {
          const payload = params.payload ?? {};
          send({ type: 'native_turn', kind: type.slice(5),
            acpSessionIds: mapNativeSession?.(params.sessionId) ?? [],
            turnId: params.turnId ?? payload.turnId ?? null,
            inputSource: payload.inputSource, resultType: payload.resultType,
            errorCode: type === 'turn.failed' ? 'native_turn_failed' : null });
        }
        if (type === 'turn.steerQueued' || type === 'turn.steerDrained') {
          // session/event carries the NATIVE backend sid; the runner only
          // knows the ACP alias (session/new's random acpSid). Map through the
          // captured server's own reverse index so the runner's filter sees
          // the real conversation; an unmapped native sid is a foreign
          // session and forwards as an empty alias list (rejected downstream).
          let acpSessionIds = [];
          const nativeSessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
          if (mapNativeSession && nativeSessionId) {
            const mapped = mapNativeSession(nativeSessionId);
            acpSessionIds = Array.isArray(mapped) ? mapped.filter(id => typeof id === 'string') : [];
          }
          send({ type: 'steer_event', kind: type === 'turn.steerQueued' ? 'steerQueued' : 'steerDrained',
            nativeSessionId, acpSessionIds,
            payload: slimSteerPayload(type, params?.payload) });
        }
      } catch { /* observation only */ }
      return handleNotification.call(this, method, params);
    };
  }
  const watchdog = Backend.prototype.startWatchdog;
  Backend.prototype.startWatchdog = function () {
    const pid = this.proc.pid;
    if (pid) send({ type: 'native_started', pid });
    this.proc.once('exit', () => {
      if (process.connected) send({ type: 'native_exited', pid });
    });
    if (platform !== 'win32') return watchdog.call(this);
  };
  const handle = Backend.prototype.handleServerRequest;
  Backend.prototype.handleServerRequest = function (req) {
    if (answerProviderAuth?.(this, req)) return true;
    const p = req.params ?? {};
    if (isPermissionRequest(req.method)) {
      if (request.disallowedTools?.includes(p.toolName)) {
        const reason = `Tool disabled by controller: ${p.toolName}`;
        this.sendReply(req.id, { decision: 'deny', reason });
        send({ type: 'policy_denied', toolName: p.toolName, reason });
        return true;
      }
      // Review allowlist: when the controller pins one (fresh reviewer runs
      // Read/Glob/Grep only), any OTHER tool asking permission is denied at
      // arrival. This is a permission-path denial, not a sandbox claim —
      // auto-allowed tools that never ask are covered by the registry-level
      // denylist/allowlist params above and stay post-hoc observed.
      if (Array.isArray(request.nativeToolAllowlist) && request.nativeToolAllowlist.length > 0
        && typeof p.toolName === 'string' && !request.nativeToolAllowlist.includes(p.toolName)) {
        const reason = `Tool outside the controller allowlist: ${p.toolName}`;
        this.sendReply(req.id, { decision: 'deny', reason });
        send({ type: 'policy_denied', toolName: p.toolName, reason });
        return true;
      }
      const workflow = ['CreateWorkflow', 'AmendWorkflow'].includes(p.toolName);
      const resume = p.toolName === 'ResumeWorkflowRun';
      const binding = workflow ? inspectWorkflowBinding(request, p.input) : null;
      const allowed = workflow ? binding.matched
        && (p.toolName !== 'AmendWorkflow' || resumeRunApproved(request, p.input))
        : resume ? resumeRunApproved(request, p.input) : true;
      if (!allowed) {
        const reason = `Controller workflow binding mismatch: ${binding?.reason ?? 'predecessor run ID mismatch'}`;
        this.sendReply(req.id, { decision: 'deny', reason });
        send({ type: 'policy_denied', toolName: p.toolName, reason });
        return true;
      }
    }
    return handle.call(this, req);
  };
}
