import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellFamily, startupWarnings, captureQuota, summarizeQuota, windowsEnvironment } from '../reporting.mjs';
import { buildChildEnv, buildConfig, resolvePaths } from '../config.mjs';

test('PowerShell, pwsh and Git Bash diagnostics use accurate shell family', () => {
  for (const shell of ['C:\\Windows\\powershell.exe', 'C:/Program Files/PowerShell/7/pwsh.exe']) assert.equal(shellFamily(shell), 'powershell');
  assert.equal(shellFamily('C:/Program Files/Git/bin/bash.exe'), 'posix');
  const warnings = startupWarnings('env: login-shell probe failed (bad -l) — falling back to the inherited environment', { SHELL: 'pwsh.exe' });
  assert.equal(warnings[0].code, 'ACP_LOGIN_SHELL_FALLBACK');
  assert.equal(warnings[0].shellFamily, 'powershell');
  assert.deepEqual(startupWarnings(''), []);
});
test('child Python UTF-8 is explicit and does not rewrite parent environment', () => {
  const before = process.env.PYTHONIOENCODING;
  const config = buildConfig({}, {});
  const env = buildChildEnv(config, resolvePaths(config), {}, 'test-xdg');
  assert.equal(env.PYTHONUTF8, '1'); assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(process.env.PYTHONIOENCODING, before);
});
test('quota failures stay unavailable, not zero usage', async () => {
  const result = await captureQuota({ extMethod: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.value, undefined);
});

test('provider quota states are preserved despite a successful ACP response', async () => {
  for (const kind of ['auth_error', 'rate_limited', 'unavailable', 'not_configured']) {
    const snapshot = await captureQuota({ extMethod: async () => ({ glm: { kind } }) });
    assert.equal(snapshot.status, kind);
    assert.equal(snapshot.summary.status, kind);
    assert.deepEqual(snapshot.summary.windows, []);
  }
  const missing = await captureQuota({ extMethod: async () => ({ opencode: { kind: 'success' } }) });
  assert.equal(missing.status, 'unknown');
});

test('GLM windows retain real percentages and milliseconds; invalid/missing values stay unknown', () => {
  const summary = summarizeQuota({ status: 'available', observedAt: 'now', value: {
    glm: { kind: 'success', level: 'pro', items: [
      { key: 'token_5h', label: '5h', leftPercent: 75, usedPercent: 25, nextResetTime: 1791580800000 },
      { label: 'Week', usedPercent: 100 },
      { label: 'unknown', leftPercent: '50', usedPercent: -1 },
      { label: 'invalid', leftPercent: null, usedPercent: NaN, nextResetTime: 1e100 },
    ] } } });
  assert.equal(summary.status, 'available');
  assert.equal(summary.windows[0].remainingPercent, 75);
  assert.equal(summary.windows[0].resetsAt, new Date(1791580800000).toISOString());
  assert.equal(summary.windows[0].nextResetTime, 1791580800000);
  assert.equal(summary.windows[1].remainingPercent, 0);
  assert.equal(summary.windows[1].nextResetTime, null);
  assert.equal(summary.windows[2].remainingPercent, null);
  assert.equal(summary.windows[3].resetsAt, null);
  assert.equal(Object.hasOwn(summary, 'manualResetsRemaining'), false);
});

test('Windows diagnosis exposes paths without rewriting environment or dumping PATH', () => {
  const env = { SHELL: 'pwsh.exe', ComSpec: 'missing-cmd.exe', PATH: 'a;b' };
  const before = JSON.stringify(env);
  const result = windowsEnvironment({ nodeBin: process.execPath, zcodeBin: 'missing-native.cjs' }, env);
  assert.equal(result.nodeExists, true);
  assert.equal(result.nativeExists, false);
  assert.equal(result.pathEntryCount, 2);
  assert.equal(result.loginProbeShellExists, null);
  assert.equal(result.loginProbeShellCheck, 'command-name-not-resolved');
  assert.equal(JSON.stringify(env), before);
  assert.equal(Object.hasOwn(result, 'PATH'), false);
});
