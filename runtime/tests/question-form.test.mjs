import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAskUserElicitationForm, parseAskUserElicitationResponse } from 'zcode-acp-server/dist/interaction/adapter.js';
import { normalizeFormSchema, validateFormAnswer, matchesAnswer } from '../question-form.mjs';
import { createInteractions } from '../interactions.mjs';
import { validateControlPayload } from '../inbox.mjs';
import { validateControlContext } from '../control.mjs';

const questions = [{question:'Platform',options:[{label:'Windows'},{label:'Mac'}]},
  {question:'Formats',multiSelect:true,options:[{label:'JSON'},{label:'Markdown'}]}];
const form = buildAskUserElicitationForm({questions}, 's1', 'tool1');
const schema = normalizeFormSchema(form.requestedSchema);
const answers = {q_0:'Windows',q_1:['JSON','Markdown'],q_0_other:'',q_1_other:''};
test('actual upstream form preserves multiple selections and free text', () => {
  assert.equal(validateFormAnswer(schema, answers), true);
  assert.deepEqual(parseAskUserElicitationResponse({action:'accept',content:answers},{questions}),
    {Platform:'Windows',Formats:'JSON, Markdown'});
  for (const value of [{q_0:'Linux'},{q_1:['JSON','JSON']},{q_1:'JSON'},{unexpected:'Windows'}]) assert.equal(validateFormAnswer(schema,value),false);
  assert.throws(() => normalizeFormSchema({...schema,additionalProperties:true}), /Unsupported/);
  assert.throws(() => normalizeFormSchema({type:'object',properties:{a:{type:'object'}}}), /Unsupported/);
});

function harness() {
  const state = {pendingInput:null};
  const st = {sessionId:'s1',answers:new Map(),trackedToolCalls:new Map([
    ['tool1',{_meta:{claudeCode:{toolName:'AskUserQuestion'}}}],
    ['plan1',{_meta:{claudeCode:{toolName:'ExitPlanMode'}}}],
  ])};
  const controls = [];
  const tracker = {state,setPendingInput: pi => {state.pendingInput=pi;},recordControl:(...a)=>controls.push(a)};
  const interactions = createInteractions({st,tracker,report:{},config:{},request:{},warn:()=>{},deadlineAt:Date.now()+2000,
    delay:()=>new Promise(resolve=>setTimeout(resolve,5))});
  return {st,tracker,controls,...interactions};
}
test('form lifecycle accepts only its current ordinary question and valid answer', async () => {
  const h=harness(); const pending=h.handleElicitation(form); const pi=h.tracker.state.pendingInput;
  assert.equal(pi.format,'form');
  const payload={interactionId:pi.interactionId,answers};
  assert.equal(validateControlPayload('answer',payload).ok,true);
  assert.equal(validateControlPayload('answer',{...payload,optionId:'allow'}).ok,false);
  assert.equal(matchesAnswer(pi,{...payload,interactionId:'stale'}),false);
  const progress={version:3,invocationId:'run1',status:'needs_input',controller:{pid:1},controlInbox:process.cwd(),pendingInput:pi};
  assert.equal(validateControlContext(progress,'answer',payload,{isAlive:()=>true}).ok,true);
  h.st.answers.set(pi.interactionId,{...payload,commandId:'cmd1'});
  assert.deepEqual(await pending,{action:'accept',content:answers});
  assert.equal(h.tracker.state.pendingInput,null);
  assert.equal(h.controls.at(-1)[2],'completed');
});
test('foreign sessions, plan approvals and URL requests never enter ordinary answer', async () => {
  for (const params of [{...form,sessionId:'foreign'},{...form,toolCallId:'plan1'},{...form,mode:'url'}]) {
    const h=harness(); assert.deepEqual(await h.handleElicitation(params),{action:'decline'});
    assert.equal(h.st.needsAttention,true); assert.equal(h.tracker.state.pendingInput,null);
  }
});
test('pause cancels an unanswered form without inventing a choice', async () => {
  const h=harness(); const p=h.handleElicitation(form); h.st.pausing=true;
  assert.deepEqual(await p,{action:'cancel'}); assert.equal(h.controls.length,0);
});
