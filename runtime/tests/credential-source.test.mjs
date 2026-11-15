import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingCodingPlanResponder } from '../credential-source.mjs';

test('explicit existing key mode stays on the enabled individual Coding Plan and never falls back', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-auth-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const file = join(dir, 'config.json');
  const key = 'test-only-no-credential';
  writeFileSync(file, JSON.stringify({provider:{'builtin:bigmodel-coding-plan':{enabled:true,options:{apiKey:key}}}}));
  const answer = existingCodingPlanResponder(file);
  let response;
  const backend = { sendReply: (_id, value) => { response = value; } };
  const req = providerId => ({id:1,method:'interaction/requestProviderRuntimeHeaders',params:{providerId}});
  assert.equal(answer(backend, req('account:bigmodel-individual-coding-plan')), true);
  assert.equal(response.requestAuth.apiKey, key);
  for (const provider of [undefined,'account:bigmodel-start-plan','account:bigmodel-team-coding-plan','custom']) {
    answer(backend, req(provider)); assert.equal(response.headersApplied, false);
    assert.equal(response.requestAuth, undefined);
  }
  writeFileSync(file, '{}');
  answer(backend, req('account:bigmodel-individual-coding-plan'));
  assert.equal(response.headersApplied, false);
  assert.match(response.errorMessage, /no fallback/);
  assert.equal(answer(backend, {method:'permission/request'}), false);
});
