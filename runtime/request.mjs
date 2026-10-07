// REQUEST.json parsing and validation. V2 request fields keep working; V3
// adds the probe/workflow actions and the idle control window. Everything is
// rejected here, BEFORE any process is spawned.
import { normalizeWorkspace } from './workspace-policy.mjs';
import { normalizeVerification } from './verification.mjs';
const ACTIONS = ['run', 'quota', 'probe', 'workflow-resume', 'workflow-status', 'workflow-events'];

function fail(field, why) {
  throw new Error(`request.${field}: ${why}`);
}

function asBool(value, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(field, 'must be a boolean');
  return value;
}

/** Normalize `prompts`/`prompt` into [{label, text, requiredTools}] items. */
export function normalizePromptItems(raw) {
  const hasPrompts = raw.prompts !== undefined;
  const hasPrompt = raw.prompt !== undefined;
  if (hasPrompts && hasPrompt) fail('prompts', 'use prompt or prompts, not both');
  if (!hasPrompts && !hasPrompt) return [];
  let items = hasPrompt ? [raw.prompt] : raw.prompts;
  if (!Array.isArray(items)) {
    if (hasPrompt) items = [items];
    else fail('prompts', 'must be an array');
  }
  return items.map((item, index) => {
    if (typeof item === 'string') item = { text: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(`prompts[${index}]`, 'must be an object or string');
    }
    if (typeof item.text !== 'string' || !item.text.trim()) {
      fail(`prompts[${index}].text`, 'must be a non-empty string');
    }
    if (item.label !== undefined && (typeof item.label !== 'string' || !item.label.trim())) {
      fail(`prompts[${index}].label`, 'must be a non-empty string');
    }
    let requiredTools = [];
    if (item.requiredTools !== undefined) {
      if (!Array.isArray(item.requiredTools) ||
        item.requiredTools.some(t => typeof t !== 'string' || !t.trim())) {
        fail(`prompts[${index}].requiredTools`, 'must be an array of tool names');
      }
      requiredTools = item.requiredTools;
    }
    return { label: item.label ?? `turn-${index + 1}`, text: item.text, requiredTools };
  });
}

/**
 * Validate and normalize a parsed REQUEST.json payload against the config.
 * Returns a frozen request object; throws on anything unsupported.
 */
export function normalizeRequest(config, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('request must be a JSON object');
  }
  if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) fail('cwd', 'must be a non-empty string');
  const action = raw.action ?? 'run';
  if (!ACTIONS.includes(action)) fail('action', `must be one of ${ACTIONS.join(', ')}`);

  const model = raw.model ?? config.defaultModel;
  if (!config.models.includes(model)) fail('model', `must be one of ${config.models.join(', ')}`);
  const thought = raw.thought ?? config.defaultThought;
  if (!config.thoughtLevels.includes(thought)) {
    fail('thought', `must be one of ${config.thoughtLevels.join(', ')}`);
  }
  const mode = raw.mode ?? config.defaultMode;
  if (!config.modes.includes(mode)) fail('mode', `must be one of ${config.modes.join(', ')}`);

  const timeoutSeconds = raw.timeoutSeconds ?? config.defaultTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < config.minTimeoutSeconds || timeoutSeconds > config.maxTimeoutSeconds) {
    fail('timeoutSeconds', `must be an integer within ${config.minTimeoutSeconds}..${config.maxTimeoutSeconds}`);
  }
  const maxOutputBytes = raw.maxOutputBytes ?? config.defaultMaxOutputBytes;
  if (!Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < config.minMaxOutputBytes || maxOutputBytes > config.maxMaxOutputBytes) {
    fail('maxOutputBytes', `must be an integer within ${config.minMaxOutputBytes}..${config.maxMaxOutputBytes}`);
  }
  const idleSeconds = raw.idleSeconds ?? config.defaultIdleSeconds;
  if (!Number.isInteger(idleSeconds) || idleSeconds < 0 || idleSeconds > config.maxIdleSeconds) {
    fail('idleSeconds', `must be an integer within 0..${config.maxIdleSeconds}`);
  }

  const promptItems = normalizePromptItems(raw);
  if (action === 'run' && promptItems.length === 0) {
    fail('prompts', 'at least one prompt is required for action=run');
  }

  if (raw.allowToolKinds !== undefined &&
    (!Array.isArray(raw.allowToolKinds) ||
      raw.allowToolKinds.some(k => typeof k !== 'string' || !k.trim()))) {
    fail('allowToolKinds', 'must be an array of tool kinds');
  }
  if (raw.disallowedTools !== undefined &&
    (!Array.isArray(raw.disallowedTools) ||
      raw.disallowedTools.some(t => typeof t !== 'string' || !t.trim()))) {
    fail('disallowedTools', 'must be an array of tool names');
  }
  if (raw.approvedWorkflowSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(raw.approvedWorkflowSha256)) {
    fail('approvedWorkflowSha256', 'must be a lowercase sha256 hex digest');
  }
  if (raw.approvedWorkflowModel !== undefined &&
    (typeof raw.approvedWorkflowModel !== 'string' || !raw.approvedWorkflowModel.trim())) {
    fail('approvedWorkflowModel', 'must be a non-empty string');
  }
  if (raw.approvedWorkflowModel !== undefined
    && !config.models.some(m => raw.approvedWorkflowModel === `account:bigmodel-individual-coding-plan/${m}$${thought}`)) {
    fail('approvedWorkflowModel', 'must use an allowed native Coding Plan model at the requested thought level');
  }
  if (raw.workflowRunId !== undefined &&
    (typeof raw.workflowRunId !== 'string' || !raw.workflowRunId.trim())) {
    fail('workflowRunId', 'must be a non-empty string');
  }
  if (raw.sessionId !== undefined &&
    (typeof raw.sessionId !== 'string' || !raw.sessionId.trim())) {
    fail('sessionId', 'must be a non-empty string');
  }
  for (const field of ['progressFile', 'resultFile', 'summaryFile']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || !raw[field].trim())) {
      fail(field, 'must be a non-empty string');
    }
  }
  if (raw.afterSequence !== undefined && !Number.isInteger(raw.afterSequence)) {
    fail('afterSequence', 'must be an integer');
  }

  if ((action === 'workflow-resume' || action === 'workflow-events') && (!raw.sessionId || !raw.workflowRunId)) {
    fail('action', 'workflow-resume requires sessionId and workflowRunId');
  }
  if (action === 'workflow-status' && !raw.sessionId) {
    fail('action', 'workflow-status requires sessionId');
  }
  if (action.startsWith('workflow-') && promptItems.length > 0) {
    fail('action', 'workflow actions take no prompts');
  }

  return Object.freeze({
    ...raw,
    action,
    model,
    thought,
    mode,
    timeoutSeconds,
    maxOutputBytes,
    idleSeconds,
    prompts: promptItems,
    workspace: normalizeWorkspace(raw.workspace, raw.cwd),
    verification: normalizeVerification(raw.verification),
    quotaSnapshots: asBool(raw.quotaSnapshots, 'quotaSnapshots'),
    nativeWorkflow: asBool(raw.nativeWorkflow, 'nativeWorkflow') || action.startsWith('workflow-'),
    waitForBackground: asBool(raw.waitForBackground, 'waitForBackground'),
    allowToolKinds: raw.allowToolKinds ?? [],
    disallowedTools: raw.disallowedTools ?? [],
  });
}
