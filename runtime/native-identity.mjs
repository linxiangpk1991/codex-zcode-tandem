// Local native identity. Fast checks read metadata/cache; explicit doctor/probe
// re-hash the entry even when the CLI version and file timestamps are unchanged.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { writeJsonAtomic } from './jsonio.mjs';
import { probeNativeCliVersion } from './transport.mjs';

export const identityCachePath = root => join(root, 'work', 'native-identity.json');

function stamp(file) {
  try {
    const s = statSync(file, { bigint: true });
    return s.isFile() ? [s.size, s.mtimeNs, s.ctimeNs, s.ino, s.dev].map(String).join(':') : null;
  } catch { return null; }
}

function readCache(root) {
  try {
    const value = JSON.parse(readFileSync(identityCachePath(root), 'utf8'));
    return value.schema === 1 ? value : null;
  } catch { return null; }
}

function localFiles(root, paths) {
  const desktopPath = resolve(dirname(paths.zcodeBin), '..', '..', 'ZCode.exe');
  const acpPath = join(root, 'runtime', 'node_modules', 'zcode-acp-server', 'package.json');
  let acpVersion = null;
  try { acpVersion = JSON.parse(readFileSync(acpPath, 'utf8')).version ?? null; } catch { /* absent */ }
  return { nativePath: resolve(paths.zcodeBin), nativeStamp: stamp(paths.zcodeBin),
    desktopPath, desktopStamp: stamp(desktopPath), acpVersion, nodeVersion: process.versions.node };
}

export function compareIdentity(current, previous, { full = false } = {}) {
  if (!previous) return { status: 'not_verified', compatibilityProbeRecommended: true,
    changedFields: [], note: 'No successful compatibility probe is recorded for this source root.' };
  const fields = full
    ? ['nativePath', 'nativeSha256', 'nativeCliVersion', 'desktopPath', 'desktopVersion', 'acpVersion', 'nodeVersion']
    : ['nativePath', 'nativeStamp', 'desktopPath', 'desktopStamp', 'acpVersion', 'nodeVersion'];
  const changedFields = fields.filter(key => current[key] !== previous[key]);
  return { status: changedFields.length ? 'changed' : full ? 'unchanged' : 'metadata_unchanged',
    compatibilityProbeRecommended: changedFields.length > 0, changedFields,
    lastProbeAt: previous.compatibilityProbe?.verifiedAt ?? null,
    note: full ? 'Identity comparison is local; compatibility probe is not inference acceptance.'
      : 'Metadata/cache only; unchanged metadata or CLI version does not prove unchanged source. Use --doctor to re-hash.' };
}

export function inspectNativeIdentity(root, paths) {
  const local = localFiles(root, paths);
  const previous = readCache(root)?.identity ?? null;
  const comparison = compareIdentity(local, previous);
  const cacheMatches = previous && comparison.status === 'metadata_unchanged';
  return { ...local, nativeSha256: cacheMatches ? previous.nativeSha256 : null,
    nativeCliVersion: cacheMatches ? previous.nativeCliVersion : null,
    desktopVersion: cacheMatches ? previous.desktopVersion : null,
    source: cacheMatches ? 'last-successful-probe-cache' : 'local-metadata',
    observedAt: new Date().toISOString(), comparison };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readDesktopVersion(file, env = process.env) {
  if (!existsSync(file)) return { version: null, reason: 'Desktop executable not found beside native entry.' };
  const shell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `(Get-Item -LiteralPath '${file.replaceAll("'", "''")}').VersionInfo.ProductVersion`;
  return new Promise(resolveResult => execFile(shell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 16_384 },
    (error, stdout) => resolveResult(error ? { version: null, reason: 'Desktop version query failed.' }
      : { version: stdout.trim() || null })));
}

export async function collectNativeIdentity(root, paths, { cliProbe = probeNativeCliVersion,
  desktopProbe = readDesktopVersion } = {}) {
  const local = localFiles(root, paths);
  try {
    const [digest, cli, desktop] = await Promise.all([
      sha256(paths.zcodeBin), cliProbe(paths), desktopProbe(local.desktopPath),
    ]);
    const current = { ...local, nativeSha256: digest, nativeCliVersion: cli.version ?? null,
      desktopVersion: desktop.version ?? null, source: 'fresh-local-inspection',
      observedAt: new Date().toISOString() };
    if (stamp(paths.zcodeBin) !== local.nativeStamp || stamp(local.desktopPath) !== local.desktopStamp) {
      return { ...current, status: 'unstable', reason: 'Native installation changed during inspection.',
        comparison: { status: 'unknown', compatibilityProbeRecommended: true } };
    }
    return { ...current, status: cli.version ? 'available' : 'partial',
      desktopReason: desktop.reason ?? null,
      comparison: compareIdentity(current, readCache(root)?.identity, { full: true }) };
  } catch {
    return { ...local, status: 'unavailable', source: 'fresh-local-inspection',
      reason: 'Native entry could not be read.', comparison: { status: 'unknown', compatibilityProbeRecommended: true } };
  }
}

export function rememberCompatibilityProbe(root, identity, { model, thought, mode } = {}) {
  if (identity.status !== 'available' || identity.acpVersion !== '0.65.1') {
    return { recorded: false, reason: 'Complete stable CLI and pinned ACP identity unavailable.' };
  }
  const now = localFiles(root, { zcodeBin: identity.nativePath });
  if (now.nativeStamp !== identity.nativeStamp || now.desktopStamp !== identity.desktopStamp
    || now.acpVersion !== identity.acpVersion) return { recorded: false, reason: 'Installation changed after inspection.' };
  const compatibilityProbe = { verifiedAt: new Date().toISOString(), model, thought, mode,
    boundary: 'Native connection/configuration only; no model inference or business acceptance.' };
  const file = identityCachePath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, { schema: 1, identity: { ...identity, compatibilityProbe } });
  return { recorded: true, compatibilityProbe };
}
