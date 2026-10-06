// control.mjs — the operator's control CLI against a LIVE invocation.
//
//   node control.mjs --progress PROGRESS.json --action status
//   node control.mjs --progress PROGRESS.json --action steer --message "..."
//   node control.mjs --progress PROGRESS.json --action ask --message "..."
//   node control.mjs --progress PROGRESS.json --action pause [--no-stop-workflow]
//   node control.mjs --progress PROGRESS.json --action answer --interactionId <id> --optionId <opt>
//   node control.mjs --progress PROGRESS.json --action workflow-status
//   node control.mjs --progress PROGRESS.json --action workflow-events --runId <id> [--afterSequence N]
//   node control.mjs --progress PROGRESS.json --action workflow-stop --runId <id>
//   node control.mjs --progress PROGRESS.json --action workflow-settings --runId <id> --maxConcurrency 2
//
// status is a pure progress read (no model calls, no command written). Every
// mutating action validates the live owner and state, then writes ONE atomic
// command file into the invocation-bound inbox and prints its command id.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJsonFile, writeJsonAtomic } from './jsonio.mjs';
import { validateControlPayload } from './inbox.mjs';

/** Statuses in which the owning client still polls the inbox. */
export const LIVE_STATES = new Set(['starting', 'initializing', 'running', 'waiting_background', 'needs_input', 'idle_window']);

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Validate that a mutating control command may be written for this progress
 * snapshot. Pure: liveness is injected so tests stay hermetic.
 */
export function validateControlContext(progress, action, payload, { isAlive = isProcessAlive } = {}) {
  if (!progress || typeof progress !== 'object') return { ok: false, why: 'progress file missing or invalid' };
  if (progress.version !== 3) return { ok: false, why: 'progress file is not a V3 snapshot' };
  if (!progress.invocationId) return { ok: false, why: 'progress has no invocationId' };
  if (!LIVE_STATES.has(progress.status)) {
    return { ok: false, why: `invocation is not live (status=${progress.status})` };
  }
  const controller = progress.controller ?? {};
  if (!isAlive(controller.pid)) return { ok: false, why: `controller pid ${controller.pid} is not alive` };
  if (controller.bridgePid != null && !isAlive(controller.bridgePid)) {
    return { ok: false, why: `bridge pid ${controller.bridgePid} is not alive` };
  }
  if (!isAbsolute(String(progress.controlInbox ?? ''))) {
    return { ok: false, why: 'progress does not expose an absolute controlInbox path' };
  }
  const payloadVerdict = validateControlPayload(action, payload);
  if (!payloadVerdict.ok) return { ok: false, why: `invalid payload: ${payloadVerdict.why}` };
  if (action === 'answer' && !progress.pendingInput) {
    return { ok: false, why: 'no pending input to answer' };
  }
  if (action === 'answer' && (progress.pendingInput.kind !== 'question'
    || progress.pendingInput.interactionId !== payload.interactionId
    || !progress.pendingInput.options?.some(o => o.optionId === payload.optionId))) {
    return { ok: false, why: 'answer must match the exact pending ordinary question and option' };
  }
  if (action?.startsWith('workflow-') && action !== 'workflow-status' && !progress.workflowRunIds?.length) {
    return { ok: false, why: 'no bound workflow run for this invocation' };
  }
  return { ok: true, why: 'ok' };
}

/** Compact current status for humans/controllers (no model calls). */
export function compactStatus(progress) {
  return {
    invocationId: progress.invocationId,
    status: progress.status,
    sessionId: progress.sessionId,
    phase: progress.phase,
    currentTurn: progress.currentTurn,
    pendingInput: progress.pendingInput ? {
      interactionId: progress.pendingInput.interactionId,
      kind: progress.pendingInput.kind,
      question: progress.pendingInput.question,
      options: progress.pendingInput.options?.map(o => o.optionId),
    } : null,
    workflow: progress.workflow,
    workflowRunIds: progress.workflowRunIds,
    queuedControls: progress.controls?.queue ?? [],
    activity: progress.activity,
    controller: progress.controller,
    updatedAt: progress.updatedAt,
  };
}

/** Build (pure) the command document; seq keeps file names sort-stable. */
export function buildControlCommand({ progress, action, payload, seq, now = new Date(), uuid = randomUUID }) {
  return {
    id: `cmd-${String(seq).padStart(6, '0')}-${uuid().slice(0, 8)}`,
    invocationId: progress.invocationId,
    action,
    payload: payload ?? {},
    createdAt: now.toISOString(),
    source: { progressUpdatedAt: progress.updatedAt ?? null },
  };
}

function nextSequence(inboxDir) {
  try {
    const files = readdirSync(inboxDir).filter(n => n.startsWith('cmd-') && n.endsWith('.json'));
    return files.length + 1;
  } catch {
    return 1;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-stop-workflow') { args.noStopWorkflow = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
      args[key] = value;
      i += 1;
    } else args._.push(a);
  }
  return args;
}

function payloadFromArgs(action, args) {
  const payload = {};
  if (action === 'steer' || action === 'ask') payload.message = args.message;
  if (action === 'pause' && args.noStopWorkflow) payload.stopWorkflow = false;
  if (action === 'answer') { payload.interactionId = args.interactionId; payload.optionId = args.optionId; }
  if (action !== 'status' && action !== 'pause' && action !== 'answer') {
    if (args.runId !== undefined) payload.runId = args.runId;
    if (args.afterSequence !== undefined) payload.afterSequence = Number(args.afterSequence);
    if (args.maxConcurrency !== undefined) payload.maxConcurrency = Number(args.maxConcurrency);
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const progressPath = args.progress ?? args._[0];
  const document = args._[1] ? readJsonFile(args._[1]) : null;
  const action = document?.action ?? args.action;
  if (!progressPath || !action) {
    throw new Error('usage: node control.mjs --progress PROGRESS.json --action <action> [action args]');
  }
  const progress = readJsonFile(progressPath);
  if (!progress) throw new Error(`cannot read progress file: ${progressPath}`);
  if (action === 'status') {
    console.log(JSON.stringify(compactStatus(progress), null, 2));
    return 0;
  }
  const payload = document ? (document.payload ?? Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== 'action'))) : payloadFromArgs(action, args);
  const verdict = validateControlContext(progress, action, payload);
  if (!verdict.ok) {
    console.error(JSON.stringify({ ok: false, error: verdict.why }));
    return 1;
  }
  if (!existsSync(progress.controlInbox)) {
    throw new Error(`control inbox directory is missing: ${progress.controlInbox}`);
  }
  const seq = nextSequence(progress.controlInbox);
  const command = buildControlCommand({ progress, action, payload, seq });
  const file = `${progress.controlInbox}/${command.id}.json`;
  writeJsonAtomic(file, command);
  console.log(JSON.stringify({ ok: true, commandId: command.id, action, inboxFile: file }, null, 2));
  return 0;
}

// Entry guard: importable for tests without side effects.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().then(code => process.exit(code), e => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}
