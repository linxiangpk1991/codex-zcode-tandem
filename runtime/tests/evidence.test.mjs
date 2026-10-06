import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundWorkflowEvents } from '../evidence.mjs';

test('bounded journal retains a prefix and advances a usable cursor', () => {
  const events = [1, 2, 3].map(sequence => ({ sequence, text: 'x'.repeat(90) }));
  const result = boundWorkflowEvents({ events }, 400);
  assert.deepEqual(result.events, [events[0]]);
  assert.equal(result.nextAfterSequence, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, true);
  const last = boundWorkflowEvents({ events: events.slice(1) }, 1000);
  assert.equal(last.nextAfterSequence, 3);
  assert.equal(last.hasMore, false);
});

test('one oversized event remains identifiable without retaining its body', () => {
  const result = boundWorkflowEvents({ events: [{ sequence: 8, type: 'node', body: 'x'.repeat(10000) }] }, 1000);
  assert.deepEqual(result.events, [{ sequence: 8, type: 'node', truncated: true }]);
  assert.equal(result.nextAfterSequence, 8);
  assert.ok(JSON.stringify(result).length < 1000);
});
