// Bind first-pass self-review and existing check receipts to a declared candidate.
// This is not a code-quality judge, security boundary or independent acceptance.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { sourceIdentity } from './verification.mjs';
import { nativeToolName, assessBackgroundCompletion } from './policy.mjs';

export const REVIEW_LABEL = 'tandem:first-pass-review';
const boundary = 'Self-review is a model declaration, not independent approval. Readiness covers only declared files and checks; visual and final acceptance remain with the controller.';

function strings(value, field, limit = 200) {
  if (!Array.isArray(value) || value.length > limit || value.some(s => typeof s !== 'string' || !s.trim())) {
    throw new Error(`delivery.${field} must be an array of at most ${limit} nonempty strings`);
  }
  return [...new Set(value)];
}

export function normalizeDelivery(raw, request) {
  const editing = request.action === 'run' && (request.allowToolKinds?.includes('edit')
    || (request.workspace?.ownedPaths?.length > 0
      && (request.allowToolKinds?.includes('execute') || request.nativeWorkflow || request.waitForBackground)));
  if (raw === undefined && !editing) return null;
  if (request.action !== 'run') throw new Error('delivery is only supported for action=run');
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('delivery must be an object; editing tasks cannot disable first-pass review');
  }
  const value = raw ?? {};
  for (const key of Object.keys(value)) {
    if (!['candidateFiles', 'userPaths', 'validation', 'validationReason', 'visualReview'].includes(key)) {
      throw new Error(`Unknown delivery field: ${key}`);
    }
  }
  const candidateFiles = strings(value.candidateFiles ?? [], 'candidateFiles');
  for (const file of candidateFiles) {
    const part = relative(resolve(request.cwd), resolve(request.cwd, file));
    if (isAbsolute(file) || !part || part === '..' || part.startsWith(`..${sep}`) || /[*?\0]/.test(file)) {
      throw new Error('delivery.candidateFiles must name relative files inside cwd, without globs');
    }
    if (existsSync(resolve(request.cwd, file)) && statSync(resolve(request.cwd, file)).isDirectory()) {
      throw new Error(`delivery.candidateFiles requires a file, not a directory: ${file}`);
    }
  }
  const userPaths = strings(value.userPaths ?? [], 'userPaths', 30);
  const validation = value.validation ?? 'required';
  if (!['required', 'not_applicable'].includes(validation)) throw new Error('Invalid delivery.validation');
  const validationReason = value.validationReason ?? null;
  if (validationReason !== null && (typeof validationReason !== 'string' || !validationReason.trim())) {
    throw new Error('delivery.validationReason must be a nonempty string');
  }
  if (validation === 'not_applicable' && (!validationReason || userPaths.length)) {
    throw new Error('Skipping validation needs a reason and cannot skip declared user paths');
  }
  const visualReview = value.visualReview ?? (userPaths.length ? 'controller' : 'not_required');
  if (!['controller', 'not_required'].includes(visualReview)) throw new Error('Invalid delivery.visualReview');
  return { candidateFiles, userPaths, validation, validationReason, visualReview };
}

export function withDeliveryReview(prompts, delivery) {
  if (prompts.some(p => p.label === REVIEW_LABEL || p.deliveryReview)) throw new Error('Reserved delivery review phase');
  return delivery ? [...prompts, { label: REVIEW_LABEL, text: '', requiredTools: [], deliveryReview: true }] : prompts;
}

export function reviewPrompt(request) {
  const d = request.delivery;
  return `Perform the required first-pass review before handing this task back. This is self-review, not independent acceptance.
In THIS turn, use Read on the declared candidate files (or an already authorized command to inspect their actual diff). Earlier reads, mental tracing and failed reads of missing receipts do not satisfy this inspection. Re-read even if the implementation turn already summarized the files.
Re-read the actual final changes and relevant source, original requirements and test failures. Inspect integration points, error paths and regressions. Fix defects within existing owned paths, then review your fixes and rerun only affected checks through already approved commands. Do not expand permissions, hide failures, weaken assertions, create agents or claim unexecuted checks passed.
Declared candidate files: ${JSON.stringify(d.candidateFiles)}
Required functional user paths: ${JSON.stringify(d.userPaths)}
Existing verification inputs/receipts: ${JSON.stringify(request.verification)}
Validation: ${d.validation}${d.validationReason ? ` (${d.validationReason})` : ''}.
For browser functionality inspect DOM state, actual request fields/responses and persisted readback. A success toast is insufficient. Screenshots may be captured as evidence; do not claim visual acceptance. Visual review owner: ${d.visualReview}.
If commands/environment are unavailable, state the exact limitation and hand off for controller-run validation. Do not invent receipts. Reuse passing checks whose inputs are unchanged. After two attempts at the same failure without new evidence, diagnose and report the blocker instead of repeating.
End with exactly one fenced JSON block using the language tandem-review:
\`\`\`tandem-review
{"reviewedFiles":["relative/path"],"fixedIssues":[],"openIssues":[],"summary":"What was inspected, corrected and still needs validation"}
\`\`\`
List all declared candidate files in reviewedFiles only after inspecting them or their deletion diff. fixedIssues/openIssues are arrays of concise descriptions. Include unresolved defects in openIssues; missing execution evidence belongs in summary and real receipts. A clean declaration alone does not establish readiness.`;
}

function identity(request) {
  const root = realpathSync(request.cwd);
  for (const file of request.delivery.candidateFiles) {
    let path = resolve(root, file);
    while (!existsSync(path)) {
      const parent = resolve(path, '..');
      if (parent === path) throw new Error('Cannot resolve candidate path');
      path = parent;
    }
    const part = relative(root, realpathSync(path));
    if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Candidate escapes cwd');
  }
  return sourceIdentity(root, request.delivery.candidateFiles);
}

export function captureReview(request, result, inspected) {
  const record = { outcome: 'incomplete', completedAt: new Date().toISOString(), boundary };
  try {
    if (result.stopReason !== 'end_turn') throw new Error('Review turn did not finish');
    if (!inspected) throw new Error('No completed candidate read or approved shell inspection observed in review turn');
    const blocks = [...(result.text ?? '').matchAll(/```tandem-review\s*\n([\s\S]*?)\n```/g)];
    if (blocks.length !== 1 || blocks[0][1].length > 32000) throw new Error('Expected one bounded tandem-review JSON block');
    const declaration = JSON.parse(blocks[0][1]);
    const reviewedFiles = strings(declaration.reviewedFiles, 'reviewedFiles');
    const fixedIssues = strings(declaration.fixedIssues, 'fixedIssues', 100);
    const openIssues = strings(declaration.openIssues, 'openIssues', 100);
    if (typeof declaration.summary !== 'string' || !declaration.summary.trim()) throw new Error('Review summary missing');
    const missing = request.delivery.candidateFiles.filter(f => !reviewedFiles.includes(f));
    if (missing.length) throw new Error(`Candidate files not reviewed: ${missing.join(', ')}`);
    return { ...record, outcome: 'completed', declaration: { reviewedFiles, fixedIssues, openIssues,
      summary: declaration.summary }, candidateSha256: identity(request) };
  } catch (error) { return { ...record, reason: error.message }; }
}

export function observedCandidateInspection(request, tools) {
  const key = path => process.platform === 'win32' ? resolve(request.cwd, path).toLowerCase() : resolve(request.cwd, path);
  const candidates = new Set(request.delivery.candidateFiles.map(key));
  return tools.some(tool => {
    if (tool.status !== 'completed') return false;
    const name = nativeToolName(tool), input = tool.rawInput;
    if (name === 'Read' && typeof (input?.file_path ?? input?.path) === 'string') {
      return candidates.has(key(input.file_path ?? input.path));
    }
    // Shell inspection semantics remain the controller's responsibility. Only
    // explicitly reviewed commands count; arbitrary execution is not evidence.
    return name === 'Bash' && typeof input?.command === 'string'
      && request.workspace?.commands?.includes(input.command);
  });
}

export function assessDelivery(request, report) {
  if (!request.delivery) return { status: 'not_applicable', boundary };
  const d = request.delivery, review = report.firstPassReview;
  const reasons = [];
  const result = { status: 'needs_review', review: review ?? null, reasons,
    validation: report.verification, visualReview: d.visualReview === 'controller' ? 'pending_controller' : 'not_required', boundary };
  if (report.status !== 'completed') reasons.push(`Invocation is ${report.status}`);
  if (!d.candidateFiles.length) reasons.push('Declare delivery.candidateFiles before handoff');
  if (review?.outcome !== 'completed') reasons.push(review?.reason ?? 'First-pass review not completed');
  if (review?.invalidated) reasons.push('A subsequent steering turn requires a fresh review');
  if (report.backgroundTasks?.length || report.workflowRunIds?.length) {
    const completion = assessBackgroundCompletion({ tasks: report.backgroundTasks,
      notificationState: report.workflow?.notificationState, runs: report.workflow?.runs,
      bound: report.workflowRunIds });
    if (!completion.settled) reasons.push(completion.error ?? 'Background work is unfinished');
  }
  if (review?.candidateSha256) {
    try { if (identity(request) !== review.candidateSha256) reasons.push('Candidate changed after review'); }
    catch (e) { reasons.push(e.message); }
  }
  if (report.evidence?.toolsTruncated || report.evidence?.turnsTruncated) reasons.push('Review evidence is incomplete');
  if (reasons.length) return result;
  if (review.declaration.openIssues.length) return { ...result, status: 'changes_requested', reasons: review.declaration.openIssues };
  if (d.validation === 'required' && report.verification?.outcome !== 'pass') reasons.push('Required checks have not passed on current inputs');
  for (const check of report.verification?.checks ?? []) {
    if (check.outcome !== 'pass') continue;
    try {
      if (realpathSync(check.cwd) !== realpathSync(request.cwd)) reasons.push('Check belongs to another workspace');
    } catch { reasons.push('Cannot resolve check workspace'); }
  }
  const covered = new Set((report.verification?.checks ?? []).filter(c => c.outcome === 'pass').flatMap(c => c.userPaths ?? []));
  for (const path of d.userPaths) if (!covered.has(path)) reasons.push(`Functional path not verified: ${path}`);
  if (d.validation === 'not_applicable' && report.verification?.checks?.some(c => c.outcome !== 'pass')) reasons.push('Declared checks are not passing');
  return { ...result, status: reasons.length ? 'awaiting_validation' : 'ready_for_controller_review', validationReason: d.validationReason };
}
