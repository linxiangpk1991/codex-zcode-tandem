// Live steering against the zcode-acp-server `_session/steering` extension
// (0.85.3), with the original foreground boundary queue kept as the explicit
// fallback. Upstream contract (handlers/steering.js, docs/PROTOCOL.md):
//   request  { sessionId, prompt: ContentBlock[],
//              _meta?: { steering?: { priority?: "now"|"next",
//                                      idleBehavior?: "promptRequired" } } }
//   reply    { outcome: "injected" } | { outcome: "queued" }
//            | { outcome: "startedNewTurn" }
//            | { outcome: "promptRequired", reason: "noRunningTurn" }
// The agent advertises the extension via InitializeResponse._meta.steering
// ({ supported: true, timings: ["now","next"] }). The v4 ack resolves at
// ADMISSION, not application: "injected" means the running turn took the
// text, never that the requested change is already implemented — completion
// follows the live turn's own settlement. A queued steer is only COMPLETE on
// its real `turn.steerDrained` event, correlated by the sha256 of the FULL
// text plus a one-time pendingInputId (the event may even precede the ack;
// duplicate identical steers never share one receipt). No event, no
// completion — the invocation then ends needs_attention after a bounded wait
// instead of guessing.
// "ask" commands never steer live: serialized foreground follow-up turns.
import { createHash } from 'node:crypto';

export const STEERING_METHOD = '_session/steering';
export const STEERING_TIMINGS = Object.freeze(['now', 'next']);
const RING_BOUND = 16;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Identity of a steer text: sha256 of the FULL text (the bridge hashes the
 *  full drained text before truncating its log copy — prefix never counts). */
export const sha256Text = text => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** Parse InitializeResponse._meta.steering into our negotiation record. */
export function steeringCapability(init) {
  const meta = init?._meta?.steering;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.supported !== true) {
    return { supported: false, timings: [] };
  }
  const timings = Array.isArray(meta.timings)
    ? meta.timings.filter(t => STEERING_TIMINGS.includes(t)) : [];
  return { supported: true, timings };
}

/**
 * The steering controller. Owns: negotiation, live-steer attempts with the
 * honest acknowledgement lifecycle (interface acceptance → outcome → event-
 * proven drain or turn settlement), the boundary queue, and bounded settling
 * before completion. Never sends session/prompt itself except through the
 * injected runPromptTurn boundary queue.
 */
export function createSteeringController({
  st, tracker, report, config, getTransport, runPromptTurn, recordTurn,
  writeResultEarly, terminal, delay, deadlineAt,
}) {
  let nativeDrainRunning = false;
  let liveInFlight = 0;
  let awaitingDrain = []; // entries the native side will deliver at a boundary
  const injectedByLabel = new Map(); // live-turn label → admitted entries
  const recentQueued = []; // turn.steerQueued ring (events may precede the ack)
  const recentDrained = []; // turn.steerDrained ring
  const consumedPendingInputIds = new Set(); // one-time receipts (bounded)

  function pushEvent(event) {
    const events = (report.steering ??= { negotiated: st.steeringSupport, events: [] }).events ??= [];
    events.push(event);
    if (events.length > 50) events.splice(0, events.length - 50);
  }

  function admit(entry, outcome) {
    st.steerRevision += 1;
    (st.steeringRequirements ??= []).push(entry.text);
    // A steer the agent took invalidates any existing first-pass review
    // immediately; later reviews see the text via steeringRequirements.
    if (report.firstPassReview) report.firstPassReview.invalidated = true;
    pushEvent({ id: entry.id, action: entry.action, priority: entry.timing ?? null,
      outcome, at: new Date().toISOString() });
  }

  function queueBoundary(entry, detail) {
    st.steers.push({ id: entry.id, action: entry.action, text: entry.text });
    tracker.recordControl(entry.id, entry.action, 'queued', detail);
  }

  function unknownOutcome(entry, why) {
    // The text may or may not have reached the agent. It is never replayed;
    // the requirement is recorded and the review invalidated defensively. The
    // STICKY unknownCount (not the bounded events log) refuses the handoff.
    admit(entry, 'unknown');
    const steering = report.steering ??= {};
    steering.unknownCount = (steering.unknownCount ?? 0) + 1;
    tracker.recordControl(entry.id, entry.action, 'unknown',
      `steering outcome unknown (${why}); not replayed; review invalidated defensively`);
    tracker.touch({ type: 'steering', outcome: 'unknown', id: entry.id });
  }

  /** Complete one drained entry with the real event's identity fields. */
  function completeDrained(entry, drained) {
    tracker.recordControl(entry.id, entry.action, 'completed',
      `drained (turn.steerDrained targetTurnId=${drained.targetTurnId || '?'} `
      + `pendingInputId=${drained.pendingInputId || entry.pendingInputId || '?'} `
      + `textSha256=${entry.textSha256.slice(0, 12)})`);
    pushEvent({ id: entry.id, action: entry.action, priority: entry.timing ?? null,
      outcome: 'drained', at: new Date().toISOString() });
  }

  /**
   * Complete awaitingDrain entries from one drained event, strictly one-to-
   * one: identity is the FULL-text sha256, and each drained pendingInputId is
   * a one-time receipt — duplicate pending requests never share an event.
   */
  function applyDrained(payload) {
    const drainedInputs = Array.isArray(payload?.drainedInputs) ? payload.drainedInputs : [];
    for (const d of drainedInputs) {
      if (!d || typeof d.textSha256 !== 'string' || !SHA256_RE.test(d.textSha256)) continue;
      const pid = d.pendingInputId;
      if (typeof pid !== 'string' || !pid || consumedPendingInputIds.has(pid)) continue;
      const index = awaitingDrain.findIndex(e => e.textSha256 === d.textSha256
        && (!e.pendingInputId || !pid || e.pendingInputId === pid));
      if (index < 0) continue;
      const entry = awaitingDrain.splice(index, 1)[0];
      if (pid) {
        consumedPendingInputIds.add(pid);
        if (consumedPendingInputIds.size > 200) {
          consumedPendingInputIds.delete(consumedPendingInputIds.keys().next().value);
        }
      }
      entry.pendingInputId = entry.pendingInputId ?? pid;
      completeDrained(entry, { targetTurnId: payload?.targetTurnId, pendingInputId: pid });
    }
  }

  /** Bind a queued ack to a steerQueued event that may have arrived first.
   *  inputPreview may be truncated upstream, so only an EXACT full-text
   *  equality binds the pendingInputId hint — never a prefix. */
  function bindQueuedEvent(entry) {
    const hit = recentQueued.find(q => !q.bound && q.inputPreview === entry.text);
    if (!hit) return;
    hit.bound = true;
    entry.pendingInputId = entry.pendingInputId ?? hit.pendingInputId;
    entry.targetTurnId = hit.targetTurnId;
  }

  /** A drain may already have happened before the ack resolved. */
  function settleFromRecentDrained(entry) {
    for (const event of recentDrained) applyDrained(event.payload);
    return !awaitingDrain.includes(entry);
  }

  async function attemptLiveSteer(entry, timing) {
    const targetTurn = st.activeTurn;
    liveInFlight += 1;
    let reply = null;
    try {
      const request = Promise.resolve(getTransport().conn.request(STEERING_METHOD, {
        sessionId: st.sessionId,
        prompt: [{ type: 'text', text: entry.text }],
        _meta: { steering: { priority: timing } },
      }));
      // The race only bounds how long we WAIT for the acknowledgement; the
      // underlying request is left running, which is exactly why an expired
      // one must never be replayed.
      reply = await Promise.race([request, delay(config.steerAckTimeoutMs)
        .then(() => { throw new Error(`no acknowledgement within ${config.steerAckTimeoutMs}ms`); })]);
    } catch (e) {
      liveInFlight -= 1;
      return unknownOutcome(entry, e?.message ?? String(e));
    }
    liveInFlight -= 1;
    const outcome = reply?.outcome;
    if (outcome === 'injected' || outcome === 'queued' || outcome === 'startedNewTurn') {
      admit(entry, outcome);
      if (outcome === 'injected' && targetTurn && st.activeTurn === targetTurn) {
        (targetTurn.steerEntries ??= []).push(entry);
        const list = injectedByLabel.get(targetTurn.label) ?? [];
        list.push(entry);
        injectedByLabel.set(targetTurn.label, list);
        tracker.recordControl(entry.id, entry.action, 'started',
          'steering outcome: injected into the running turn (admission ack; application completes with the turn)');
      } else {
        // queued: drains at the next boundary, proven by turn.steerDrained.
        // startedNewTurn: the idle race was lost at admission and the backend
        // already owns a turn for the text. An "injected" whose target turn
        // already settled locally is raced here too: nothing will observe
        // that turn again, so drain events complete it instead.
        awaitingDrain.push(entry);
        bindQueuedEvent(entry);
        tracker.recordControl(entry.id, entry.action, 'started', outcome === 'queued'
          ? 'steering outcome: queued behind the running turn (completes on turn.steerDrained)'
          : 'steering outcome: startedNewTurn (the backend started a turn from the steer text)');
        settleFromRecentDrained(entry);
      }
      tracker.touch({ type: 'steering', outcome, id: entry.id, priority: timing });
      return;
    }
    if (outcome === 'promptRequired') {
      queueBoundary(entry, `steering reply promptRequired (${reply.reason ?? 'noRunningTurn'}); queued for the next foreground boundary`);
      tracker.touch({ type: 'steering', outcome: 'promptRequired', id: entry.id });
      return;
    }
    unknownOutcome(entry, `unexpected steering reply: ${JSON.stringify(reply).slice(0, 200)}`);
  }

  const controller = {
    negotiate(init) {
      st.steeringSupport = steeringCapability(init);
      report.steering = {
        negotiated: st.steeringSupport,
        mode: st.steeringSupport.supported ? STEERING_METHOD : 'foreground boundary queue',
        boundary: 'Acknowledgements resolve at admission: "injected" means the running turn took the text, not that the change is implemented. Queued steers complete only on their real turn.steerDrained event (full-text sha256, one-time pendingInputId); an unknown outcome refuses a ready handoff; timed-out steers are never replayed.',
        unknownCount: 0,
        events: [],
      };
      return st.steeringSupport;
    },

    /**
     * Slim turn.steerQueued / turn.steerDrained events forwarded by the
     * bridge guard from the backend's `session/event` notifications, already
     * mapped from the native sid to this client's ACP aliases. An event whose
     * alias list is present and excludes our session is foreign — ignored.
     */
    onSteerEvent(message = {}) {
      const { kind, payload } = message;
      if (Array.isArray(message.acpSessionIds) && !message.acpSessionIds.includes(st.sessionId)) {
        return; // backend event for another conversation
      }
      if (kind === 'steerQueued') {
        recentQueued.push({ inputPreview: payload?.inputPreview ?? '',
          pendingInputId: payload?.pendingInputId ?? '', targetTurnId: payload?.targetTurnId ?? '' });
        if (recentQueued.length > RING_BOUND) recentQueued.splice(0, recentQueued.length - RING_BOUND);
        for (const entry of awaitingDrain) if (!entry.pendingInputId) bindQueuedEvent(entry);
        return;
      }
      if (kind === 'steerDrained') {
        recentDrained.push({ payload });
        if (recentDrained.length > RING_BOUND) recentDrained.splice(0, recentDrained.length - RING_BOUND);
        applyDrained(payload);
      }
    },

    dispatch(cmd) {
      const text = cmd.payload.message;
      if (cmd.action === 'ask') {
        // Serial follow-up semantics: ask is a question the model must answer
        // in a turn of its own; it never injects into a running turn.
        return queueBoundary({ id: cmd.id, action: cmd.action, text },
          'ask stays serialized: queued as the next foreground follow-up turn');
      }
      const wanted = STEERING_TIMINGS.includes(cmd.payload.priority) ? cmd.payload.priority : 'now';
      const entry = { id: cmd.id, action: cmd.action, text, timing: wanted,
        textSha256: sha256Text(text) };
      if (!st.steeringSupport.supported) {
        return queueBoundary(entry, 'steering extension not negotiated; queued for the next foreground boundary');
      }
      if (!st.steeringSupport.timings.includes(wanted)) {
        return queueBoundary(entry, `priority ${wanted} not advertised by the agent; queued for the next foreground boundary`);
      }
      if (!st.promptInFlight || !st.activeTurn) {
        // No foreground turn is running here, so the bridge would only answer
        // promptRequired; queue without spending the round trip.
        return queueBoundary(entry, 'no foreground turn is running; queued for the next foreground boundary');
      }
      void attemptLiveSteer(entry, wanted);
    },

    /** The original serialized boundary queue (steer/ask run as full turns). */
    async drain() {
      while (st.steers.length > 0 && !terminal() && !st.needsAttention) {
        const steer = st.steers.shift();
        st.steerRevision += 1;
        (st.steeringRequirements ??= []).push(steer.text);
        if (report.firstPassReview) report.firstPassReview.invalidated = true;
        pushEvent({ id: steer.id, action: steer.action, priority: null,
          outcome: 'boundary-turn', at: new Date().toISOString() });
        const label = `steer:${steer.id.slice(-8)}`;
        tracker.setPhase(tracker.state.phase.index, label);
        tracker.recordControl(steer.id, steer.action, 'started');
        try {
          const result = await runPromptTurn({ label, text: steer.text });
          recordTurn(label, result);
          writeResultEarly();
          if (result.stopReason === 'end_turn' && !st.needsAttention) {
            tracker.recordControl(steer.id, steer.action, 'completed', `turn ended end_turn (${result.chars} chars)`);
          } else if (!st.pausing) {
            tracker.recordControl(steer.id, steer.action, 'rejected', `turn ended ${result.stopReason}`);
          } else {
            tracker.recordControl(steer.id, steer.action, 'rejected', `paused mid-turn (${result.stopReason})`);
          }
        } catch (e) {
          if (st.finalized) return;
          if (st.pausing) {
            tracker.recordControl(steer.id, steer.action, 'rejected', `paused: ${e.message}`);
          } else {
            tracker.recordControl(steer.id, steer.action, 'rejected', e.message);
            throw e;
          }
        }
      }
    },

    /**
     * Gate before every foreground session/prompt: an in-flight steering
     * round trip or an observed native drain turn must settle first. Bounded
     * by the invocation deadline; the backend's prompt lock serializes
     * regardless, but we do not initiate an overlapping prompt ourselves.
     */
    async awaitTurnGate() {
      while ((nativeDrainRunning || liveInFlight > 0) && !terminal() && Date.now() < deadlineAt) {
        await delay(150);
      }
    },

    /**
     * Bounded settling before 'completed': every live attempt must have
     * resolved and every queued steer must be PROVEN drained by its real
     * turn.steerDrained event. Without the event we refuse to certify —
     * the caller ends needs_attention with the returned reason; we never
     * wait unboundedly and never fabricate a drain.
     */
    async settleBeforeCompletion(boundMs) {
      const limit = Math.min(Date.now() + boundMs, deadlineAt);
      while ((liveInFlight > 0 || awaitingDrain.length > 0 || nativeDrainRunning || st.nativeActiveTurns?.size > 0)
        && !terminal() && Date.now() < limit) {
        await delay(150);
      }
      if (awaitingDrain.length > 0) {
        return { ok: false,
          reason: `${awaitingDrain.length} queued steer(s) were never observed drained (no turn.steerDrained event); cannot certify completion` };
      }
      if (liveInFlight > 0) {
        return { ok: false, reason: 'a live steering attempt did not settle within the bounded drain window' };
      }
      if (nativeDrainRunning || st.nativeActiveTurns?.size > 0) {
        return { ok: false, reason: 'native turn is still running; drained input is not completed work' };
      }
      return { ok: true };
    },

    /**
     * Persistent record of unsettled steering at close — pending native
     * inputs and in-flight admissions never silently disappear: they land in
     * the report even when the run ends paused/failed/needs_attention.
     */
    pendingAtClose() {
      if (liveInFlight <= 0 && awaitingDrain.length === 0) return null;
      return {
        liveInFlight,
        awaitingDrain: awaitingDrain.map(e => ({
          id: e.id, textSha256: e.textSha256, pendingInputId: e.pendingInputId ?? null,
        })),
      };
    },

    /** Turn-state notification (upstream's own _zcode/turnState). */
    noteTurnState(running) {
      if (typeof running !== 'boolean' || st.activeTurn) return;
      if (running) {
        if (awaitingDrain.length > 0 && !nativeDrainRunning) {
          nativeDrainRunning = true;
          st.steerDrainActive = true;
        }
        return;
      }
      // Only the gate hint and chunk routing reset here; completion of queued
      // steers is proven exclusively by turn.steerDrained events.
      nativeDrainRunning = false;
      st.steerDrainActive = false;
    },

    /** Called from the turn runner when a foreground turn settles. */
    onForegroundTurnSettled({ label, stopReason, chars, ok }) {
      for (const entry of injectedByLabel.get(label) ?? []) {
        tracker.recordControl(entry.id, entry.action, ok ? 'completed' : 'rejected', ok
          ? `injected; live turn ended ${stopReason ?? 'end_turn'} (${chars} chars)`
          : `injected, but the live turn ended ${stopReason ?? 'incomplete'}; effect uncertain`);
        pushEvent({ id: entry.id, action: entry.action, priority: entry.timing ?? null,
          outcome: ok ? 'settled' : 'turn-lost', at: new Date().toISOString() });
      }
      injectedByLabel.delete(label);
    },
  };
  return controller;
}
