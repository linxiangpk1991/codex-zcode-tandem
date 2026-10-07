import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../config.mjs';
import { normalizePromptItems, normalizeRequest } from '../request.mjs';

const config = buildConfig({}, {});
const base = { cwd: 'C:\\tmp\\project' };

test('V2 fields keep working: prompt shorthand, defaults, arrays', () => {
  const r = normalizeRequest(config, { ...base, prompt: 'do the thing' });
  assert.equal(r.action, 'run');
  assert.equal(r.model, config.defaultModel);
  assert.equal(r.thought, 'max');
  assert.equal(r.mode, 'build');
  assert.equal(r.timeoutSeconds, config.defaultTimeoutSeconds);
  assert.deepEqual(r.prompts, [{ label: 'turn-1', text: 'do the thing', requiredTools: [] }]);
  assert.deepEqual(r.allowToolKinds, []);
  assert.deepEqual(r.disallowedTools, []);
  assert.equal(r.idleSeconds, 0);
  assert.equal(r.nativeWorkflow, false);
});

test('prompts as strings or objects normalize with labels and requiredTools', () => {
  const items = normalizePromptItems({
    prompts: [
      'plain',
      { text: 'labeled', label: 'custom', requiredTools: ['Bash'] },
    ],
  });
  assert.deepEqual(items, [
    { label: 'turn-1', text: 'plain', requiredTools: [] },
    { label: 'custom', text: 'labeled', requiredTools: ['Bash'] },
  ]);
});

test('unsupported config is rejected before spawning', () => {
  const cases = [
    [{ ...base, model: 'GLM-9' }, /model/],
    [{ ...base, prompt: 'x', thought: 'ultra' }, /thought/],
    [{ ...base, prompt: 'x', mode: 'vibes' }, /mode/],
    [{ ...base, prompt: 'x', timeoutSeconds: 99999 }, /timeoutSeconds/],
    [{ ...base, prompt: 'x', timeoutSeconds: 0 }, /timeoutSeconds/],
    [{ ...base, prompt: 'x', idleSeconds: 121 }, /idleSeconds/],
    [{ ...base, prompt: 'x', maxOutputBytes: 10 }, /maxOutputBytes/],
    [{ ...base, prompt: 'x', allowToolKinds: 'read' }, /allowToolKinds/],
    [{ ...base, prompt: 'x', disallowedTools: [42] }, /disallowedTools/],
    [{ ...base, prompt: 'x', approvedWorkflowSha256: 'deadbeef' }, /approvedWorkflowSha256/],
    [{ ...base, prompt: 'x', workflowRunId: '' }, /workflowRunId/],
    [{ prompt: 'x' }, /cwd/],
    [{ ...base, prompt: 'x', action: 'party' }, /action/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => normalizeRequest(config, raw), pattern, JSON.stringify(raw));
  }
});

test('prompt and prompts are mutually exclusive; run needs at least one prompt', () => {
  assert.throws(() => normalizeRequest(config, { ...base, prompt: 'a', prompts: ['b'] }), /not both/);
  assert.throws(() => normalizeRequest(config, { ...base }), /at least one prompt/);
  assert.throws(() => normalizeRequest(config, { ...base, prompts: [{ label: 'x' }] }), /text/);
});

test('workflow actions validate identifiers, take no prompts, and enable the gate', () => {
  // Identifier requirements fire regardless of other fields.
  assert.throws(() => normalizeRequest(config, { ...base, action: 'workflow-resume', workflowRunId: 'r' }),
    /requires sessionId and workflowRunId/);
  assert.throws(() => normalizeRequest(config, {
    ...base, action: 'workflow-resume', sessionId: 's1', prompt: 'x',
  }), /requires sessionId and workflowRunId/);
  assert.throws(() => normalizeRequest(config, { ...base, action: 'workflow-status' }), /requires sessionId/);
  // With the identifiers satisfied, the isolated prompt rule is exercised.
  assert.throws(() => normalizeRequest(config, {
    ...base, action: 'workflow-resume', sessionId: 's1', workflowRunId: 'run-1', prompt: 'x',
  }), /no prompts/);
  assert.throws(() => normalizeRequest(config, {
    ...base, action: 'workflow-status', sessionId: 's1', prompts: ['x'],
  }), /no prompts/);
  const ok = normalizeRequest(config, {
    ...base, action: 'workflow-resume', sessionId: 's1', workflowRunId: 'run-1',
  });
  assert.equal(ok.action, 'workflow-resume');
  assert.deepEqual(ok.prompts, []);
  assert.equal(ok.nativeWorkflow, true, 'workflow actions imply the onDemand gate');
  const okRun = normalizeRequest(config, { ...base, prompt: 'x' });
  assert.equal(okRun.nativeWorkflow, false, 'plain runs keep the gate disabled');
});

test('quota and probe actions accept the shared pinning fields', () => {
  for (const action of ['quota', 'probe']) {
    const r = normalizeRequest(config, { ...base, action });
    assert.equal(r.action, action);
    assert.equal(r.nativeWorkflow, false);
  }
});

test('request object is frozen', () => {
  const r = normalizeRequest(config, { ...base, prompt: 'x' });
  assert.ok(Object.isFrozen(r));
});

test('workflow actor model must use the approved Coding Plan and max effort', () => {
  for (const approvedWorkflowModel of ['GLM-5.3$low', 'account:other/GLM-5.3$max']) {
    assert.throws(() => normalizeRequest(config, { ...base, prompt: 'x', nativeWorkflow: true,
      approvedWorkflowSha256: 'a'.repeat(64), approvedWorkflowModel }), /approvedWorkflowModel/);
  }
});
