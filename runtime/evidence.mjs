// Journal reads retain a bounded prefix and a usable cursor. A single oversized
// event keeps its identity and truncation marker rather than an unbounded body.
export function boundWorkflowEvents(result, maxBytes) {
  const retained = [];
  let used = 256;
  const original = Array.isArray(result?.events) ? result.events : [];
  let truncated = false;
  for (const event of original) {
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (used + bytes > maxBytes) {
      truncated = true;
      if (!retained.length) retained.push({ sequence: event.sequence, type: event.type, truncated: true });
      break;
    }
    retained.push(event);
    used += bytes;
  }
  return { events: retained, hasMore: result?.hasMore === true || retained.length < original.length,
    truncated, nextAfterSequence: retained.at(-1)?.sequence ?? null };
}
