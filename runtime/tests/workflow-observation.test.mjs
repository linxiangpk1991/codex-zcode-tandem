import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { observeWorkflowBinding } from '../workflow-observation.mjs';

test('resumed workflow input is checked even without a permission callback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-observation-'));
  try {
    const script = 'return {passed:true};\n';
    writeFileSync(join(dir, 'workflow.ts'), script);
    const request = { approvedWorkflowSha256: createHash('sha256').update(script).digest('hex'),
      approvedWorkflowModel: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash$max',
      workflowRunId: 'dwfrun-original' };
    const input = { path: 'workflow.ts', run_id: 'dwfrun-original', subagent_model: 'GLM-5.3-Flash$max' };
    assert.equal(observeWorkflowBinding(request, 'AmendWorkflow', input, dir).matched, true);
    assert.equal(observeWorkflowBinding(request, 'AmendWorkflow',
      { ...input, run_id: 'dwfrun-foreign' }, dir).matched, false);
    assert.equal(observeWorkflowBinding(request, 'AmendWorkflow',
      { ...input, subagent_model: 'GLM-5.3-Flash$low' }, dir).matched, false);
    writeFileSync(join(dir, 'workflow.ts'), script + '/* changed */');
    assert.equal(observeWorkflowBinding(request, 'AmendWorkflow', input, dir).matched, false);
    assert.equal(observeWorkflowBinding({}, 'CreateWorkflow', input, dir).matched, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
