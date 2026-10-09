import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNativeIdentity, compareIdentity, inspectNativeIdentity, rememberCompatibilityProbe, identityCachePath } from '../native-identity.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zcode-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zcodeBin = join(root, 'app', 'resources', 'glm', 'zcode.cjs');
  mkdirSync(join(root, 'app', 'resources', 'glm'), { recursive: true });
  mkdirSync(join(root, 'runtime', 'node_modules', 'zcode-acp-server'), { recursive: true });
  writeFileSync(zcodeBin, 'native A');
  writeFileSync(join(root, 'runtime', 'node_modules', 'zcode-acp-server', 'package.json'), '{"version":"0.65.1"}');
  return { root, paths: { zcodeBin, nodeBin: process.execPath },
    probes: { cliProbe: async () => ({ version: '0.16.9' }), desktopProbe: async () => ({ version: '3.14.5' }) } };
}

test('doctor is read-only; only stable successful-probe recording creates a baseline', async t => {
  const f = fixture(t);
  const identity = await collectNativeIdentity(f.root, f.paths, f.probes);
  assert.equal(identity.comparison.status, 'not_verified');
  assert.equal(existsSync(identityCachePath(f.root)), false);
  assert.equal(inspectNativeIdentity(f.root, f.paths).nativeSha256, null);
  assert.equal(rememberCompatibilityProbe(f.root, { ...identity, status: 'unavailable' }).recorded, false);
  assert.equal(existsSync(identityCachePath(f.root)), false);
  assert.equal(rememberCompatibilityProbe(f.root, identity, { model: 'GLM-5.3', thought: 'max', mode: 'build' }).recorded, true);
  const cached = inspectNativeIdentity(f.root, f.paths);
  assert.equal(cached.source, 'last-successful-probe-cache');
  assert.equal(cached.comparison.status, 'metadata_unchanged');
  assert.equal(cached.nativeSha256, identity.nativeSha256);
});

test('same CLI version with different source hash requests compatibility probe without refreshing baseline', async t => {
  const f = fixture(t);
  const a = await collectNativeIdentity(f.root, f.paths, f.probes);
  rememberCompatibilityProbe(f.root, a);
  const before = readFileSync(identityCachePath(f.root), 'utf8');
  writeFileSync(f.paths.zcodeBin, 'native B');
  const b = await collectNativeIdentity(f.root, f.paths, f.probes);
  assert.equal(b.nativeCliVersion, a.nativeCliVersion);
  assert.notEqual(b.nativeSha256, a.nativeSha256);
  assert.equal(b.comparison.status, 'changed');
  assert.ok(b.comparison.changedFields.includes('nativeSha256'));
  assert.equal(b.comparison.compatibilityProbeRecommended, true);
  assert.equal(readFileSync(identityCachePath(f.root), 'utf8'), before);
  assert.equal(rememberCompatibilityProbe(f.root, a).recorded, false, 'stale inspection cannot advance baseline');
});

test('full comparison uses hashes even if all version and metadata fields match', () => {
  const previous = { nativeSha256: 'a', nativeCliVersion: '0.16.9', nativeStamp: 'same' };
  const result = compareIdentity({ ...previous, nativeSha256: 'b' }, previous, { full: true });
  assert.deepEqual(result.changedFields, ['nativeSha256']);
});

test('installation mutation during collection is unstable and is not cached', async t => {
  const f = fixture(t);
  const identity = await collectNativeIdentity(f.root, f.paths, { ...f.probes,
    cliProbe: async () => { writeFileSync(f.paths.zcodeBin, 'updated while querying'); return { version: '0.16.9' }; } });
  assert.equal(identity.status, 'unstable');
  assert.equal(rememberCompatibilityProbe(f.root, identity).recorded, false);
  assert.equal(existsSync(identityCachePath(f.root)), false);
});
