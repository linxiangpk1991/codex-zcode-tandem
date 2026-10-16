// One binding implementation for callback permission checks and post-hoc
// observations. This cannot sandbox native auto-allowed/background tools.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function canonicalJson(value, depth = 0) {
  if (depth > 40) throw new Error('JSON nesting limit exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('Sparse or decorated arrays are not ordinary JSON');
    return `[${value.map(v => canonicalJson(v, depth + 1)).join(',')}]`;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype && !Object.getOwnPropertySymbols(value).length) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Expected ordinary JSON values');
}

export function jsonRecord(value, name) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${name} must be a JSON object`);
  const canonical = canonicalJson(value);
  if (canonical.length > 64000) throw new Error(`${name} exceeds 64000 characters`);
  return canonical;
}

export function canonicalWorkflowModel(model) {
  return /^GLM-5\.3(?:-Flash)?\$(?:low|high|max)$/.test(model ?? '')
    ? `account:bigmodel-individual-coding-plan/${model}` : model;
}

export function readWorkflowScript(input, cwd) {
  if (!input || input.saved !== undefined) throw new Error('Resolve saved workflows to a reviewed local path first');
  if (typeof input.path !== 'string') {
    if (typeof input.script !== 'string') throw new Error('Use a script or path');
    if (input.args !== undefined) throw new Error('Inline scripts do not accept args');
    if (input.script_line_offset !== undefined) throw new Error('Inline scripts cannot carry a path line offset');
    if (Buffer.byteLength(input.script) > 1_000_000) throw new Error('script too large to verify');
    return { script: input.script };
  }
  const path = resolve(cwd, input.path);
  if (statSync(path).size > 1_000_000) throw new Error('script too large to verify');
  const script = readFileSync(path, 'utf8');
  if (input.script !== undefined) {
    // Native Create/Amend expands a path to its body before permission. Bind
    // the entire file hash AND verify that supplied body against that file.
    // This only checks the envelope; the native compiler owns YAML semantics.
    const lines = script.split('\n');
    const first = lines.findIndex(line => line.trim() !== '');
    let offset = 0;
    if (first >= 0 && lines[first].trim() === '/* zcode-workflow') {
      const end = lines.findIndex((line, index) => index > first && line.trim() === '*/');
      if (end < 0) throw new Error('Unclosed workflow metadata');
      offset = end + 1;
    }
    if ((input.script_line_offset ?? 0) !== offset || input.script !== lines.slice(offset).join('\n')) {
      throw new Error('Resolved workflow body does not match the approved path');
    }
  } else if (input.script_line_offset !== undefined) throw new Error('Line offset requires a resolved body');
  return { script, path };
}

export function inspectWorkflowBinding(request, input, cwd = request.cwd ?? process.cwd()) {
  try {
    const allowed = ['name', 'script', 'path', 'args', 'model_bindings', 'subagent_model', 'max_concurrency', 'run_id', 'script_line_offset', 'predecessor', 'adjustable_settings'];
    if (Object.keys(input ?? {}).some(k => !allowed.includes(k))) throw new Error('Unreviewed workflow input field');
    // Native 3.15 adds UI capability metadata before permission. These are
    // not selected settings and cannot change the bound execution values.
    if (input?.adjustable_settings !== undefined) {
      const settings = input.adjustable_settings;
      jsonRecord(settings, 'adjustable_settings');
      if (Object.keys(settings).some(k => !['subagent_model', 'concurrency_ceiling'].includes(k))
        || typeof settings.subagent_model !== 'boolean'
        || (settings.concurrency_ceiling !== undefined && (!Number.isSafeInteger(settings.concurrency_ceiling)
          || settings.concurrency_ceiling < 1))) throw new Error('Invalid workflow UI metadata');
    }
    if ((input?.max_concurrency !== undefined || request.approvedWorkflowMaxConcurrency !== undefined) && (!Number.isInteger(input.max_concurrency)
      || input.max_concurrency < 1 || input.max_concurrency > 4
      || input.max_concurrency !== request.approvedWorkflowMaxConcurrency)) throw new Error('Unapproved workflow concurrency');
    if (input?.predecessor !== undefined && (!request.workflowRunId || input.run_id !== request.workflowRunId
      || input.predecessor?.owned_by_this_session !== true)) throw new Error('Unbound workflow predecessor');
    const { script, path } = readWorkflowScript(input, cwd);
    const sha256 = createHash('sha256').update(script).digest('hex');
    const model = canonicalWorkflowModel(input.subagent_model);
    const args = jsonRecord(input.args === undefined ? {} : input.args, 'args');
    const bindings = jsonRecord(input.model_bindings === undefined ? {} : input.model_bindings, 'model_bindings');
    const matched = !!request.approvedWorkflowSha256 && typeof request.approvedWorkflowModel === 'string'
      && sha256 === request.approvedWorkflowSha256 && model === request.approvedWorkflowModel
      && args === jsonRecord(request.approvedWorkflowArgs ?? {}, 'approvedWorkflowArgs')
      && bindings === jsonRecord(request.approvedWorkflowModelBindings ?? {}, 'approvedWorkflowModelBindings');
    return { matched, sha256, model, ...(path ? { path } : {}),
      argsSha256: createHash('sha256').update(args).digest('hex'),
      modelBindingsSha256: createHash('sha256').update(bindings).digest('hex'),
      reason: matched ? 'script/model/args/model_bindings match' : 'workflow script/model/args/model_bindings mismatch' };
  } catch (error) { return { matched: false, reason: `cannot verify workflow: ${error.code ?? error.message}` }; }
}

export function validateWorkflowInputs(raw, config, thought) {
  if (raw.approvedWorkflowMaxConcurrency !== undefined && (!Number.isInteger(raw.approvedWorkflowMaxConcurrency)
    || raw.approvedWorkflowMaxConcurrency < 1 || raw.approvedWorkflowMaxConcurrency > 4)) {
    throw new Error('approvedWorkflowMaxConcurrency must be an integer from 1 to 4');
  }
  if (raw.approvedWorkflowArgs !== undefined) jsonRecord(raw.approvedWorkflowArgs, 'approvedWorkflowArgs');
  if (raw.approvedWorkflowModelBindings !== undefined) {
    jsonRecord(raw.approvedWorkflowModelBindings, 'approvedWorkflowModelBindings');
    for (const value of Object.values(raw.approvedWorkflowModelBindings)) {
      const canonical = canonicalWorkflowModel(value);
      if (!config.models.some(m => canonical === `account:bigmodel-individual-coding-plan/${m}$${thought}`)) {
        throw new Error('approvedWorkflowModelBindings must use allowed Coding Plan models at the requested thought level');
      }
    }
  }
}
