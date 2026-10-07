import { existsSync } from 'node:fs';
import { basename } from 'node:path';
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
    message: 'ACP login-shell environment probe failed; inherited environment was used. ACP 0.65.1 uses POSIX arguments even for PowerShell.',
  }] : [];
}

export async function captureQuota(conn) {
  let timer;
  try {
    const value = await Promise.race([conn.extMethod('account/usage_stats', {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('quota snapshot timeout')), 5000); })]);
    return { observedAt: new Date().toISOString(), status: 'available', value };
  } catch (e) { return { observedAt: new Date().toISOString(), status: 'unavailable', reason: e.message }; }
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
    quotaSnapshots: report.quotaSnapshots ?? null,
    usageBoundary: 'Quota snapshots are shared-account observations, not exact task billing. Token count is not estimated from text.',
    error: report.error, resultFile: request.resultFile ?? null,
  };
  if (request.summaryFile) writeJsonAtomic(request.summaryFile, report.summary);
}
