import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../workflow-contract.mjs';
import { workflowApproved } from '../policy.mjs';
import { observeWorkflowBinding } from '../workflow-observation.mjs';
import { normalizeRequest } from '../request.mjs';
import { buildConfig } from '../config.mjs';

test('workflow args and model bindings must match in callback and observation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-bind-'));
  try {
    const script = 'return args.task;';
    writeFileSync(join(cwd, 'workflow.ts'), script);
    const model = 'account:bigmodel-individual-coding-plan/GLM-5.3$max';
    const request = { cwd, approvedWorkflowSha256: createHash('sha256').update(script).digest('hex'),
      approvedWorkflowModel: model, approvedWorkflowArgs: { task: 'repair', options: { a: 1, b: 2 } },
      approvedWorkflowModelBindings: { reviewer: model } };
    const input = { path: 'workflow.ts', subagent_model: 'GLM-5.3$max',
      args: { options: { b: 2, a: 1 }, task: 'repair' }, model_bindings: { reviewer: model } };
    assert.equal(workflowApproved(request, input), true);
    for (const changed of [
      { ...input, args: { ...input.args, task: 'publish' } },
      { ...input, model_bindings: { reviewer: 'GLM-5.3$low' } },
      { ...input, model_bindings: undefined },
      { ...input, saved: { name: 'unresolved' } },
      { ...input, script: script + '/* altered */' },
      { ...input, args: null },
      { ...input, model_bindings: null },
      { ...input, adjustable_settings: { bypass: true } },
      { ...input, max_concurrency: 99 },
      { ...input, max_concurrency: 2 },
    ]) {
      assert.equal(workflowApproved(request, changed), false);
      assert.equal(observeWorkflowBinding(request, 'CreateWorkflow', changed, cwd).matched, false);
    }
    assert.equal(workflowApproved({ ...request, approvedWorkflowArgs: undefined }, input), false);
    assert.equal(workflowApproved({ ...request, approvedWorkflowModelBindings: undefined }, input), false);
    assert.equal(workflowApproved({ ...request, approvedWorkflowMaxConcurrency: 2 }, { ...input, max_concurrency: 2 }), true);
    assert.equal(workflowApproved({ ...request, approvedWorkflowMaxConcurrency: 2 }, input), false);
    const body = 'return args.task;\n';
    const full = '/* zcode-workflow\ndescription: Example\n*/\n' + body;
    writeFileSync(join(cwd, 'workflow.ts'), full);
    const expanded = { ...input, script: body, script_line_offset: 3 };
    const approved = { ...request, approvedWorkflowSha256: createHash('sha256').update(full).digest('hex') };
    assert.equal(workflowApproved(approved, expanded), true);
    assert.equal(workflowApproved(approved, { ...expanded,
      adjustable_settings: { subagent_model: true, concurrency_ceiling: 10 } }), true);
    assert.equal(workflowApproved(approved, { ...expanded, script: body + 'unsafe();' }), false);
    assert.equal(workflowApproved(approved, { ...expanded, script_line_offset: 0 }), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('request rejects non-JSON args and unauthorized role models before spawn', () => {
  const config = buildConfig({ models: ['GLM-5.3'], thoughtLevels: ['max'] }, {});
  const raw = { cwd: process.cwd(), prompt: 'run' };
  for (const value of ['external/provider$max', 'GLM-5.3$low', 'GLM-5.3-Flash$max', {}]) {
    assert.throws(() => normalizeRequest(config, { ...raw, approvedWorkflowModelBindings: { role: value } }));
  }
  for (const value of [0, 5, 1.5, '2']) assert.throws(() => normalizeRequest(config, { ...raw, approvedWorkflowMaxConcurrency: value }));
  for (const value of [undefined, NaN, Infinity, new Date(), [1, , 2]]) assert.throws(() => canonicalJson(value));
  assert.throws(() => normalizeRequest(config, { ...raw, approvedWorkflowArgs: { n: NaN } }));
  assert.throws(() => normalizeRequest(config, { ...raw, prompts: undefined, prompt: { text: 'x', phase: 'imagined' } }));
});
