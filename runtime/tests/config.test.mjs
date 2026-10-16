import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, buildChildEnv, buildIsolatedAcpConfig, resolvePaths, workflowModeForRequest } from '../config.mjs';
import { ISOLATED_SESSION_MODES, PINNED_ACP_VERSION, modeMismatchError } from '../acp-contract.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'zcode-v3-config-test-'));
}

test('personal model and thought allowlists narrow supported choices without fallback', () => {
  const config = buildConfig({ models: ['GLM-5.3'], thoughtLevels: ['max'] }, {});
  assert.deepEqual(config.models, ['GLM-5.3']);
  assert.deepEqual(config.thoughtLevels, ['max']);
  assert.throws(() => buildConfig({ models: [] }, {}), /nonempty subset/);
  assert.throws(() => buildConfig({ defaultModel: 'GLM-5.3-Flash', models: ['GLM-5.3'] }, {}), /defaultModel/);
});

test('ambient model selection cannot leak into the native child', () => {
  const previous = process.env.ZCODE_MODEL;
  try {
    process.env.ZCODE_MODEL = 'unapproved-model';
    const config = buildConfig({}, {});
    const env = buildChildEnv(config, resolvePaths(config), { mode: 'build' }, tempDir());
    assert.equal(env.ZCODE_MODEL, undefined);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_MODEL;
    else process.env.ZCODE_MODEL = previous;
  }
});

test('defaults are coherent and absolute paths resolve', () => {
  const config = buildConfig({}, {});
  assert.equal(config.defaultModel, 'GLM-5.3');
  assert.equal(config.defaultThought, 'max');
  assert.equal(config.defaultMode, 'build');
  assert.deepEqual(config.modes, ['plan', 'build', 'edit', 'guarded'],
    'guarded is an explicit opt-in; yolo/auto stay out of the default vocabulary');
  assert.equal(config.provider, 'builtin:bigmodel-coding-plan');
  assert.deepEqual(config.models, ['GLM-5.3', 'GLM-5.3-Flash']);
  assert.equal(config.maxTimeoutSeconds, 7200);
  assert.equal(config.inboxPollMs, 1000);
  const paths = resolvePaths(config);
  assert.equal(paths.nodeBin, process.execPath);
  assert.ok(/zcode\.cjs$/i.test(paths.zcodeBin));
  assert.ok(/provider_config\.json$/i.test(paths.providerFile));
  assert.ok(paths.taskkillPath.endsWith('taskkill.exe'));
});

test('unknown config keys are rejected before any spawn', () => {
  assert.throws(() => buildConfig({}, { bogusKey: 'x' }), /unsupported key/);
  assert.throws(() => buildConfig({ bogusKey: 'x' }, {}), /unsupported key/);
  assert.throws(() => buildConfig({}, { zcodeBin: 1 }), /must be a non-empty string/);
  assert.throws(() => buildConfig({}, { inboxPollMs: 5000 }), /inboxPollMs/);
  assert.throws(() => buildConfig({}, { maxIdleSeconds: 300 }), /maxIdleSeconds/);
});

test('provider/models/thought pins cannot be overridden', () => {
  assert.throws(() => buildConfig({ provider: 'builtin:other-plan' }, {}), /pinned native Coding Plan invariant/);
  assert.throws(() => buildConfig({ models: ['GLM-9'] }, {}), /pinned native Coding Plan invariant/);
  assert.throws(() => buildConfig({ defaultThought: 'low' }, {}), /pinned native Coding Plan invariant/);
  assert.throws(() => buildConfig({ thoughtLevels: ['low'] }, {}), /defaultThought must be one of/);
  assert.throws(() => buildConfig({}, { provider: 'x', models: ['y'] }), /pinned native Coding Plan invariant/);
  // Tunable limits still override cleanly.
  const tuned = buildConfig({ inboxPollMs: 50, heartbeatMs: 2000 }, {});
  assert.equal(tuned.inboxPollMs, 50);
  assert.equal(tuned.heartbeatMs, 2000);
});

test('workflow gate mode follows nativeWorkflow/waitForBackground only', () => {
  assert.equal(workflowModeForRequest({ nativeWorkflow: false, waitForBackground: false }), 'disabled');
  assert.equal(workflowModeForRequest({ nativeWorkflow: true }), 'alwaysOn');
  assert.equal(workflowModeForRequest({ waitForBackground: true }), 'alwaysOn');
});

test('isolated ACP config uses upstream schema keys and rejects invalid ones', () => {
  const isolated = buildIsolatedAcpConfig({ workflowMode: 'onDemand' });
  assert.deepEqual(isolated.relPath, ['zcode-acp', 'config.json']);
  assert.deepEqual(isolated.json, {
    session: { mode: 'build' },
    quota: { autoResume: false },
    workflow: { mode: 'onDemand' },
    remote: { enabled: false },
  });
  assert.throws(() => buildIsolatedAcpConfig({ workflowMode: 'always-on' }), /Unsupported workflow mode/);
  assert.throws(() => buildIsolatedAcpConfig({ workflowMode: 'onDemand', sessionMode: 'vibes' }), /session mode/);
});

test('isolated config pins the guarded opt-in; upstream vocabulary and mismatch text stay pinned', () => {
  const isolated = buildIsolatedAcpConfig({ workflowMode: 'disabled', sessionMode: 'guarded' });
  assert.deepEqual(isolated.json.session, { mode: 'guarded' });
  assert.deepEqual(ISOLATED_SESSION_MODES, ['plan', 'build', 'edit', 'guarded', 'yolo', 'auto']);
  assert.equal(PINNED_ACP_VERSION, '0.72.0');
  assert.match(modeMismatchError('guarded', 'yolo'), /requested guarded, effective yolo/);
  assert.match(modeMismatchError('guarded', 'yolo'), /session\/create without the mode/);
  assert.equal(modeMismatchError('build', 'plan'), 'mode selection mismatch: requested build, effective plan');
});

test('child env pins engine/provider, isolates XDG, carries bindings, preserves disallowedTools', () => {
  const config = buildConfig({}, {});
  const paths = resolvePaths(config);
  const xdg = tempDir();
  const env = buildChildEnv(config, paths, {
    mode: 'build',
    disallowedTools: ['WebSearch', 'CronDelete'],
    approvedWorkflowSha256: 'a'.repeat(64),
    approvedWorkflowModel: 'GLM-5.3-Flash',
    approvedWorkflowArgs: { task: 'bounded' },
    approvedWorkflowModelBindings: { reviewer: 'account:bigmodel-individual-coding-plan/GLM-5.3$max' },
    approvedWorkflowMaxConcurrency: 2,
    workflowRunId: 'run-42',
  }, xdg);
  assert.equal(env.ZCODE_BIN, paths.zcodeBin);
  assert.equal(env.ZCODE_NODE, process.execPath);
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, paths.providerFile);
  assert.equal(env.XDG_CONFIG_HOME, xdg);
  assert.equal(env.ZCODE_ACP_MODE, 'build');
  assert.equal(env.ZCODE_ACP_QUOTA_AUTO_RESUME, '0');
  assert.equal(env.ZCODE_DISALLOWED_TOOLS, 'WebSearch CronDelete');
  assert.deepEqual(JSON.parse(env.CODEX_ZCODE_BINDINGS), {
    approvedWorkflowSha256: 'a'.repeat(64),
    approvedWorkflowModel: 'GLM-5.3-Flash',
    approvedWorkflowArgs: { task: 'bounded' },
    approvedWorkflowModelBindings: { reviewer: 'account:bigmodel-individual-coding-plan/GLM-5.3$max' },
    approvedWorkflowMaxConcurrency: 2,
    workflowRunId: 'run-42',
  });
  for (const key of ['ANTHROPIC_API_KEY', 'ZCODE_BASE_URL', 'ZCODE_ENDPOINT_ORIGIN', 'ZCODE_ACP_REMOTE',
    'ZCODE_ACP_REMOTE_TOKEN', 'ZCODE_DYNAMIC_WORKFLOW_MODE', 'ZCODE_ENABLE_AUTOMATION_TOOLS',
    'ZCODE_ACP_RESUME_SESSION', 'ZCODE_ACP_INTERACTION_TIMEOUT_MS', 'ZCODE_ACP_SANDBOX']) {
    assert.equal(env[key], undefined, `${key} must be scrubbed`);
  }
});

test('child env inherits nothing remote-ish even with exotic spellings', () => {
  const config = buildConfig({}, {});
  const paths = resolvePaths(config);
  const original = { ...process.env };
  process.env.ZCODE_ACP_REMOTE_TOKEN_V2 = 'secret';
  process.env.ZCODE_ACP_REMOTE = '1';
  try {
    const env = buildChildEnv(config, paths, { mode: 'build' }, tempDir());
    for (const key of Object.keys(env)) {
      assert.ok(!key.startsWith('ZCODE_ACP_REMOTE'), `${key} leaked through`);
    }
  } finally {
    process.env = original;
  }
});

test('explicit disallowedTools list is optional', () => {
  const config = buildConfig({}, {});
  const env = buildChildEnv(config, resolvePaths(config), { mode: 'build' }, tempDir());
  assert.equal(env.ZCODE_DISALLOWED_TOOLS, undefined);
});

test('helper tempDir utility works', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'f.txt'), 'x');
  assert.ok(existsSync(join(dir, 'nested', 'f.txt')));
});
