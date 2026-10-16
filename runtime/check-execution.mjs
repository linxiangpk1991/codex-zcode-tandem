// Execute only caller-authorized check plans captured before model work starts.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { prepareCheck, assessCheck } from './verification.mjs';
import { writeJsonAtomic } from './jsonio.mjs';
const trustedReceipts = new WeakMap();

export function captureCheckExecutions(checks, cwd) {
  return checks.filter(c => c.execute === true).map(check => {
    const spec = JSON.parse(readFileSync(check.preparedFile, 'utf8').replace(/^\uFEFF/, ''));
    if (realpathSync(spec.cwd) !== realpathSync(cwd)) throw new Error('Executable check must use the task cwd');
    if (!isAbsolute(spec.command?.[0] ?? '')) throw new Error('Executable check needs an absolute executable');
    for (const file of spec.candidateFiles ?? []) {
      const part = relative(resolve(cwd), resolve(cwd, file));
      if (isAbsolute(file) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Check input escapes cwd');
    }
    prepareCheck(spec); // validate the same contract used by receipt import
    const timeoutSeconds = check.timeoutSeconds ?? 120;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('Check timeout must be 1..600 seconds');
    const plan = Object.freeze({ ...check, timeoutSeconds, spec: Object.freeze({ name: spec.name,
      cwd: realpathSync(cwd), command: Object.freeze([...spec.command]),
      candidateFiles: Object.freeze([...spec.candidateFiles]), userPaths: Object.freeze([...(spec.userPaths ?? [])]) }) });
    const existing = assessCheck(plan);
    if (existing.outcome === 'pass') trustedReceipts.set(plan, existing.receiptSha256);
    return plan;
  });
}

export async function executeChecks({ request, config, signal, deadlineAt, onCheck = () => {} }) {
  const records = [];
  for (const plan of request.checkExecutions ?? []) {
    if (signal.aborted || Date.now() >= deadlineAt) break;
    const existing = assessCheck(plan);
    if (existing.outcome === 'pass' && trustedReceipts.get(plan) === existing.receiptSha256) continue;
    onCheck(plan.spec.name);
    const prepared = prepareCheck(plan.spec);
    for (const file of [plan.preparedFile, plan.receiptFile]) mkdirSync(dirname(resolve(file)), { recursive: true });
    writeJsonAtomic(plan.preparedFile, prepared);
    const receipt = await execute(plan.spec, config, signal,
      Math.min(plan.timeoutSeconds * 1000, deadlineAt - Date.now()));
    writeJsonAtomic(plan.receiptFile, receipt);
    if (receipt.cleanupConfirmed === false) throw new Error(`Check process cleanup unconfirmed: ${receipt.pid}; inspect ${plan.receiptFile}`);
    const checked = assessCheck(plan);
    if (checked.outcome === 'pass') trustedReceipts.set(plan, checked.receiptSha256);
    records.push(checked);
  }
  return records;
}

function execute(spec, config, signal, timeoutMs) {
  return new Promise(resolveResult => {
    const startedAt = new Date().toISOString();
    let bytes = 0, output = '', truncated = false, stopped = null, childError = null, done = false, forceTimer;
    const child = spawn(spec.command[0], spec.command.slice(1), {
      cwd: spec.cwd, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const retain = data => {
      bytes += data.length;
      if (bytes <= 128000) output += data.toString('utf8');
      else truncated = true;
    };
    child.stdout.on('data', retain); child.stderr.on('data', retain);
    const stop = reason => {
      if (done || stopped) return;
      stopped = reason;
      try {
        if (process.platform === 'win32' && child.pid) execFileSync(config.taskkillPath,
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: config.cleanupTimeoutMs, stdio: 'ignore' });
        else child.kill('SIGTERM');
      } catch (e) { childError = e.message; }
      forceTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        complete(null, false);
      }, config.gracefulCancelWaitMs);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.on('error', error => { childError = error.message; });
    function complete(code, cleanupConfirmed = true) {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(forceTimer); signal.removeEventListener('abort', abort);
      resolveResult({ kind: 'tandem-command-receipt', version: 1,
        command: spec.command, cwd: spec.cwd, startedAt, finishedAt: new Date().toISOString(),
        exitCode: Number.isInteger(code) ? code : null, runnerExitCode: stopped || childError ? 1 : code,
        outcome: !stopped && !childError && code === 0 && !truncated ? 'pass' : 'fail',
        outputTruncated: truncated, output, stopped, error: childError, pid: child.pid ?? null, cleanupConfirmed });
    }
    child.on('close', code => complete(code));
  });
}
