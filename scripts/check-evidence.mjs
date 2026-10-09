#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { prepareCheck, assessCheck, assessVerification } from '../runtime/verification.mjs';
import { assessDelivery } from '../runtime/delivery.mjs';
import { writeJsonAtomic } from '../runtime/jsonio.mjs';

const [action, input, output] = process.argv.slice(2);
if (action === 'prepare' && input && output) {
  const prepared = prepareCheck(JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, '')));
  writeJsonAtomic(output, prepared);
  console.log(JSON.stringify({ name: prepared.name, candidateSha256: prepared.candidateSha256, preparedFile: output }));
} else if (action === 'inspect' && input && output) {
  const check = assessCheck({ preparedFile: input, receiptFile: output });
  console.log(JSON.stringify(check, null, 2));
  process.exitCode = check.outcome === 'pass' ? 0 : 1;
} else if (action === 'handoff' && input && !output) {
  const report = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  if (!report.deliveryContract) throw new Error('Report has no bound delivery contract; rerun first-pass review with delivery scope');
  report.verification = assessVerification(report.deliveryContract.verification);
  const delivery = assessDelivery(report.deliveryContract, report);
  console.log(JSON.stringify(delivery, null, 2));
  process.exitCode = delivery.status === 'ready_for_controller_review' ? 0 : 4;
} else {
  console.error('Usage: node scripts/check-evidence.mjs prepare SPEC.json PREPARED.json | inspect PREPARED.json RECEIPT.json | handoff RESULT.json');
  process.exitCode = 1;
}
