import { homedir } from 'node:os';
import { win32, posix } from 'node:path';
import { statSync } from 'node:fs';

export const SUPPORTED_NODE = '24.19.0';

export function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

// No registry, credential reads, shell execution, or whole-drive search.
// Custom locations are supplied through config.json or explicit environment.
export function discoverPaths({ env = process.env, home = homedir(),
  platform = process.platform, fileExists = isFile } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const localApps = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? path.join(path.parse(home).root, 'Windows');
  const programs = env.ProgramFiles ?? path.join(path.parse(systemRoot).root, 'Program Files');
  const zcodeHome = env.ZCODE_HOME || path.join(env.HOME || env.USERPROFILE || home, '.zcode');
  const candidates = [...new Set([
    path.join(localApps, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    path.join(programs, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ...(env['ProgramFiles(x86)'] ? [path.join(env['ProgramFiles(x86)'], 'ZCode', 'resources', 'glm', 'zcode.cjs')] : []),
  ])];
  return {
    zcodeBin: env.ZCODE_NATIVE_BIN || candidates.find(fileExists) || candidates[0],
    providerFile: env.ZCODE_NATIVE_PROVIDER_FILE || path.join(zcodeHome, 'v2', 'provider_config.json'),
    taskkillPath: path.join(systemRoot, 'System32', 'taskkill.exe'),
    candidates,
  };
}

export function assertSupportedHost({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (platform !== 'win32') throw new Error('此版本仅支持 Windows；macOS/Linux 尚未完成真实进程清理验收。');
  if (nodeVersion !== SUPPORTED_NODE) throw new Error(`请使用 Node ${SUPPORTED_NODE}；当前为 ${nodeVersion}。`);
}
