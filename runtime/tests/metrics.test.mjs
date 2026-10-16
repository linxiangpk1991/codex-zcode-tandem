import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskMetrics, responseUsage } from '../metrics.mjs';

test('missing and invalid usage stays unknown; zero is a real reported count', () => {
  assert.equal(responseUsage({}).status, 'unavailable');
  const u = responseUsage({ usage: { inputTokens: 0, outputTokens: -1,
    totalTokens: '20', cachedReadTokens: Infinity, thoughtTokens: null } });
  assert.equal(u.status, 'partial');
  assert.equal(u.tokens.inputTokens, 0);
  assert.equal(u.tokens.totalTokens, null);
  assert.equal(u.tokens.outputTokens, null);
});

test('stage totals retain coverage and interrupted turns without invented usage', () => {
  const m = new TaskMetrics();
  const first = m.begin('implement', 'implementation', 100);
  const result = m.finish(first.id, { stopReason: 'end_turn', usage: { totalTokens: 14, inputTokens: 10, outputTokens: 4 } }, null, 150);
  assert.equal(result.nativeTurnMs, null);
  const second = m.begin('repair', 'repair', 200);
  m.finish(second.id, null, 'interrupted', 225);
  assert.equal(m.finish(second.id, { usage: { totalTokens: 99999 } }), null);
  const s = m.snapshot({ outcome: 'completed', invalidated: true,
    declaration: { fixedIssues: ['one'], openIssues: [] } });
  assert.equal(s.total.turns, 2);
  assert.equal(s.total.incomplete, 1);
  assert.equal(s.total.elapsedMs, 75);
  assert.equal(s.total.tokens.totalTokens, 14);
  assert.equal(s.total.reportedByField.totalTokens, 1);
  assert.equal(s.stages.repair.tokens.totalTokens, null);
  assert.equal(s.firstPass.source, 'model_reported');
  assert.equal(s.firstPass.valid, false);
  assert.equal(s.controllerFindings, null);
});
