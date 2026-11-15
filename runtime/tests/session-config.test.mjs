// Session-config readback regressions for the one upstream-defined provider
// alias: zcode-acp-server 0.85.3 resolves the pinned
// `builtin:bigmodel-coding-plan` to `account:bigmodel-individual-coding-plan`
// in the registry (config/account-provider.js accountProviderIdFor; the
// configOption value is `providerId\modelId`). Same individual Coding Plan —
// NOT a provider switch. Acceptance requires the identical full model id;
// every other account/plan spelling, a bare model id, Flash, a different
// thought level or a different mode stays a hard mismatch, and the report
// keeps the NATIVE effective string verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySessionOptions, modelSelectionMatches } from '../session-config.mjs';

const PINNED = Object.freeze({
  provider: 'builtin:bigmodel-coding-plan', model: 'GLM-5.3', thought: 'max', mode: 'build',
});
const NATIVE_ALIAS = 'account:bigmodel-individual-coding-plan\\GLM-5.3';

/** Fake conn whose configOptions read back fixed current values. */
function fakeConn(current) {
  return {
    setSessionConfigOption: async ({ configId }) => ({
      configOptions: [{ id: configId, currentValue: current(configId) }],
    }),
  };
}
const defaults = configId => ({ model: `${PINNED.provider}\\${PINNED.model}`,
  mode: PINNED.mode, thought: PINNED.thought }[configId]);

test('the upstream account alias of the pinned provider is accepted and reported verbatim', async () => {
  const applied = await applySessionOptions(fakeConn(id => (id === 'model' ? NATIVE_ALIAS : defaults(id))),
    'sess-1', PINNED);
  assert.equal(applied.modelEffective, NATIVE_ALIAS, 'the native string is kept, never rewritten');
  assert.equal(applied.modeEffective, 'build');
  assert.equal(applied.thoughtEffective, 'max');
  const exact = await applySessionOptions(fakeConn(defaults), 'sess-1', PINNED);
  assert.equal(exact.modelEffective, 'builtin:bigmodel-coding-plan\\GLM-5.3');
});

test('other accounts, plan spellings and providers are rejected with both identities in the error', async () => {
  for (const effective of [
    'account:bigmodel-start-plan\\GLM-5.3',
    'account:bigmodel-team-coding-plan\\GLM-5.3',
    'account:zai-individual-coding-plan\\GLM-5.3',
    'builtin:bigmodel-start-plan\\GLM-5.3',
    'custom:paid\\GLM-5.3',
    'GLM-5.3',
  ]) {
    await assert.rejects(
      applySessionOptions(fakeConn(id => (id === 'model' ? effective : defaults(id))), 'sess-1', PINNED),
      /model selection mismatch: requested builtin:bigmodel-coding-plan\\GLM-5.3, effective/,
      `rejected: ${effective}`);
  }
});

test('a substituted model (Flash) under the aliased provider is rejected', async () => {
  await assert.rejects(
    applySessionOptions(fakeConn(id => (id === 'model'
      ? 'account:bigmodel-individual-coding-plan\\GLM-5.3-Flash' : defaults(id))), 'sess-1', PINNED),
    /model selection mismatch: requested builtin:bigmodel-coding-plan\\GLM-5.3, effective account:bigmodel-individual-coding-plan\\GLM-5.3-Flash/);
  await assert.rejects(
    applySessionOptions(fakeConn(id => (id === 'model'
      ? 'account:bigmodel-individual-coding-plan\\GLM-5.2' : defaults(id))), 'sess-1', PINNED),
    /model selection mismatch/);
});

test('thought and mode divergence still fail the invocation', async () => {
  await assert.rejects(
    applySessionOptions(fakeConn(id => (id === 'thought' ? 'high' : defaults(id))), 'sess-1', PINNED),
    /thought selection mismatch: requested max, effective high/);
  await assert.rejects(
    applySessionOptions(fakeConn(id => (id === 'mode' ? 'yolo' : defaults(id))), 'sess-1', PINNED),
    /mode selection mismatch: requested build, effective yolo/);
});

test('modelSelectionMatches stays a frozen pair, not an account: generalization', () => {
  assert.equal(modelSelectionMatches(PINNED.provider, 'GLM-5.3', NATIVE_ALIAS), true);
  assert.equal(modelSelectionMatches(PINNED.provider, 'GLM-5.3', `${PINNED.provider}\\GLM-5.3`), true);
  assert.equal(modelSelectionMatches(PINNED.provider, 'GLM-5.3',
    'account:bigmodel-individual-coding-plan/GLM-5.3'), false, 'forward slash is not the configOption encoding');
  assert.equal(modelSelectionMatches(PINNED.provider, 'GLM-5.3',
    'account:bigmodel-individual-coding-plan\\GLM-5.3$max'), false, 'no thought suffix in this field');
  assert.equal(modelSelectionMatches('builtin:bigmodel-start-plan', 'GLM-5.3',
    'account:bigmodel-start-plan\\GLM-5.3'), false, 'the alias belongs to the pinned provider only');
  assert.equal(modelSelectionMatches(PINNED.provider, 'GLM-5.3', undefined), false);
  assert.equal(modelSelectionMatches(PINNED.provider, 'GLM-5.3', null), false);
});
