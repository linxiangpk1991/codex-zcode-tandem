import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverPaths, assertSupportedHost } from '../discovery.mjs';

const host = { platform: 'win32', home: 'X:\\用户 乙',
  env: { SystemRoot: 'Y:\\Windows', LOCALAPPDATA: 'X:\\用户 乙\\AppData\\Local', ProgramFiles: 'Y:\\应用' } };

test('discovery uses the recipient home/system drive and existing installation', () => {
  const bin = 'Y:\\应用\\ZCode\\resources\\glm\\zcode.cjs';
  const paths = discoverPaths({ ...host, fileExists: path => path === bin });
  assert.equal(paths.zcodeBin, bin);
  assert.equal(paths.providerFile, 'X:\\用户 乙\\.zcode\\v2\\provider_config.json');
  assert.equal(paths.taskkillPath, 'Y:\\Windows\\System32\\taskkill.exe');
});

test('explicit custom locations override discovery without reading credential content', () => {
  const paths = discoverPaths({ ...host, env: { ...host.env,
    ZCODE_NATIVE_BIN: 'Z:\\便携版\\zcode.cjs', ZCODE_NATIVE_PROVIDER_FILE: 'Z:\\登录配置.json' },
    fileExists: () => { throw new Error('explicit paths should need no search'); } });
  assert.equal(paths.zcodeBin, 'Z:\\便携版\\zcode.cjs');
  assert.equal(paths.providerFile, 'Z:\\登录配置.json');
});

test('missing installation produces a candidate for diagnosis, never borrows an author path', () => {
  const paths = discoverPaths({ ...host, fileExists: () => false });
  assert.equal(paths.zcodeBin, 'X:\\用户 乙\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs');
});

test('native data root follows ZCODE_HOME and the upstream HOME precedence', () => {
  const paths = discoverPaths({ ...host, env: { ...host.env, ZCODE_HOME: 'Z:\\NativeData' }, fileExists: () => false });
  assert.equal(paths.providerFile, 'Z:\\NativeData\\v2\\provider_config.json');
  const legacy = discoverPaths({ ...host, env: { ...host.env, HOME: 'W:\\ZCodeHome' }, fileExists: () => false });
  assert.equal(legacy.providerFile, 'W:\\ZCodeHome\\.zcode\\v2\\provider_config.json');
});

test('supported host is explicit and does not quietly weaken the runtime pin', () => {
  assert.doesNotThrow(() => assertSupportedHost({ platform: 'win32', nodeVersion: '24.19.0' }));
  assert.throws(() => assertSupportedHost({ platform: 'linux', nodeVersion: '24.19.0' }), /仅支持 Windows/);
  assert.throws(() => assertSupportedHost({ platform: 'win32', nodeVersion: '22.0.0' }), /Node 24.19.0/);
});
