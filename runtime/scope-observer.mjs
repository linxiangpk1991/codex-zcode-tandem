import { decideToolPermission, KIND_BY_TOOL, nativeToolName } from './policy.mjs';
import { scopeInput } from './workspace-policy.mjs';

export class ScopeObserver {
  constructor(request, config) {
    this.request = request; this.maxEntries = config.maxTools;
    this.budget = request.maxOutputBytes; this.bytes = 0;
    this.inputs = new Map(); this.seen = new Set(); this.records = []; this.truncated = false;
  }
  input(id) { return this.inputs.get(id)?.value; }
  forget(id) {
    this.bytes -= this.inputs.get(id)?.bytes ?? 0;
    this.inputs.delete(id);
  }
  observe(tool, rawInput) {
    const name = nativeToolName(tool), id = tool.toolCallId;
    if (!['edit', 'execute'].includes(KIND_BY_TOOL[name])) return null;
    if (rawInput !== undefined) {
      const value = scopeInput(name, rawInput);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      this.forget(id);
      if (bytes <= this.budget) {
        this.inputs.set(id, { value, bytes }); this.bytes += bytes;
        while (this.bytes > this.budget || this.inputs.size > this.maxEntries) {
          this.forget(this.inputs.keys().next().value); this.truncated = true;
        }
      } else this.truncated = true;
    }
    if (!['completed', 'failed'].includes(tool.status) || this.seen.has(id)) return null;
    this.seen.add(id);
    if (this.seen.size > this.maxEntries * 2) this.seen.delete(this.seen.values().next().value);
    const input = this.input(id);
    const decision = input ? decideToolPermission({ request: this.request, nativeName: name, rawInput: input })
      : { allowed: null, reason: 'scope input unavailable within retention budget', binding: 'workspace' };
    const record = { toolCallId: id, nativeName: name, ...decision, postHoc: true };
    this.records.push(record); this.forget(id);
    if (this.records.length > this.maxEntries) { this.records.shift(); this.truncated = true; }
    return record;
  }
}
