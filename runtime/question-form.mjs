// The supported subset of ACP elicitation forms. Unknown constraints are
// rejected; they must never be silently accepted as an unconstrained field.
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const annotations = ['title','description','default'];
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported question form schema');
}
function choices(schema) {
  if (schema.enum) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(v => typeof v !== 'string')) throw new Error('Invalid enum');
    return schema.enum;
  }
  const values = schema.oneOf ?? schema.anyOf;
  if (!values) return null;
  if (!Array.isArray(values) || !values.length) throw new Error('Invalid choices');
  return values.map(v => { keys(v, ['const','title']); if (typeof v.const !== 'string') throw new Error('Invalid choice'); return v.const; });
}
export function normalizeFormSchema(schema) {
  if (Buffer.byteLength(JSON.stringify(schema) ?? '') > 32000) throw new Error('Question form too large');
  keys(schema, ['type','properties','required', ...annotations]);
  if (schema.type !== 'object' || !object(schema.properties)) throw new Error('Question form must be an object');
  const names = Object.keys(schema.properties);
  if (!names.length || names.length > 40 || names.some(k => ['__proto__','prototype','constructor'].includes(k))) throw new Error('Invalid question fields');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => !names.includes(k)))) throw new Error('Invalid required fields');
  for (const field of Object.values(schema.properties)) {
    if (field.type === 'string') { keys(field, ['type','enum','oneOf','minLength','maxLength', ...annotations]); choices(field); }
    else if (field.type === 'array') {
      keys(field, ['type','items','minItems','maxItems', ...annotations]);
      keys(field.items, ['type','enum','anyOf', ...annotations]);
      if (!choices(field.items)) throw new Error('Array fields need string choices');
    } else if (field.type === 'boolean') keys(field, ['type', ...annotations]);
    else if (['number','integer'].includes(field.type)) keys(field, ['type','minimum','maximum', ...annotations]);
    else throw new Error('Unsupported question field type');
  }
  return structuredClone(schema);
}
export function validateFormAnswer(schema, answer) {
  if (!object(answer) || Buffer.byteLength(JSON.stringify(answer)) > 32000) return false;
  if (Object.keys(answer).some(k => !Object.hasOwn(schema.properties, k))) return false;
  if ((schema.required ?? []).some(k => !Object.hasOwn(answer, k))) return false;
  for (const [key, value] of Object.entries(answer)) {
    const f = schema.properties[key];
    if (f.type === 'string') {
      if (typeof value !== 'string' || value.length < (f.minLength ?? 0) || value.length > (f.maxLength ?? 8000)) return false;
      const allowed = choices(f); if (allowed && !allowed.includes(value)) return false;
    } else if (f.type === 'array') {
      const allowed = choices(f.items);
      if (!Array.isArray(value) || value.length < (f.minItems ?? 0) || value.length > (f.maxItems ?? 100)
        || new Set(value).size !== value.length || value.some(v => !allowed.includes(v))) return false;
    } else if (f.type === 'boolean') { if (typeof value !== 'boolean') return false; }
    else if (typeof value !== 'number' || !Number.isFinite(value)
      || (f.type === 'integer' && !Number.isInteger(value)) || value < (f.minimum ?? -Infinity) || value > (f.maximum ?? Infinity)) return false;
  }
  return true;
}
export function matchesAnswer(pi, payload) {
  if (pi?.kind !== 'question' || pi.interactionId !== payload?.interactionId) return false;
  return pi.format === 'form'
    ? payload.optionId === undefined && validateFormAnswer(pi.schema, payload.answers)
    : payload.answers === undefined && pi.options?.some(o => o.optionId === payload.optionId);
}
