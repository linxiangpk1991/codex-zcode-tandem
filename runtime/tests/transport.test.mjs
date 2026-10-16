import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTransport } from '../transport.mjs';

test('real ACP transport routes one turnState alias, retaining session identity', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-wire-'));
  const path = join(cwd, 'fixture.cjs');
  writeFileSync(path, `const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line', line => { const request=JSON.parse(line);
  for (const method of ['$/zcode/turnState','_zcode/turnState'])
    send({jsonrpc:'2.0',method,params:{sessionId:'session-a',running:false,usage:{totalTokens:12},turnMs:20}});
  send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}});
}); rl.on('close',()=>process.exit(0));`);
  let transport;
  try {
    transport = await spawnTransport({ bridgePath: path, cwd, env: process.env, onEvent() {} });
    const seen = [];
    let observed;
    const notification = new Promise(resolve => { observed = resolve; });
    transport.on({ turnState: params => { seen.push(params); observed(); } });
    await transport.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await notification;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sessionId, 'session-a');
    assert.equal(seen[0].turnMs, 20);
  } finally {
    if (transport) {
      await transport.dispose({ graceMs: 2000 });
      // dispose may request a kill after its grace period. Wait for this owned
      // child to exit before deleting its Windows working directory.
      const stopped = await transport.waitExit(3000);
      assert.notEqual(stopped.signal, 'timeout', 'fixture child must exit before cleanup');
    }
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
