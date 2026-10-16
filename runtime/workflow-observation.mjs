import { inspectWorkflowBinding } from './workflow-contract.mjs';
export { readWorkflowScript, canonicalWorkflowModel } from './workflow-contract.mjs';

// An observation receipt, not an OS sandbox. Native resumed sessions can skip
// a permission callback; verify the actual tool input/file as well, and never
// describe absence of a callback as an enforced approval.
export function observeWorkflowBinding(request, name, input, cwd) {
  const receipt = { tool: name, enforcement: 'observed_tool_input',
    ...inspectWorkflowBinding(request, input, cwd) };
  if (name === 'AmendWorkflow' && (!request.workflowRunId || input?.run_id !== request.workflowRunId)) {
    receipt.matched = false;
    receipt.reason = 'amend predecessor run ID mismatch';
  }
  return receipt;
}
