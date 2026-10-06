// Control inbox: the client side. control.mjs writes atomic command files into
// a per-invocation inbox directory; the running client polls at most every
// second, deduplicates by command id, binds strictly to its invocationId and
// drops stale or malformed files. Acks (accepted/completed/rejected + why) are
// recorded by the runner via ProgressTracker.recordControl.
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from './jsonio.mjs';

export const CONTROL_ACTIONS = Object.freeze([
  'steer', 'ask', 'pause', 'answer',
  'workflow-status', 'workflow-events', 'workflow-stop', 'workflow-settings',
]);

/** Commands older than this are stale and never executed. */
export const STALE_MS = 10 * 60 * 1000;

const ACTION_PAYLOAD_RULES = Object.freeze({
  steer: { message: 'nonempty' },
  ask: { message: 'nonempty' },
  pause: { stopWorkflow: 'optional-bool' },
  answer: { interactionId: 'nonempty', optionId: 'nonempty' },
  'workflow-status': {},
  'workflow-events': { runId: 'nonempty', afterSequence: 'optional-int' },
  'workflow-stop': { runId: 'nonempty' },
  'workflow-settings': { runId: 'nonempty', maxConcurrency: 'int-1-4' },
});

/** Validate the payload of a control action. Returns {ok} or {ok:false, why}. */
export function validateControlPayload(action, payload) {
  if (!CONTROL_ACTIONS.includes(action)) return { ok: false, why: `unknown action: ${action}` };
  const rules = ACTION_PAYLOAD_RULES[action];
  payload = payload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, why: 'payload must be an object' };
  }
  for (const [key, rule] of Object.entries(rules)) {
    const value = payload[key];
    if (rule === 'nonempty') {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, why: `${key} must be a non-empty string` };
    } else if (rule === 'optional-bool') {
      if (value !== undefined && typeof value !== 'boolean') return { ok: false, why: `${key} must be a boolean` };
    } else if (rule === 'optional-int') {
      if (value !== undefined && !Number.isInteger(value)) return { ok: false, why: `${key} must be an integer` };
    } else if (rule === 'int-1-4') {
      if (!Number.isInteger(value) || value < 1 || value > 4) return { ok: false, why: `${key} must be an integer within 1..4` };
    }
  }
  for (const key of Object.keys(payload)) {
    if (!(key in rules)) return { ok: false, why: `unsupported payload key: ${key}` };
  }
  return { ok: true };
}

/**
 * Pure validation of one command document against the invocation context.
 * Returns {ok, reason} — reason ∈ duplicate | foreign | malformed | stale |
 * invalid-payload | stale-progress.
 */
export function validateCommand(cmd, { invocationId, seenIds, now = Date.now(), invocationStartedAtMs = 0 }) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed' };
  if (typeof cmd.id !== 'string' || !cmd.id) return { ok: false, reason: 'malformed' };
  if (cmd.invocationId !== invocationId) return { ok: false, reason: 'foreign' };
  if (seenIds?.has(cmd.id)) return { ok: false, reason: 'duplicate' };
  if (!CONTROL_ACTIONS.includes(cmd.action)) return { ok: false, reason: 'malformed' };
  const created = typeof cmd.createdAt === 'string' ? Date.parse(cmd.createdAt) : NaN;
  if (!Number.isFinite(created)) return { ok: false, reason: 'malformed' };
  if (created < invocationStartedAtMs - 1000) return { ok: false, reason: 'stale' };
  if (now - created > STALE_MS) return { ok: false, reason: 'stale' };
  if (created > now + 5000) return { ok: false, reason: 'stale' };
  const payload = validateControlPayload(cmd.action, cmd.payload);
  if (!payload.ok) return { ok: false, reason: `invalid-payload: ${payload.why}` };
  return { ok: true, reason: 'ok' };
}

/** Client-side inbox poller. Injectable fs hooks keep tests hermetic. */
export class ClientInbox {
  constructor({ dir, invocationId, invocationStartedAtMs, now = Date.now, staleGraceRemove = true }) {
    this.dir = dir;
    this.invocationId = invocationId;
    this.invocationStartedAtMs = invocationStartedAtMs;
    this.now = now;
    this.seenIds = new Set();
    this.staleGraceRemove = staleGraceRemove;
  }

  /** One poll: return valid commands in file order; consume (unlink) everything seen. */
  poll() {
    let names;
    try {
      names = readdirSync(this.dir).filter(n => n.endsWith('.json')).sort();
    } catch {
      return { commands: [], skipped: [] };
    }
    const commands = [];
    const skipped = [];
    for (const name of names) {
      const file = join(this.dir, name);
      const cmd = readJsonFile(file);
      const verdict = validateCommand(cmd, {
        invocationId: this.invocationId,
        seenIds: this.seenIds,
        now: this.now(),
        invocationStartedAtMs: this.invocationStartedAtMs,
      });
      const id = cmd?.id ?? null;
      if (id) this.seenIds.add(id);
      if (verdict.ok) {
        commands.push(cmd);
      } else {
        skipped.push({ id, reason: verdict.reason });
      }
      // Consume every seen file: valid ones are executed at most once; invalid
      // ones must not be re-validated on every future poll.
      try { unlinkSync(file); } catch { /* already gone */ }
    }
    return { commands, skipped };
  }
}
