import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeNativeOutcome,assertNativeOutcome} from '../native-outcome.mjs';
test('failed native turn cannot become a pass through ACP end_turn; a genuine successful retry can',()=>{
  const st={sessionId:'s1',activeTurn:{}};
  const emit=(kind,turnId,extra={})=>observeNativeOutcome(st,{kind,turnId,acpSessionIds:['s1'],...extra});
  emit('started','a'); emit('failed','a');
  assert.equal(st.nativeActiveTurns.size,0);
  assert.throws(()=>assertNativeOutcome(st.activeTurn),/Native model turn failed/);
  emit('completed','other');
  assert.throws(()=>assertNativeOutcome(st.activeTurn),/failed/);
  emit('started','b');emit('completed','b');assert.doesNotThrow(()=>assertNativeOutcome(st.activeTurn));
  emit('failed','b',{acpSessionIds:['foreign']});assert.doesNotThrow(()=>assertNativeOutcome(st.activeTurn));
});
test('a backend-owned steer stays active until its terminal event and failure stays visible',()=>{
  const st={sessionId:'s1',activeTurn:null,steeringRequirements:['correct the input']};
  observeNativeOutcome(st,{kind:'started',turnId:'steer1',acpSessionIds:['s1']});
  assert.equal(st.nativeActiveTurns.size,1);
  observeNativeOutcome(st,{kind:'failed',turnId:'steer1',acpSessionIds:['s1']});
  assert.equal(st.nativeActiveTurns.size,0);assert.equal(st.needsAttention,true);
});
