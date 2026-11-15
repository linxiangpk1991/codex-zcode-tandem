// Optional migration mode for installations that already use the legacy
// Coding Plan key. Desktop OAuth remains the default. No fallback, key copy,
// credential write, provider switch, or secret in the process environment.
import { readFileSync } from 'node:fs';

export function existingCodingPlanResponder(file) {
  return (backend, req) => {
    if (req.method !== 'interaction/requestProviderRuntimeHeaders') return false;
    const provider = req.params?.modelSelection?.providerId ?? req.params?.providerId;
    if (!['account:bigmodel-individual-coding-plan', 'builtin:bigmodel-coding-plan'].includes(provider)) {
      backend.sendReply(req.id, { headersApplied: false, errorMessage: 'Configured Coding Plan credential requires an exact provider identity' });
      return true;
    }
    let key;
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
        .provider?.['builtin:bigmodel-coding-plan'];
      if (entry?.enabled === true && typeof entry.options?.apiKey === 'string') key = entry.options.apiKey.trim();
    } catch { /* report a fixed message only */ }
    backend.sendReply(req.id, key
      ? { headersApplied: true, requestAuth: { apiKey: key } }
      : { headersApplied: false, errorMessage: 'The explicitly selected existing Coding Plan key is unavailable; no fallback attempted' });
    return true;
  };
}
