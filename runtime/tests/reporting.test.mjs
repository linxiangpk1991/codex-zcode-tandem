import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellFamily, startupWarnings, captureQuota } from '../reporting.mjs';
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
