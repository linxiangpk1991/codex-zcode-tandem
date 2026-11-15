import { randomUUID } from 'node:crypto';
import { buildPendingInput, classifyPermissionRequest, decideToolPermission, selectOption, nativeToolName } from './policy.mjs';
import { normalizeFormSchema, matchesAnswer } from './question-form.mjs';

export function createInteractions({ st, tracker, report, config, request, scopeObserver, warn, observeRun, bindRun, deadlineAt, delay }) {
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
        const offered = matchesAnswer(pi, { ...queued, interactionId: pi.interactionId });
        return offered
          ? { kind: 'answer', optionId: queued.optionId, answers: queued.answers, commandId: queued.commandId }
          : { kind: 'invalid', commandId: queued.commandId, why: `optionId not offered: ${queued.optionId}` };
      }
      if (Date.now() >= deadlineAt) return { kind: 'timeout' };
      await delay(200);
    }
  }

  async function handleElicitation(params) {
    if (st.finalized || st.pausing) return { action: 'cancel' };
    const tool = st.trackedToolCalls.get(params?.toolCallId);
    // The same wire method also carries plan approval and MCP URL requests.
    // Only observed AskUserQuestion calls in this session can enter answer.
    if (params?.mode !== 'form' || params.sessionId !== st.sessionId
      || nativeToolName(tool) !== 'AskUserQuestion' || tracker.state.pendingInput) {
      st.needsAttention = true;
      warn('Unsupported or non-question elicitation refused');
      return { action: 'decline' };
    }
    let schema;
    try { schema = normalizeFormSchema(params.requestedSchema); }
    catch (e) { st.needsAttention = true; warn(e.message); return { action: 'decline' }; }
    const pi = { interactionId: `form-${randomUUID()}`, toolCallId: params.toolCallId,
      kind: 'question', format: 'form', question: params.message, schema };
    tracker.setPendingInput(pi);
    try {
      const answer = await waitForAnswer(pi);
      if (st.finalized || st.pausing) return { action: 'cancel' };
      if (answer.kind === 'timeout') throw new Error('Task deadline reached while a form was pending');
      if (answer.kind !== 'answer') return { action: 'cancel' };
      tracker.recordControl(answer.commandId, 'answer', 'started');
      tracker.recordControl(answer.commandId, 'answer', 'completed', 'structured ordinary-question answer delivered');
      return { action: 'accept', content: answer.answers };
    } finally { if (!st.finalized) tracker.setPendingInput(null); }
  }
  return { handlePermission, handleElicitation };
}
