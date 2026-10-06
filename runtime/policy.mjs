// Permission and interaction policy. Pure logic, injectable dependencies —
// no transport; a path-based workflow hashes only the declared script file.
// Three interaction classes are kept strictly apart:
//   question      — upstream AskUserQuestion mapped to request_permission
//                   (preceded by a tool_call with _meta.claudeCode.toolName
//                   "AskUserQuestion"); resolved only by an explicit control
//                   answer with an exact offered optionId.
//   plan_approval — ExitPlanMode approve/reject; also user-decided.
//   tool          — ordinary tool grant; decided HERE by pre-authorization
//                   only (kind allowlist + workflow hash bindings). Never
//                   answerable through the generic answer action, never
//                   session-exempted (allowSession would bypass the binding
//                   checks on later calls).
import { createHash } from 'node:crypto';
import { readWorkflowScript, canonicalWorkflowModel } from './workflow-observation.mjs';

/** ACP kinds for well-known native tools (V2 parity). */
export const KIND_BY_TOOL = Object.freeze({
  Read: 'read', Glob: 'search', Grep: 'search', Edit: 'edit', Write: 'edit',
  MultiEdit: 'edit', ApplyPatch: 'edit', Bash: 'execute',
  Skill: 'read', GetWorkflowRun: 'read', GetWorkflowNodeResult: 'read',
});

/** Native name of a tracked tool_call update (upstream meta, else title head). */
export function nativeToolName(toolUpdate) {
  return toolUpdate?._meta?.claudeCode?.toolName
    ?? (typeof toolUpdate?.title === 'string' ? toolUpdate.title.split(':', 1)[0] : undefined);
}

/**
 * Classify an incoming session/request_permission. `lookupToolCall` resolves a
 * toolCallId to the preceding tool_call update the bridge emitted (the reliable
 * signal); a conservative option-shape heuristic covers a miss.
 */
export function classifyPermissionRequest(p, lookupToolCall) {
  const toolCallId = p?.toolCall?.toolCallId ?? '';
  const meta = lookupToolCall(toolCallId);
  const metaName = meta ? nativeToolName(meta) : undefined;
  if (metaName === 'AskUserQuestion') return { kind: 'question', nativeName: metaName };
  if (metaName === 'ExitPlanMode') return { kind: 'plan_approval', nativeName: metaName };
  if (metaName) return { kind: 'tool', nativeName: metaName };
  // Fallback: upstream's own option shapes.
  const options = p?.options ?? [];
  const optionIds = options.map(o => o.optionId);
  if (optionIds.includes('approve') && optionIds.includes('reject') && optionIds.length === 2) {
    return { kind: 'plan_approval', nativeName: 'ExitPlanMode' };
  }
  if (optionIds.includes('__skip__') || optionIds.some(id => id.endsWith(':yes') || id.endsWith(':no'))) {
    return { kind: 'question', nativeName: 'AskUserQuestion' };
  }
  const titleName = typeof p?.toolCall?.title === 'string' ? p.toolCall.title.split(':', 1)[0] : '';
  return { kind: 'tool', nativeName: titleName || null };
}

/** Exact script hash and model; path inputs use the same reader as observation. */
export function workflowApproved(request, input) {
  try {
    const { script } = readWorkflowScript(input, request.cwd ?? process.cwd());
    const hash = createHash('sha256').update(script).digest('hex');
    return hash === request.approvedWorkflowSha256
      && typeof request.approvedWorkflowModel === 'string'
      && canonicalWorkflowModel(input.subagent_model) === request.approvedWorkflowModel;
  } catch { return false; }
}

/** ResumeWorkflowRun is bound to the request's exact workflowRunId. */
export function resumeRunApproved(request, input) {
  return typeof request.workflowRunId === 'string'
    && typeof input?.run_id === 'string'
    && request.workflowRunId === input.run_id;
}

/**
 * Decide one ordinary tool grant. Unknown tools are denied; known tools are
 * allowed only through the pre-authorized kind allowlist or the workflow
 * bindings. Returns {allowed, reason, binding}.
 */
export function decideToolPermission({ request, nativeName, acpKind, rawInput }) {
  if (nativeName === 'CreateWorkflow' || nativeName === 'AmendWorkflow') {
    const scriptApproved = workflowApproved(request, rawInput);
    const targetApproved = nativeName !== 'AmendWorkflow' || resumeRunApproved(request, rawInput);
    const allowed = scriptApproved && targetApproved;
    return {
      allowed,
      reason: allowed ? 'approved workflow binding' : !scriptApproved
        ? 'workflow script/model binding mismatch' : 'amend predecessor run ID mismatch',
      binding: nativeName,
    };
  }
  if (nativeName === 'ResumeWorkflowRun') {
    const allowed = resumeRunApproved(request, rawInput);
    return {
      allowed,
      reason: allowed ? 'bound workflowRunId' : 'workflowRunId not bound in request',
      binding: 'ResumeWorkflowRun',
    };
  }
  const kind = KIND_BY_TOOL[nativeName];
  if (!nativeName || !kind) {
    return { allowed: false, reason: 'unknown tool — denied', binding: null };
  }
  const allowed = (request.allowToolKinds ?? []).includes(kind);
  return { allowed, reason: allowed ? `kind ${kind} allowed` : `kind ${kind} not allowed`, binding: null };
}

/**
 * Pick the option object to return. Only one-shot options are ever selected:
 * allow_always/allowSession tiers would arm upstream session auto-allow and
 * skip this policy on later calls.
 */
export function selectOption(options, allowed) {
  const wanted = allowed ? 'allow_once' : 'reject_once';
  return (options ?? []).find(o => o?.kind === wanted) ?? null;
}

/** Bounded pendingInput record exposed in progress (needs_input). */
export function buildPendingInput({ interactionId, kind, nativeName, title, options, rawInput }) {
  const boundedOptions = (options ?? []).slice(0, 12).map(o => ({
    optionId: o.optionId ?? '', kind: o.kind ?? '', name: (o.name ?? '').slice(0, 200),
  }));
  return {
    interactionId: String(interactionId).slice(0, 200),
    kind, // question | plan_approval
    nativeName: nativeName ?? null,
    question: String(title ?? '').slice(0, 2000),
    options: boundedOptions,
    optionsTruncated: (options ?? []).length > boundedOptions.length,
    rawInputPreview: rawInput === undefined ? null
      : JSON.stringify(rawInput).slice(0, 2000),
    askedAt: new Date().toISOString(),
  };
}

/** V2 helpers retained for tool bookkeeping. */
export function isTool(tool, name) {
  return nativeToolName(tool) === name;
}

export function mergeBackgroundTask(previous, metadata, update, title) {
  return { ...previous, ...metadata, status: update.status ?? previous?.status, title };
}

/**
 * Background settle: every tracked task terminal, and either one failed or the
 * background notification turn boundary reported completion. (V2 semantics.)
 */
export function backgroundSettled(tasks, notificationFinished) {
  if (!tasks.length || tasks.some(t => !['completed', 'failed'].includes(t.status))) return false;
  return tasks.some(t => t.status === 'failed') || notificationFinished;
}
