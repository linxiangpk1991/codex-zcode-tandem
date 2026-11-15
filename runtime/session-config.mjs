// session-config.mjs — apply model/mode/thought to the ACP session with
// strict effective-value readback. Extracted from runner.mjs (V3.5) so the
// guarded fallback detection has a single owner and the runner stops growing.
//
// Every option is applied via session/set_config_option and then read back
// from the server's rebuilt configOptions (upstream reads session/read
// settings, i.e. the real current value). Any divergence between requested
// and effective value fails the invocation — for `guarded` specifically the
// message names the silent upstream create fallback, because a mode the
// controller did not ask for is a policy change, not a display glitch.
//
// The ONE readback exception is the model id: zcode-acp-server 0.85.3
// resolves the controller-pinned bundled provider through its own registry
// (config/account-provider.js accountProviderIdFor + config/runtime-model.js
// parseModelValue — the configOption value is `providerId\modelId`), so the
// native readback spells the SAME individual Coding Plan as
// `account:bigmodel-individual-coding-plan\GLM-5.3`. That single frozen
// alias pair is accepted with the model id still compared in full; every
// other provider spelling (other accounts, start-plan, any `account:*` we
// did not pin, Flash or any other model) remains a hard mismatch. The
// effective value recorded in the report is always the NATIVE string.
import { modeMismatchError } from './acp-contract.mjs';

/** The bundled provider id this runtime pins (config.mjs provider invariant). */
const BUILTIN_PROVIDER = 'builtin:bigmodel-coding-plan';
/** Its exact upstream registry alias for the individual Coding Plan. */
const ACCOUNT_ALIAS_PROVIDER = 'account:bigmodel-individual-coding-plan';

/**
 * Strict model readback acceptance: the exact requested `provider\model`, or
 * the one upstream-defined alias pair with an IDENTICAL full model id.
 * Deliberately not generalized — no arbitrary `account:` prefix, no model
 * substitution (Flash or anything else), no other plan spelling.
 */
export function modelSelectionMatches(provider, model, current) {
  if (typeof current !== 'string') return false;
  if (current === `${provider}\\${model}`) return true;
  return provider === BUILTIN_PROVIDER
    && current === `${ACCOUNT_ALIAS_PROVIDER}\\${model}`;
}

/**
 * Apply the three session options in a fixed order (model, mode, thought) and
 * return their effective values plus the final configOptions snapshot.
 */
export async function applySessionOptions(conn, sessionId, { provider, model, thought, mode }) {
  let configOptions = [];
  const applyAndVerify = async (configId, value, accepted) => {
    const result = await conn.setSessionConfigOption({ sessionId, configId, value });
    configOptions = result?.configOptions ?? [];
    const current = configOptions.find(o => o.id === configId)?.currentValue;
    if (!accepted(current)) {
      throw new Error(configId === 'mode'
        ? modeMismatchError(value, current)
        : `${configId} selection mismatch: requested ${value}, effective ${current}`);
    }
    return current;
  };
  const modelEffective = await applyAndVerify('model', `${provider}\\${model}`,
    current => modelSelectionMatches(provider, model, current));
  const modeEffective = await applyAndVerify('mode', mode, current => current === mode);
  const thoughtEffective = await applyAndVerify('thought', thought, current => current === thought);
  return { modelEffective, modeEffective, thoughtEffective, configOptions };
}
