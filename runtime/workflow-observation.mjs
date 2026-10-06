import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function readWorkflowScript(input, cwd) {
  if (typeof input?.script === 'string') return { script: input.script };
  if (typeof input?.path !== 'string') throw new Error('script input not observable');
  const path = resolve(cwd, input.path);
  if (statSync(path).size > 1_000_000) throw new Error('script too large to verify');
  return { script: readFileSync(path, 'utf8'), path };
}

export function canonicalWorkflowModel(model) {
  return /^GLM-5\.3(?:-Flash)?\$(?:low|high|max)$/.test(model ?? '')
    ? `account:bigmodel-individual-coding-plan/${model}` : model;
}

// An observation receipt, not an OS sandbox. Native resumed sessions can skip
// a permission callback; verify the actual tool input/file as well, and never
// describe absence of a callback as an enforced approval.
export function observeWorkflowBinding(request, name, input, cwd) {
  const receipt = { tool: name, matched: false, enforcement: 'observed_tool_input' };
  if (!request.approvedWorkflowSha256 || !request.approvedWorkflowModel) {
    return { ...receipt, reason: 'no approved script/model' };
  }
  try {
    const { script, path } = readWorkflowScript(input, cwd);
    if (path) receipt.path = path;
    receipt.sha256 = createHash('sha256').update(script).digest('hex');
    receipt.model = canonicalWorkflowModel(input?.subagent_model);
    receipt.matched = receipt.sha256 === request.approvedWorkflowSha256
      && receipt.model === request.approvedWorkflowModel
      && (name !== 'AmendWorkflow' || (request.workflowRunId && input.run_id === request.workflowRunId));
    receipt.reason = receipt.matched ? 'script/model/target observed match' : 'observed workflow binding mismatch';
    return receipt;
  } catch (e) { return { ...receipt, reason: `cannot verify script: ${e.code ?? e.message}` }; }
}
