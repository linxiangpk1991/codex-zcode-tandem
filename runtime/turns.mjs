// Prompt lifecycle, including failed and cancelled calls. Kept separate from
// orchestration so metrics and visible turns share exactly one lifecycle.
import { assertNativeOutcome } from './native-outcome.mjs';
export function createTurnRunner({ st, tracker, report, request, config, metrics, getTransport }) {
  function recordTurn(label, result) {
    const text = result.text ?? '';
    st.response = (st.response + text).slice(-request.maxOutputBytes);
    if (st.response.length >= request.maxOutputBytes) {
      report.responseTruncated = true;
      tracker.flagEvidence('responseTruncated');
    }
    const entry = { label, stopReason: result.stopReason ?? null, chars: result.chars ?? text.length,
      preview: text.slice(0, 2000), previewTruncated: text.length > 2000, truncated: text.length > 2000,
      metrics: result.metrics };
    tracker.addTurn(entry);
    report.turns.push(entry);
    if (report.turns.length > config.maxTurns) {
      report.turns.shift();
      tracker.flagEvidence('turnsTruncated');
    }
  }
  async function runPromptTurn({ label, text, phase = 'other' }) {
    await st.beforeForegroundTurn?.(); // steering gate: no overlapping session/prompt
    st.promptInFlight = true;
    const measured = metrics.begin(label, phase);
    const turn = st.activeTurn = { label, text: '', chars: 0, metricsId: measured.id };
    tracker.state.metrics = metrics.snapshot(report.firstPassReview);
    tracker.setCurrentTurn({ label, phase, chars: 0 });
    tracker.touch({ type: 'turn_started', label });
    let stopReason = null;
    try {
      const promise = getTransport().conn.prompt({ sessionId: st.sessionId, prompt: [{ type: 'text', text }] });
      st.promptPromise = promise;
      const response = await promise;
      await st.flushNativeEvents?.();
      if (st.finalized) throw new Error('Prompt settled after finalization');
      assertNativeOutcome(turn);
      stopReason = st.lastStopReason = response.stopReason ?? null;
      const measuredTurn = metrics.finish(measured.id, response);
      return { ...response, text: turn.text, chars: turn.chars, metrics: measuredTurn };
    } catch (error) {
      const measuredTurn = metrics.finish(measured.id, null,
        st.pausing || st.interrupting ? 'interrupted' : 'failed');
      if (measuredTurn) recordTurn(label, { text: turn.text, chars: turn.chars, metrics: measuredTurn });
      throw error;
    } finally {
      st.promptPromise = null;
      st.promptInFlight = false;
      st.activeTurn = null;
      // Steered/queued controls settle against the turn that owned them.
      st.onForegroundTurnSettled?.({ label, stopReason, chars: turn.chars, ok: stopReason === 'end_turn' });
      if (!st.finalized) {
        tracker.state.metrics = metrics.snapshot(report.firstPassReview);
        tracker.setCurrentTurn(null);
        tracker.touch({ type: 'turn_finished', label, stopReason, chars: turn.chars });
      }
    }
  }
  function interruptTurn() {
    const turn = st.activeTurn;
    if (!turn) return;
    const measuredTurn = metrics.finish(turn.metricsId, null, 'interrupted');
    if (measuredTurn) recordTurn(turn.label, { text: turn.text, chars: turn.chars, metrics: measuredTurn });
    tracker.setCurrentTurn(null);
  }
  return { runPromptTurn, recordTurn, interruptTurn };
}
