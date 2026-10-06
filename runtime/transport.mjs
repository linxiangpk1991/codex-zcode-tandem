// Real transport: spawns the bridge child (bridge.mjs) and speaks ACP to it
// over stdio with the SDK bundled as zcode-acp-server's own dependency, plus
// the private IPC channel (4th stdio fd) for policy/PID events and the
// allowlisted workflow ops. Injected into the runner; tests use fakes.
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

let cachedSdk = null;
async function loadSdk() {
  if (cachedSdk) return cachedSdk;
  // Resolve the SDK through the pinned ACP package's own dependency tree so
  // the wire dialect always matches the server we spawn.
  const require = createRequire(join(MODULE_DIR, 'node_modules', 'zcode-acp-server', 'package.json'));
  const sdkPath = require.resolve('@agentclientprotocol/sdk');
  cachedSdk = await import(pathToFileURL(sdkPath));
  return cachedSdk;
}

/**
 * Spawn the bridge and return a transport handle:
 *   conn          — SDK ClientSideConnection
 *   pid           — bridge child pid
 *   ipcCall(op, payload, timeoutMs) — serialized request/response over IPC
 *   dispose(graceMs) — close stdin (graceful upstream shutdown), then kill
 *   onEvent(cb)   — bridge IPC events (policy, native_*, backend_dead, exit)
 */
export async function spawnTransport({ bridgePath, cwd, env, onEvent,
  ipcTimeoutMs = 30_000, sdk = null }) {
  const acp = sdk ?? await loadSdk();
  const child = spawn(process.execPath, [bridgePath], {
    cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let exitInfo = null;
  const exitWaiters = [];
  child.stderr.on('data', b => { if (stderr.length < 16_000) stderr += b.toString(); });
  child.on('error', e => onEvent({ type: 'bridge_error', error: e.message }));
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    onEvent({ type: 'bridge_exit', code, signal, stderr });
    for (const w of exitWaiters.splice(0)) w(exitInfo);
  });

  const handlers = {};
  const pending = new Map();
  const handleIpcResponse = (message) => {
    if (!message?.v3ipc || typeof message.id !== 'string') return false;
    const entry = pending.get(message.id);
    if (!entry) return true;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(`${message.error?.reason ?? 'error'}: ${message.error?.message ?? 'unknown'}`));
    return true;
  };
  const routedEvent = (message) => {
    if (handleIpcResponse(message)) return;
    onEvent(message ?? {});
  };
  child.on('message', routedEvent);
  const conn = new acp.ClientSideConnection(() => ({
    async sessionUpdate(params) {
      await handlers.sessionUpdate?.(params?.update ?? params);
    },
    async requestPermission(params) {
      const reply = await handlers.requestPermission?.(params);
      return reply ?? { outcome: { outcome: 'cancelled' } };
    },
    async extNotification() { /* $/zcode/* hints need no handling */ },
  }), acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));

  let queue = Promise.resolve();
  const ipcCall = (op, payload = {}, timeoutMs = ipcTimeoutMs) => {
    const run = () => new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bridge IPC ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.send({ v3ipc: true, id, op, payload });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
    queue = queue.then(run, run);
    return queue;
  };

  const waitExit = (ms) => new Promise(resolve => {
    if (exitInfo) return resolve(exitInfo);
    const t = setTimeout(() => resolve({ code: null, signal: 'timeout' }), ms);
    t.unref?.();
    exitWaiters.push(info => { clearTimeout(t); resolve(info); });
  });

  return {
    conn,
    pid: child.pid,
    child,
    ipcCall,
    on(handler) {
      Object.assign(handlers, handler);
    },
    stderr: () => stderr,
    waitExit,
    async dispose({ graceMs = 3000 } = {}) {
      // Graceful: closing stdin makes upstream main() run its shutdown path
      // (backend close, exit 0). Bounded; the caller still reaps the tree.
      try { child.stdin?.end(); } catch { /* already gone */ }
      const info = await waitExit(graceMs);
      if (info.code === null && info.signal === 'timeout' && child.exitCode === null) {
        try { child.kill(); } catch { /* already gone */ }
      }
      return info;
    },
  };
}

/** Best-effort one-shot native CLI version probe (no inference). */
export function probeNativeCliVersion({ nodeBin, zcodeBin, timeoutMs = 10_000 }) {
  return new Promise(resolve => {
    execFile(nodeBin, [zcodeBin, '--version'],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout) => resolve(err
        ? { error: err.message }
        : { version: String(stdout).trim().split('\n')[0] }));
  });
}
