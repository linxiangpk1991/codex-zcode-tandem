#!/usr/bin/env node
// run-task.mjs — V3 entry point.
//
//   node run-task.mjs REQUEST.json
//
// REQUEST.json selects the action: run (default), quota, probe,
// workflow-resume, workflow-status. Progress goes to PROGRESS.json (atomic),
// the final report to RESULT.json (both optional request fields); without a
// resultFile the report prints to stdout. Exit codes: 0 completed, 1
// failed/needs_attention, 2 timeout/cancelled, 3 paused, 4 handoff not ready.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildConfig } from './config.mjs';
import { normalizeRequest } from './request.mjs';
import { runTask } from './runner.mjs';
import { assertSupportedHost } from './discovery.mjs';

assertSupportedHost();

const requestPath = process.argv[2];
if (!requestPath) {
  console.error('Usage: node run-task.mjs REQUEST.json');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(resolve(requestPath), 'utf8').replace(/^\uFEFF/, ''));
const config = buildConfig();
const request = normalizeRequest(config, raw);
const cwd = realpathSync(resolve(request.cwd));
const { exitCode, report } = await runTask({ request, config, cwd });
if (!request.resultFile) {
  console.log(JSON.stringify({ ...report, tools: report.tools?.length ?? 0 }, null, 2));
}
process.exit(exitCode);
