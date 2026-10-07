// Bind an existing test runner's receipt to explicitly selected source inputs.
// No execution, no log scraping, and no dependency on a personal test runner.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export const argvHash = argv => sha(JSON.stringify(argv));

export function sourceIdentity(cwd, files) {
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== 'string' || !f)) {
    throw new Error('candidateFiles must explicitly name the source/test/config inputs');
  }
  return sha(JSON.stringify([...new Set(files)].sort().map(file => {
    const path = resolve(cwd, file);
    return [file, existsSync(path) ? sha(readFileSync(path)) : null];
  })));
}

export function prepareCheck(spec) {
  const { name, command, candidateFiles } = spec;
  const cwd = realpathSync(spec.cwd);
  if (!name || !Array.isArray(command) || !command.length || command.some(p => typeof p !== 'string')) {
    throw new Error('Check requires name, command argv and cwd');
  }
  if (/^(?:cmd|powershell|pwsh|bash|sh|zsh)(?:\.exe)?$/i.test(basename(command[0].replaceAll('\\', '/')))) {
    throw new Error('Bind the actual test runner argv, not a shell pipeline or trailing echo');
  }
  return { kind: 'tandem-check-input', version: 1, name, cwd, command, candidateFiles,
    candidateSha256: sourceIdentity(cwd, candidateFiles), commandSha256: argvHash(command),
    preparedAt: new Date().toISOString() };
}

function normalizeReceipt(raw) {
  if (raw.kind === 'codex-bounded-command' && raw.schema_version === 2) {
    if (typeof raw.output_limited !== 'boolean') throw new Error('Missing output completeness flag');
    return { commandSha256: raw.command?.requested_argv_sha256, cwd: raw.working_directory,
      startedAt: raw.started_at_utc, finishedAt: raw.finished_at_utc,
      exitCode: raw.process_exit_code, outcome: raw.outcome,
      outputTruncated: raw.output_limited === true, runnerExitCode: raw.runner_exit_code };
  }
  if (raw.kind === 'tandem-command-receipt' && raw.version === 1 && Array.isArray(raw.command)) {
    if (typeof raw.outputTruncated !== 'boolean') throw new Error('Missing output completeness flag');
    return { ...raw, commandSha256: argvHash(raw.command) };
  }
  throw new Error('Unsupported receipt; use the documented command receipt schema');
}

export function assessCheck({ preparedFile, receiptFile, failureClass = 'unclassified' }) {
  let prepared;
  try {
    prepared = read(preparedFile);
    if (prepared.kind !== 'tandem-check-input' || prepared.commandSha256 !== argvHash(prepared.command)) {
      throw new Error('Invalid prepared check');
    }
    const base = { name: prepared.name, command: prepared.command, cwd: prepared.cwd,
      candidateSha256: prepared.candidateSha256, preparedFile, receiptFile, failureClass };
    if (!existsSync(receiptFile)) return { ...base, outcome: 'not_run', exitCode: null };
    const raw = read(receiptFile), r = normalizeReceipt(raw);
    const stale = sourceIdentity(prepared.cwd, prepared.candidateFiles) !== prepared.candidateSha256;
    if (stale) return { ...base, outcome: 'stale', exitCode: r.exitCode, reason: 'candidate inputs changed' };
    if (r.commandSha256 !== prepared.commandSha256 || realpathSync(r.cwd) !== realpathSync(prepared.cwd)) {
      throw new Error('Receipt command/cwd does not match prepared check');
    }
    const start = Date.parse(r.startedAt), finish = Date.parse(r.finishedAt), preparedAt = Date.parse(prepared.preparedAt);
    // Some maintained runners record whole seconds. Preparation also binds
    // source content; allow only that known timestamp precision difference.
    if (!Number.isFinite(preparedAt) || !Number.isFinite(start) || !Number.isFinite(finish) || start < Math.floor(preparedAt / 1000) * 1000
        || finish < start || finish > Date.now() + 5000) throw new Error('Receipt is stale or has invalid timestamps');
    const outcome = !Number.isInteger(r.exitCode) ? 'not_run'
      : r.outputTruncated ? 'incomplete'
      : r.exitCode === 0 && r.outcome === 'pass' && (r.runnerExitCode ?? 0) === 0 ? 'pass' : 'fail';
    return { ...base, outcome, exitCode: r.exitCode, startedAt: r.startedAt, finishedAt: r.finishedAt,
      receiptSha256: sha(readFileSync(receiptFile)), outputTruncated: r.outputTruncated === true };
  } catch (e) {
    return { name: prepared?.name ?? null, preparedFile, receiptFile, outcome: 'invalid', exitCode: null, reason: e.message };
  }
}

export function normalizeVerification(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error('verification must be an array of at most 50 checks');
  for (const item of value) {
    if (!item || typeof item.preparedFile !== 'string' || typeof item.receiptFile !== 'string') {
      throw new Error('verification requires preparedFile and receiptFile');
    }
    if (item.failureClass && !['unclassified', 'product', 'fixture', 'environment', 'known_baseline'].includes(item.failureClass)) {
      throw new Error('Invalid failureClass');
    }
  }
  return value;
}

export function assessVerification(checks = []) {
  const records = checks.map(assessCheck);
  return { outcome: !records.length ? 'not_run' : records.every(r => r.outcome === 'pass') ? 'pass' : 'not_passed',
    checks: records, boundary: 'Checks bind only the declared inputs. Controller review is still required; model completion is not acceptance.' };
}
