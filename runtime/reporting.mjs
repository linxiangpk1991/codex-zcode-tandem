import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { writeJsonAtomic } from './jsonio.mjs';
import { assessVerification } from './verification.mjs';

export function shellFamily(shell = '') {
  const name = basename(shell.replaceAll('\\', '/')).toLowerCase();
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) return 'powershell';
  if (/^(bash|zsh|sh)(\.exe)?$/.test(name)) return 'posix';
  return 'unknown';
}

export function startupWarnings(stderr = '', env = process.env) {
  return /login-shell probe failed|login shell .*gave no environment/.test(stderr) ? [{
    code: 'ACP_LOGIN_SHELL_FALLBACK', source: 'zcode-acp-server',
    shellFamily: shellFamily(env.SHELL), fallback: 'inherited-environment',
    probeShell: env.SHELL?.trim() || '/bin/zsh',
    message: 'ACP 0.65.1 login-shell probe uses POSIX -l -c / env -0; it failed and inherited environment was used. No supported Windows skip switch is exposed by this version.',
    nextAction: 'Check the inherited project tool paths with their explicit executable/dispatcher. Do not set SHELL to cmd/pwsh or inject Bash just to hide this warning.',
  }] : [];
}

export function windowsEnvironment(paths, env = process.env) {
  const shell = env.SHELL?.trim() || '/bin/zsh';
  const comSpec = env.ComSpec ?? env.COMSPEC ?? null;
  return { shellFamily: shellFamily(shell), loginProbeShell: shell,
    loginProbeShellExists: isAbsolute(shell) ? existsSync(shell) : null,
    loginProbeShellCheck: isAbsolute(shell) ? 'literal-path' : 'command-name-not-resolved',
    comSpec, comSpecExists: !!comSpec && existsSync(comSpec),
    nodePath: paths.nodeBin, nodeExists: existsSync(paths.nodeBin),
    nativePath: paths.zcodeBin, nativeExists: existsSync(paths.zcodeBin),
    pathPresent: !!(env.PATH ?? env.Path), pathEntryCount: (env.PATH ?? env.Path ?? '').split(';').filter(Boolean).length,
    systemRootPresent: !!env.SystemRoot,
    boundary: 'Native startup does not verify project Python/package-manager/build-tool resolution. Check those paths in the inherited environment.' };
}

const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const STATES = { success: 'available', auth_error: 'auth_error', rate_limited: 'rate_limited', unavailable: 'unavailable', not_configured: 'not_configured' };

export function summarizeQuota(snapshot) {
  if (!snapshot) return null;
  const glm = snapshot.value?.glm;
  const status = snapshot.status === 'unavailable' ? 'unavailable'
    : Object.hasOwn(STATES, glm?.kind) ? STATES[glm.kind] : 'unknown';
  const windows = glm?.kind === 'success' && Array.isArray(glm.items) ? glm.items.map(item => {
    const left = percent(item?.leftPercent), used = percent(item?.usedPercent);
    const timestamp = typeof item?.nextResetTime === 'number' && Number.isFinite(item.nextResetTime)
      ? item.nextResetTime : null;
    const date = timestamp === null ? null : new Date(timestamp);
    return { key: typeof item?.key === 'string' ? item.key : null,
      label: typeof item?.label === 'string' ? item.label : null,
      remainingPercent: left ?? (used === null ? null : 100 - used), usedPercent: used,
      nextResetTime: timestamp, resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null };
  }) : [];
  return { observedAt: snapshot.observedAt, status, providerKind: glm?.kind ?? null,
    plan: typeof glm?.level === 'string' ? glm.level : null, windows,
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
    boundary: 'Shared Coding Plan account observation, not exact task billing. Unknown values are null. Manual reset opportunities are not provided by this API.' };
}

export async function captureQuota(conn) {
  let timer;
  try {
    const value = await Promise.race([conn.extMethod('account/usage_stats', {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('quota snapshot timeout')), 5000); })]);
    const snapshot = { observedAt: new Date().toISOString(), status: 'available', value };
    snapshot.summary = summarizeQuota(snapshot);
    snapshot.status = snapshot.summary.status;
    return snapshot;
  } catch (e) {
    const snapshot = { observedAt: new Date().toISOString(), status: 'unavailable', reason: e.message };
    return { ...snapshot, summary: summarizeQuota(snapshot) };
  }
  finally { clearTimeout(timer); }
}

export function buildReportState(report, st, tracker, progressPath, inboxDir) {
  Object.assign(report, {
    response: st.response, needsAttention: st.needsAttention, workflow: tracker.state.workflow,
    sessionId: st.sessionId, acpVersion: st.acpVersion, agentInfo: st.agentInfo,
    effectivePolicy: st.policy, bridgeVersion: st.acpVersion, tools: [...st.tools.values()],
    permissions: st.permissions, config: st.configOptions, backgroundTasks: [...st.backgroundTasks.values()],
    backgroundNotificationFinished: st.notificationState === 'completed', workflowRunIds: tracker.state.workflowRunIds,
    pendingInput: tracker.state.pendingInput, controls: tracker.state.controls.history,
    controlQueue: tracker.snapshot().controls.queue, replayedHistory: { ...tracker.state.replay },
    evidence: { ...tracker.state.evidence }, activity: { ...tracker.state.activity },
    warnings: st.warnings, quota: st.quota, nativeCliVersion: st.nativeCliVersion,
    progressFile: progressPath, controlInbox: inboxDir,
  });
  return report;
}

export function completeReport(report, request, paths) {
  report.startupWarnings = startupWarnings(report.diagnostics ?? '');
  report.warnings.push(...report.startupWarnings.map(w => `${w.code}: ${w.message}`));
  report.environment = {
    toolPaths: windowsEnvironment(paths),
    shellFamily: shellFamily(process.env.SHELL),
    inherited: { pathPresent: !!(process.env.PATH ?? process.env.Path),
      systemRootPresent: !!process.env.SystemRoot, comSpecPresent: !!process.env.ComSpec,
      nodeExists: existsSync(paths.nodeBin), nativeExists: existsSync(paths.zcodeBin) },
    nativeSessionCreated: !!report.sessionId,
    boundary: 'Session creation proves native startup only; project tool resolution needs its own check.',
    childPythonEncoding: 'utf-8',
  };
  report.verification = assessVerification(request.verification);
  report.policyCoverage = { workspaceDeclared: !!request.workspace, enforcement: 'permission callbacks only',
    resumedOrBackground: !!(request.sessionId || request.nativeWorkflow || request.waitForBackground),
    boundary: 'Native auto-allowed tools, resumed sessions and background workers may omit callbacks. Tool-event observations are post hoc, not prevention. Use an isolated checkout for edits; this is not an OS sandbox.' };
  report.summary = {
    invocationId: report.invocationId, status: report.status,
    model: report.modelEffective, thought: report.thoughtEffective,
    sessionId: report.sessionId, workflowRunIds: report.workflowRunIds,
    verification: report.verification, controls: report.controls.slice(-20).map(c => ({
      id: c.id, action: c.action, state: c.state, submittedAt: c.submittedAt,
      acceptedAt: c.acceptedAt, startedAt: c.startedAt, completedAt: c.completedAt,
      queueDurationMs: c.queueDurationMs, executionDurationMs: c.executionDurationMs })),
    controlsOmitted: Math.max(0, report.controls.length - 20),
    activity: report.activity, warnings: report.warnings,
    evidence: report.evidence, turnPreviewsTruncated: report.turns.filter(t => t.previewTruncated).length,
    toolCount: report.tools.length, permissionCount: report.permissions.length,
    deniedPermissionCount: report.permissions.filter(p => !p.granted).length,
    observedPolicyViolations: (report.workspaceObservations ?? []).filter(p => p.allowed === false).length,
    unverifiedToolScopes: (report.workspaceObservations ?? []).filter(p => p.allowed === null).length,
    nativeIdentity: report.nativeIdentity ?? null,
    quota: summarizeQuota(report.quotaObservation ?? (report.quota
      ? { observedAt: report.finishedAt, status: 'available', value: report.quota } : null)),
    quotaSnapshots: report.quotaSnapshots ? {
      before: summarizeQuota(report.quotaSnapshots.before), after: summarizeQuota(report.quotaSnapshots.after),
    } : null,
    usageBoundary: 'Quota snapshots are shared-account observations, not exact task billing. Token count is not estimated from text.',
    error: report.error, resultFile: request.resultFile ?? null,
  };
  if (request.summaryFile) writeJsonAtomic(request.summaryFile, report.summary);
}
