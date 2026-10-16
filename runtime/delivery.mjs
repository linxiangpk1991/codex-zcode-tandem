// Bind fresh independent review and actual check receipts to the declared candidate.
// Final acceptance still belongs to the controller.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { sourceIdentity } from './verification.mjs';
import { nativeToolName, assessBackgroundCompletion } from './policy.mjs';

export const REVIEW_LABEL = 'tandem:first-pass-review';
const boundary = 'A fresh model review and real check receipts are required. Model review can miss defects; visual and final acceptance remain with the controller.';

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
  return delivery ? [...prompts, { label: REVIEW_LABEL, phase: 'review', text: '', requiredTools: [], deliveryReview: true }] : prompts;
}

export function candidateIdentity(request) {
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
      summary: declaration.summary }, candidateSha256: candidateIdentity(request) };
  } catch (error) { return { ...record, reason: error.message }; }
}

export function observedCandidateInspection(request, tools) {
  const key = path => process.platform === 'win32' ? resolve(request.cwd, path).toLowerCase() : resolve(request.cwd, path);
  const candidates = new Set(request.delivery.candidateFiles.map(key));
  const inspected = new Set();
  const diffInspected = tools.some(tool => {
    if (tool.status !== 'completed') return false;
    const name = nativeToolName(tool), input = tool.rawInput;
    if (name === 'Read' && typeof (input?.file_path ?? input?.path) === 'string') {
      inspected.add(key(input.file_path ?? input.path));
      return false;
    }
    // Shell inspection semantics remain the controller's responsibility. Only
    // explicitly reviewed commands count; arbitrary execution is not evidence.
    return name === 'Bash' && typeof input?.command === 'string'
      && request.workspace?.commands?.includes(input.command);
  });
  return diffInspected || (candidates.size > 0 && [...candidates].every(file => inspected.has(file)));
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
  if (review?.independent !== true || !review.sessionId || review.sessionId === review.implementationSessionId) reasons.push('Fresh independent review session required');
  if (review?.invalidated) reasons.push('A subsequent steering turn requires a fresh review');
  if (report.backgroundTasks?.length || report.workflowRunIds?.length) {
    const completion = assessBackgroundCompletion({ tasks: report.backgroundTasks,
      notificationState: report.workflow?.notificationState, runs: report.workflow?.runs,
      bound: report.workflowRunIds });
    if (!completion.settled) reasons.push(completion.error ?? 'Background work is unfinished');
  }
  if (review?.candidateSha256) {
    try { if (candidateIdentity(request) !== review.candidateSha256) reasons.push('Candidate changed after review'); }
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
