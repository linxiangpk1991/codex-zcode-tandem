// Single local configuration source for the V3 native client.
//
// Every runtime path and default resolves through this module. Optional
// operator overrides live in config.json NEXT TO THIS FILE (nonsecret paths
// and limits only); the file is absent by default and embedded defaults are
// used. Nothing here reads secrets, the provider config content, or any
// historic conversation path.
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPaths } from './discovery.mjs';

export const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const discovered = discoverPaths();

/** Embedded defaults (overridable via config.json next to this module). */
export const DEFAULTS = Object.freeze({
  // Native engine + Coding Plan provider pinning. The provider file's CONTENT
  // is never read or logged by this client; only its path is passed through.
  zcodeBin: discovered.zcodeBin,
  providerFile: discovered.providerFile,
  provider: 'builtin:bigmodel-coding-plan',
  models: ['GLM-5.3', 'GLM-5.3-Flash'],
  defaultModel: 'GLM-5.3',
  thoughtLevels: ['low', 'high', 'max'],
  defaultThought: 'max',
  modes: ['plan', 'build', 'edit'],
  defaultMode: 'build',
  // Limits. The foreground main request has one fixed total deadline.
  defaultTimeoutSeconds: 5400,
  maxTimeoutSeconds: 7200,
  minTimeoutSeconds: 1,
  defaultMaxOutputBytes: 2_000_000,
  minMaxOutputBytes: 4096,
  maxMaxOutputBytes: 16_000_000,
  heartbeatMs: 15_000,
  inboxPollMs: 1000, // client polls the control inbox at most every second
  maxIdleSeconds: 120,
  defaultIdleSeconds: 0,
  // Windows process-tree cleanup of PIDs this task owns.
  taskkillPath: discovered.taskkillPath,
  cleanupTimeoutMs: 10_000,
  gracefulCancelWaitMs: 15_000,
  bridgeIpcTimeoutMs: 30_000,
  // Control inbox directory (sibling of the progress file by default).
  inboxDirName: '.zcode-v3-inbox',
  // Retention bounds for progress/result evidence.
  maxTools: 500,
  maxPermissions: 500,
  maxControls: 200,
  maxTurns: 200,
  maxEvents: 2000,
  compactByteLimit: 32_768,
  replayCharLimit: 8_192,
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * Load config.json overrides (optional). Unknown keys are rejected so a typo
 * cannot silently flip a security-relevant default. Returns {} when absent.
 */
export function loadConfigFile(dir = MODULE_DIR) {
  const file = resolve(dir, 'config.json');
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.json must be a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`config.json has unsupported key: ${key}`);
  }
  return parsed;
}

/**
 * Merge overrides over defaults and validate invariants. `overrides` is an
 * optional explicit layer (highest precedence, used by tests/tools).
 */
export function buildConfig(overrides = {}, file = loadConfigFile()) {
  for (const key of [...Object.keys(overrides), ...Object.keys(file)]) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`config has unsupported key: ${key}`);
  }
  const merged = { ...DEFAULTS, ...file, ...overrides };
  for (const key of ['provider', 'models', 'defaultThought', 'thoughtLevels']) {
    if (JSON.stringify(merged[key]) !== JSON.stringify(DEFAULTS[key])) {
      throw new Error(`config.${key} is a pinned native Coding Plan invariant`);
    }
  }
  for (const key of ['zcodeBin', 'providerFile', 'provider', 'taskkillPath']) {
    if (typeof merged[key] !== 'string' || !merged[key].trim()) {
      throw new Error(`config.${key} must be a non-empty string`);
    }
  }
  if (!merged.models.includes(merged.defaultModel)) {
    throw new Error('config.defaultModel must be one of config.models');
  }
  if (!merged.thoughtLevels.includes(merged.defaultThought)) {
    throw new Error('config.defaultThought must be one of config.thoughtLevels');
  }
  if (!merged.modes.includes(merged.defaultMode)) {
    throw new Error('config.defaultMode must be one of config.modes');
  }
  if (!(merged.maxTimeoutSeconds >= 1 && merged.maxTimeoutSeconds <= 7200)) {
    throw new Error('config.maxTimeoutSeconds must be within 1..7200');
  }
  if (!(merged.inboxPollMs >= 25 && merged.inboxPollMs <= 1000)) {
    throw new Error('config.inboxPollMs must be within 25..1000');
  }
  if (!(merged.heartbeatMs >= 1000)) throw new Error('config.heartbeatMs must be >= 1000');
  if (!(merged.maxIdleSeconds >= 0 && merged.maxIdleSeconds <= 120)) {
    throw new Error('config.maxIdleSeconds must be within 0..120');
  }
  if (merged.defaultIdleSeconds < 0 || merged.defaultIdleSeconds > merged.maxIdleSeconds) {
    throw new Error('config.defaultIdleSeconds must be within 0..maxIdleSeconds');
  }
  return merged;
}

/** Resolve the absolute executable paths a spawn needs. Node binary is ours. */
export function resolvePaths(config) {
  return {
    nodeBin: process.execPath,
    zcodeBin: isAbsolute(config.zcodeBin) ? config.zcodeBin : resolve(MODULE_DIR, config.zcodeBin),
    providerFile: isAbsolute(config.providerFile)
      ? config.providerFile
      : resolve(MODULE_DIR, config.providerFile),
    taskkillPath: config.taskkillPath,
  };
}

/** Workflow gate mode for this invocation (upstream vocabulary). */
export function workflowModeForRequest(request) {
  return request.nativeWorkflow || request.waitForBackground ? 'onDemand' : 'disabled';
}

/**
 * The isolated ACP-only user config placed under a per-invocation
 * XDG_CONFIG_HOME. Global user ACP config (~/.config/zcode-acp) is shadowed,
 * never read, never modified. ZCode HOME / provider credentials untouched.
 */
export function buildIsolatedAcpConfig({ workflowMode, sessionMode = 'build', quotaAutoResume = false }) {
  if (!['disabled', 'onDemand', 'alwaysOn'].includes(workflowMode)) {
    throw new Error(`Unsupported workflow mode: ${workflowMode}`);
  }
  if (!['plan', 'build', 'edit', 'yolo', 'auto'].includes(sessionMode)) {
    throw new Error(`Unsupported session mode: ${sessionMode}`);
  }
  return {
    relPath: ['zcode-acp', 'config.json'],
    json: {
      session: { mode: sessionMode },
      quota: { autoResume: quotaAutoResume },
      workflow: { mode: workflowMode },
      remote: { enabled: false },
    },
  };
}

/** Ambient env keys removed so inherited settings cannot override the pin. */
const SCRUB_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ZCODE_BASE_URL', 'ZCODE_ENDPOINT_ORIGIN', 'ZCODE_MODEL',
  'ZCODE_ACP_REMOTE', 'ZCODE_ACP_REMOTE_TOKEN', 'ZCODE_ACP_REMOTE_ORIGIN',
  'ZCODE_ACP_REMOTE_PIN_CWD', 'ZCODE_ACP_RESUME_SESSION', 'ZCODE_ACP_BOOT_CREATE_SESSION',
  'ZCODE_ENABLE_AUTOMATION_TOOLS', 'ZCODE_DYNAMIC_WORKFLOW_MODE',
  'ZCODE_ACP_INTERACTION_TIMEOUT_MS', 'ZCODE_ACP_SANDBOX',
  'ZCODE_KEEP_HAPPY_EYEBALLS', 'ZCODE_ACP_DEBUG', 'ZCODE_ACP_AUTO_COMPACT_THRESHOLD',
];

/**
 * Build the bridge child environment: pinned engine/provider/model, isolated
 * XDG_CONFIG_HOME, remote disabled, explicit disallowedTools preserved.
 * `xdgHome` must be the per-invocation absolute temp dir root.
 */
export function buildChildEnv(config, paths, request, xdgHome) {
  const env = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('ZCODE_ACP_REMOTE')) delete env[key];
  }
  env.ZCODE_BIN = paths.zcodeBin;
  env.ZCODE_NODE = paths.nodeBin;
  env.ZCODE_PROVIDER = config.provider;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = paths.providerFile; // path only, never its content
  env.ZCODE_ACP_MODE = request.mode;
  env.ZCODE_ACP_QUOTA_AUTO_RESUME = '0'; // belt under the config file value
  env.ZCODE_ACP_DEBUG = '0';
  env.XDG_CONFIG_HOME = xdgHome;
  env.CODEX_ZCODE_BINDINGS = JSON.stringify({
    approvedWorkflowSha256: request.approvedWorkflowSha256,
    approvedWorkflowModel: request.approvedWorkflowModel,
    workflowRunId: request.workflowRunId,
  });
  // Upstream merges these with its built-in Cron* disallow list; an explicit
  // request list is preserved verbatim (space separated).
  if (Array.isArray(request.disallowedTools) && request.disallowedTools.length > 0) {
    env.ZCODE_DISALLOWED_TOOLS = request.disallowedTools.join(' ');
  } else {
    delete env.ZCODE_DISALLOWED_TOOLS;
  }
  return env;
}
