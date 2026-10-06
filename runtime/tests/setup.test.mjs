import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSetup, installSetup, parseArgs } from '../../scripts/setup.mjs';

function fixture(root = mkdtempSync(join(tmpdir(), 'zcode 通用版 '))) {
  const runtime = join(root, 'runtime');
  mkdirSync(join(runtime, 'node_modules', 'zcode-acp-server'), { recursive: true });
  writeFileSync(join(runtime, 'node_modules', 'zcode-acp-server', 'package.json'), '{"version":"0.65.1"}');
  writeFileSync(join(root, 'SKILL.md'), 'canonical source');
  for (const name of ['zcode.cjs', 'provider.json', 'taskkill.exe']) writeFileSync(join(root, name), 'dummy');
  writeFileSync(join(runtime, 'config.json'), JSON.stringify({ zcodeBin: join(root, 'zcode.cjs'),
    providerFile: join(root, 'provider.json'), taskkillPath: join(root, 'taskkill.exe'), heartbeatMs: 2000 }));
  return { root, runtime, home: join(root, 'recipient'), env: {}, platform: 'win32', nodeVersion: '24.19.0', nodeBin: 'X:\\Node\\node.exe' };
}

test('setup diagnoses without changing files and preserves tuning during install', () => {
  const host = fixture();
  const before = readFileSync(join(host.runtime, 'config.json'), 'utf8');
  const check = inspectSetup({ '--check': true }, host);
  installSetup(check, { '--check': true });
  assert.equal(readFileSync(check.configFile, 'utf8'), before);
  assert.equal(existsSync(check.skillDir), false);
  const plan = inspectSetup({}, host);
  assert.equal(plan.skillDir, join(host.home, '.agents', 'skills', 'codex-zcode-tandem'));
  installSetup(plan, {});
  assert.equal(JSON.parse(readFileSync(plan.configFile, 'utf8')).heartbeatMs, 2000);
  assert.ok(readFileSync(plan.skillFile, 'utf8').includes(host.root.replaceAll('\\', '/')));
  assert.equal(readFileSync(join(host.root, 'provider.json'), 'utf8'), 'dummy');
  const again = installSetup(inspectSetup({}, host), {});
  assert.deepEqual(again.backups, [], 'idempotent installation must not create repeated backups');
});

test('existing skill needs explicit replacement, is backed up, and neighboring files survive', () => {
  const host = fixture();
  const dir = join(host.home, '.codex', 'skills', 'codex-zcode-tandem');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'previous skill');
  writeFileSync(join(dir, 'keep.txt'), 'preserved');
  assert.throws(() => inspectSetup({}, host), /--replace/);
  const result = installSetup(inspectSetup({ '--replace': true }, host), { '--replace': true });
  assert.equal(existsSync(join(host.home, '.agents')), false, 'reuse legacy without adding a duplicate');
  const saved = result.backups.find(path => path.includes('SKILL.md.backup-'));
  assert.equal(readFileSync(saved, 'utf8'), 'previous skill');
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'preserved');
});

test('a repository cloned directly into the skill directory keeps its canonical SKILL', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'zcode-direct-'));
  const directRoot = join(codexHome, 'skills', 'codex-zcode-tandem');
  const host = fixture(directRoot);
  const plan = inspectSetup({ '--codex-home': codexHome }, host);
  assert.equal(plan.direct, true);
  installSetup(plan, { '--codex-home': codexHome });
  assert.equal(readFileSync(plan.skillFile, 'utf8'), 'canonical source');
});

test('argument validation and invalid dependency stop before writes', () => {
  assert.throws(() => parseArgs(['--zcode-bin']), /缺少/);
  assert.throws(() => parseArgs(['--unknown']), /未知/);
  assert.throws(() => parseArgs(['--check', '--check']), /重复/);
  const host = fixture();
  writeFileSync(join(host.runtime, 'node_modules', 'zcode-acp-server', 'package.json'), '{"version":"0.47.0"}');
  assert.throws(() => inspectSetup({}, host), /0.65.1/);
  assert.equal(existsSync(join(host.home, '.agents')), false);
  assert.equal(readdirSync(host.runtime).some(name => name.includes('backup-')), false);
});

test('Coding Plan does not require a personal provider file; explicit missing paths fail', () => {
  const host = fixture();
  unlinkSync(join(host.root, 'provider.json'));
  const plan = inspectSetup({ '--check': true }, host);
  assert.equal(installSetup(plan, { '--check': true }).optionalProviderConfigPresent, false);
  assert.throws(() => inspectSetup({ '--provider-file': join(host.root, 'missing.json') }, host), /自定义供应商配置不存在/);
});

test('duplicate discovery roots require an explicit target and path selectors cannot conflict', () => {
  const host = fixture();
  for (const folder of ['.agents', '.codex']) {
    const dir = join(host.home, folder, 'skills', 'codex-zcode-tandem');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), folder);
  }
  assert.throws(() => inspectSetup({ '--check': true }, host), /各有同名技能/);
  const plan = inspectSetup({ '--check': true, '--skills-dir': join(host.home, '.agents', 'skills') }, host);
  assert.equal(plan.previous, '.agents');
  assert.throws(() => parseArgs(['--codex-home', 'one', '--skills-dir', 'two']), /不能同时/);
});

test('public installation leaves a private zcode-native entry and its files untouched', () => {
  const host = fixture();
  const privateDir = join(host.home, '.codex', 'skills', 'zcode-native');
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, 'SKILL.md'), 'private source pointer');
  writeFileSync(join(privateDir, 'local-settings.json'), '{"preserve":true}');
  const plan = inspectSetup({}, host);
  installSetup(plan, {});
  assert.equal(plan.skillDir, join(host.home, '.agents', 'skills', 'codex-zcode-tandem'));
  assert.match(readFileSync(plan.skillFile, 'utf8'), /name: codex-zcode-tandem/);
  assert.equal(readFileSync(join(privateDir, 'SKILL.md'), 'utf8'), 'private source pointer');
  assert.equal(readFileSync(join(privateDir, 'local-settings.json'), 'utf8'), '{"preserve":true}');
  assert.deepEqual(readdirSync(privateDir).sort(), ['SKILL.md', 'local-settings.json']);
});
