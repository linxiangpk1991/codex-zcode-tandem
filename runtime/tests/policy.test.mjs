import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backgroundSettled, buildPendingInput, classifyPermissionRequest, decideToolPermission,
  isTool, KIND_BY_TOOL, mergeBackgroundTask, nativeToolName, resumeRunApproved,
  selectOption, workflowApproved,
} from '../policy.mjs';

const script = 'name: demo\nsteps:\n  - uses: echo\n';
const sha = createHash('sha256').update(script).digest('hex');
const boundRequest = {
  allowToolKinds: ['read', 'search'],
  approvedWorkflowSha256: sha,
  approvedWorkflowModel: 'GLM-5.3-Flash',
  workflowRunId: 'run-exact',
};

test('path-based amendment callback hashes the script and checks canonical model and predecessor', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zcode-policy-path-'));
  writeFileSync(join(cwd, 'workflow.ts'), script);
  const request = { ...boundRequest, cwd,
    approvedWorkflowModel: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash$max' };
  const rawInput = { path: 'workflow.ts', subagent_model: 'GLM-5.3-Flash$max', run_id: 'run-exact' };
  const decide = () => decideToolPermission({ request, nativeName: 'AmendWorkflow', rawInput });
  assert.equal(decide().allowed, true);
  rawInput.run_id = 'other';
  assert.equal(decide().allowed, false);
  rawInput.run_id = 'run-exact';
  writeFileSync(join(cwd, 'workflow.ts'), 'tampered');
  assert.equal(decide().allowed, false);
  rawInput.path = 'missing.ts';
  assert.equal(decide().allowed, false);
});

test('classification uses the tracked tool_call meta and never confuses the three classes', () => {
  const metas = new Map([
    ['q1', { _meta: { claudeCode: { toolName: 'AskUserQuestion' } }, title: 'Which color?' }],
    ['p1', { _meta: { claudeCode: { toolName: 'ExitPlanMode' } }, title: 'plan' }],
    ['t1', { _meta: { claudeCode: { toolName: 'Bash' } }, title: 'Tool permission: Bash' }],
  ]);
  const lookup = id => metas.get(id);
  assert.deepEqual(classifyPermissionRequest({ toolCall: { toolCallId: 'q1' } }, lookup),
    { kind: 'question', nativeName: 'AskUserQuestion' });
  assert.deepEqual(classifyPermissionRequest({ toolCall: { toolCallId: 'p1' } }, lookup),
    { kind: 'plan_approval', nativeName: 'ExitPlanMode' });
  assert.deepEqual(classifyPermissionRequest({ toolCall: { toolCallId: 't1' } }, lookup),
    { kind: 'tool', nativeName: 'Bash' });
});

test('fallback heuristics classify by upstream option shapes when meta is missing', () => {
  const approve = classifyPermissionRequest({
    options: [{ optionId: 'approve' }, { optionId: 'reject' }],
    toolCall: { toolCallId: 'x' },
  }, () => undefined);
  assert.equal(approve.kind, 'plan_approval');
  assert.equal(approve.nativeName, 'ExitPlanMode');
  const skip = classifyPermissionRequest({
    options: [{ optionId: 'red' }, { optionId: '__skip__' }],
    toolCall: { toolCallId: 'x' },
  }, () => undefined);
  assert.equal(skip.kind, 'question');
  const multi = classifyPermissionRequest({
    options: [{ optionId: 'a:yes' }, { optionId: 'a:no' }],
    toolCall: { toolCallId: 'x' },
  }, () => undefined);
  assert.equal(multi.kind, 'question');
  const tool = classifyPermissionRequest({
    options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    toolCall: { toolCallId: 'x', title: 'Bash: npm test' },
  }, () => undefined);
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.nativeName, 'Bash');
});

test('plan approval and questions stay distinct even with swapped markers', () => {
  // An ExitPlanMode-looking option set under an AskUserQuestion meta is a question.
  const metas = new Map([['m1', { _meta: { claudeCode: { toolName: 'AskUserQuestion' } } }]]);
  const cls = classifyPermissionRequest({
    options: [{ optionId: 'approve' }, { optionId: 'reject' }],
    toolCall: { toolCallId: 'm1' },
  }, id => metas.get(id));
  assert.equal(cls.kind, 'question');
  // A plan-shaped popup without meta falls back to plan_approval, never a tool grant.
  const noMeta = classifyPermissionRequest({
    options: [{ optionId: 'approve', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }],
    toolCall: { toolCallId: 'x', title: 'Exit plan mode' },
  }, () => undefined);
  assert.equal(noMeta.kind, 'plan_approval');
});

test('workflow binding survives tampering: script hash, model, missing script', () => {
  assert.equal(workflowApproved(boundRequest, { script, subagent_model: 'GLM-5.3-Flash' }), true);
  assert.equal(workflowApproved(boundRequest, { script: `${script}\n# tampered\n`, subagent_model: 'GLM-5.3-Flash' }), false);
  assert.equal(workflowApproved(boundRequest, { script, subagent_model: 'GLM-5.3' }), false);
  assert.equal(workflowApproved(boundRequest, { subagent_model: 'GLM-5.3-Flash' }), false);
  assert.equal(workflowApproved({ ...boundRequest, approvedWorkflowSha256: undefined }, { script }), false);
});

test('ResumeWorkflowRun requires the exact bound run id', () => {
  assert.equal(resumeRunApproved(boundRequest, { run_id: 'run-exact' }), true);
  assert.equal(resumeRunApproved(boundRequest, { run_id: 'run-other' }), false);
  assert.equal(resumeRunApproved(boundRequest, {}), false);
  assert.equal(resumeRunApproved({ ...boundRequest, workflowRunId: undefined }, { run_id: 'run-exact' }), false);
});

test('unknown tools are denied; known tools follow the kind allowlist', () => {
  const unknown = decideToolPermission({ request: boundRequest, nativeName: 'MysteryTool', acpKind: undefined, rawInput: {} });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.reason, /unknown tool/);
  const denied = decideToolPermission({ request: boundRequest, nativeName: 'Bash', acpKind: 'execute', rawInput: {} });
  assert.equal(denied.allowed, false);
  const allowed = decideToolPermission({ request: boundRequest, nativeName: 'Read', acpKind: 'read', rawInput: {} });
  assert.equal(allowed.allowed, true);
  const byName = decideToolPermission({ request: boundRequest, nativeName: 'Grep', acpKind: undefined, rawInput: {} });
  assert.equal(byName.allowed, true); // KIND_BY_TOOL maps Grep -> search
});

test('an unknown tool with an ALLOWED ACP kind is still denied (native name decides)', () => {
  // The tool_call update may carry kind: execute from the wire, but a tool name
  // outside the known vocabulary must never be granted through it.
  const decision = decideToolPermission({
    request: { ...boundRequest, allowToolKinds: ['execute', 'read', 'edit', 'search'] },
    nativeName: 'TotallySafeTool',
    acpKind: 'execute',
    rawInput: { command: 'echo hi' },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /unknown tool/);
});

test('extended read-kind vocabulary keeps read-only workflow queries grantable', () => {
  assert.equal(KIND_BY_TOOL.Skill, 'read');
  assert.equal(KIND_BY_TOOL.GetWorkflowRun, 'read');
  assert.equal(KIND_BY_TOOL.GetWorkflowNodeResult, 'read');
  const decision = decideToolPermission({
    request: boundRequest, nativeName: 'GetWorkflowRun', acpKind: undefined, rawInput: {},
  });
  assert.equal(decision.allowed, true);
});

test('question options never leak into tool-grant decisions and vice versa', () => {
  // A question whose labels mimic tool options is still classified as a question.
  const metas = new Map([['q9', { _meta: { claudeCode: { toolName: 'AskUserQuestion' } } }]]);
  const cls = classifyPermissionRequest({
    options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: '__skip__', kind: 'reject_once' }],
    toolCall: { toolCallId: 'q9' },
  }, id => metas.get(id));
  assert.equal(cls.kind, 'question');
  // A real tool grant with a question-looking title stays a tool grant.
  const toolCls = classifyPermissionRequest({
    options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    toolCall: { toolCallId: 't9', title: 'Which color?: red' },
  }, () => undefined);
  assert.equal(toolCls.kind, 'tool');
});

test('selectOption only ever picks one-shot options, never a session tier', () => {
  const options = [
    { optionId: 'allow_once', kind: 'allow_once' },
    { optionId: 'allowSession', kind: 'allow_always' },
    { optionId: 'deny', kind: 'reject_once' },
  ];
  assert.equal(selectOption(options, true).optionId, 'allow_once');
  assert.equal(selectOption(options, false).optionId, 'deny');
  assert.equal(selectOption([], true), null);
  // Even when only an always-tier allow exists we do NOT auto-allow.
  assert.equal(selectOption([{ optionId: 'allowSession', kind: 'allow_always' }], true), null);
});

test('pendingInput record is bounded and structured', () => {
  const options = Array.from({ length: 20 }, (_, i) => ({ optionId: `o${i}`, kind: 'allow_once', name: `o${i}` }));
  const pi = buildPendingInput({
    interactionId: 'q1', kind: 'question', nativeName: 'AskUserQuestion',
    title: 'pick', options, rawInput: { big: 'x'.repeat(5000) },
  });
  assert.equal(pi.options.length, 12);
  assert.equal(pi.optionsTruncated, true);
  assert.ok(pi.rawInputPreview.length <= 2000);
  assert.equal(pi.kind, 'question');
});

test('background settle keeps V2 semantics', () => {
  assert.equal(backgroundSettled([], true), false);
  assert.equal(backgroundSettled([{ status: 'in_progress' }], false), false);
  assert.equal(backgroundSettled([{ status: 'completed' }], false), false);
  assert.equal(backgroundSettled([{ status: 'completed' }], true), true);
  assert.equal(backgroundSettled([{ status: 'failed' }], false), true);
});

test('isTool and mergeBackgroundTask keep V2 behavior', () => {
  const tool = { _meta: { claudeCode: { toolName: 'Bash' } } };
  assert.equal(isTool(tool, 'Bash'), true);
  assert.equal(isTool({ title: 'Read: x' }, 'Read'), true);
  assert.equal(nativeToolName(tool), 'Bash');
  const merged = mergeBackgroundTask({ status: 'in_progress' }, { taskId: 't1' }, { status: 'completed' }, 'title');
  assert.equal(merged.status, 'completed');
  assert.equal(merged.taskId, 't1');
});
