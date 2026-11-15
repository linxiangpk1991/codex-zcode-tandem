// ACP 0.85.3 can return end_turn after exhausting failed model retries.
// Observe the native turn outcome, rather than interpreting assistant text.
export function observeNativeOutcome(st, event) {
  if (!event.acpSessionIds?.includes(st.sessionId) || !event.turnId) return;
  const active = st.nativeActiveTurns ??= new Set();
  if (event.kind === 'started') active.add(event.turnId);
  else active.delete(event.turnId);
  const turn = st.activeTurn;
  if (!turn) {
    if (event.kind === 'failed' && st.steeringRequirements?.length) st.needsAttention = true;
    return;
  }
  if (event.kind === 'started') {
    if (event.inputSource === 'background_task') return;
    if (!turn.nativeTurnId || turn.nativeSettled) {
      turn.nativeTurnId = event.turnId;
      turn.nativeSettled = false;
    }
    return;
  }
  if (event.turnId !== turn.nativeTurnId) return;
  turn.nativeSettled = true;
  turn.nativeFailure = event.kind === 'failed' || event.resultType === 'error'
    ? (event.errorCode || 'native_turn_failed') : null;
}

export function assertNativeOutcome(turn) {
  if (turn.nativeFailure) throw new Error(`Native model turn failed (${turn.nativeFailure}); ACP end_turn is not successful execution`);
}
