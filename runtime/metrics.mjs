// PromptResponse is correlated by the ACP request. turnState notifications
// have no turn ID and also describe compaction; never charge them to a prompt.
export const PHASES = Object.freeze(['implementation', 'review', 'repair', 'validation', 'other']);
const TOKEN_FIELDS = ['totalTokens', 'inputTokens', 'outputTokens', 'thoughtTokens',
  'cachedReadTokens', 'cachedWriteTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const empty = () => ({ turns: 0, completed: 0, incomplete: 0, elapsedMs: 0,
  reportedTurns: 0, tokens: Object.fromEntries(TOKEN_FIELDS.map(k => [k, null])),
  reportedByField: Object.fromEntries(TOKEN_FIELDS.map(k => [k, 0])) });

export function responseUsage(response) {
  const raw = response?.usage;
  const tokens = Object.fromEntries(TOKEN_FIELDS.map(k => [k, count(raw?.[k])]));
  const available = TOKEN_FIELDS.some(k => tokens[k] !== null);
  return { source: available ? 'acp_prompt_response' : null,
    status: !available ? 'unavailable' : TOKEN_FIELDS.every(k => tokens[k] !== null) ? 'available' : 'partial',
    tokens, modelRequestCount: count(response?._meta?.zcode?.usage?.modelRequestCount) };
}

function accumulate(group, turn) {
  group.turns++;
  group[turn.outcome === 'completed' ? 'completed' : 'incomplete']++;
  group.elapsedMs += turn.elapsedMs;
  if (turn.usage.status !== 'unavailable') group.reportedTurns++;
  for (const key of TOKEN_FIELDS) {
    const value = turn.usage.tokens[key];
    if (value !== null) {
      group.tokens[key] = (group.tokens[key] ?? 0) + value;
      group.reportedByField[key]++;
    }
  }
}

export class TaskMetrics {
  constructor() {
    this.nextId = 0;
    this.active = null;
    this.total = empty();
    this.stages = Object.fromEntries(PHASES.map(p => [p, empty()]));
  }
  begin(label, phase = 'other', now = Date.now()) {
    if (this.active) throw new Error('Metrics already have an active prompt');
    if (!PHASES.includes(phase)) throw new Error(`Invalid phase: ${phase}`);
    return this.active = { id: ++this.nextId, label, phase, startedAtMs: now };
  }
  finish(id, response, outcome, now = Date.now()) {
    if (!this.active || this.active.id !== id) return null; // finalize/cancel is idempotent
    const active = this.active;
    this.active = null;
    const turn = { id, label: active.label, phase: active.phase,
      outcome: outcome ?? (response?.stopReason === 'end_turn' ? 'completed' : 'incomplete'),
      elapsedMs: Math.max(0, now - active.startedAtMs), nativeTurnMs: null,
      usage: responseUsage(response) };
    accumulate(this.total, turn);
    accumulate(this.stages[turn.phase], turn);
    return turn;
  }
  snapshot(review = null) {
    return structuredClone({ total: this.total, stages: this.stages,
      active: this.active ? { label: this.active.label, phase: this.active.phase,
        startedAt: new Date(this.active.startedAtMs).toISOString() } : null,
      firstPass: review?.outcome === 'completed' ? { source: 'model_reported',
        valid: !review.invalidated, fixedIssues: review.declaration.fixedIssues.length,
        openIssues: review.declaration.openIssues.length } : null,
      controllerFindings: null,
      boundary: 'Tokens sum only reported prompt responses; reportedByField shows coverage. Input tokens exclude cache reads/writes. Phases are explicit labels, not inferred repairs. Native turnState has no turn ID, so nativeTurnMs is unavailable. Background workflow usage and account quota are not prompt billing.' });
  }
}
