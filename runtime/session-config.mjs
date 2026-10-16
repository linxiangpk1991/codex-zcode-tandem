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
import { modeMismatchError } from './acp-contract.mjs';

/**
 * Apply the three session options in a fixed order (model, mode, thought) and
 * return their effective values plus the final configOptions snapshot.
 */
export async function applySessionOptions(conn, sessionId, { provider, model, thought, mode }) {
  let configOptions = [];
  const applyAndVerify = async (configId, value) => {
    const result = await conn.setSessionConfigOption({ sessionId, configId, value });
    configOptions = result?.configOptions ?? [];
    const current = configOptions.find(o => o.id === configId)?.currentValue;
    if (current !== value) {
      throw new Error(configId === 'mode'
        ? modeMismatchError(value, current)
        : `${configId} selection mismatch: ${current}`);
    }
    return current;
  };
  const modelEffective = await applyAndVerify('model', `${provider}\\${model}`);
  const modeEffective = await applyAndVerify('mode', mode);
  const thoughtEffective = await applyAndVerify('thought', thought);
  return { modelEffective, modeEffective, thoughtEffective, configOptions };
}
