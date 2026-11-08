import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {captureRawReport, claimReportJob, completeReportJob, acceptReportProposal, dismissReportProposal, trackReportedAssistance} from '../src/report-inbox.js';

function fixture(action = 'accept') {
  const store = new Store();
  const text = 'I saw Elena at Oak School. They need water for two people.';
  const {reportId} = store.act(captureRawReport, {dataClass:'synthetic', provider:'fixture', projectId:'local',
    messageId:'water-report', senderId:'neighbor-1', caseId:'C104', text});
  const claim = store.act(claimReportJob, {reportId});
  const proposal = {observations:[
    {type:'sighting', sourceSpan:'I saw Elena at Oak School', quantity:null, location:'Oak School'},
    {type:'water_need', sourceSpan:'They need water for two people', quantity:2, location:null},
  ], reviewFlags:[]};
  assert.equal(store.act(completeReportJob, {...claim, proposal}).status, 'proposal_ready');
  const getReport = () => store.read().reports.find(item => item.id === reportId);
  const decision = {reportId, reviewerName:'Demo reviewer', note:'Checked the source wording.',
    expectedProposalToken:getReport().modelReview.proposalToken};
  if (action === 'accept') store.act(acceptReportProposal, {...decision, observationIndices:[1]});
  if (action === 'dismiss') store.act(dismissReportProposal, decision);
  const observationId = getReport().observations[0]?.id ?? 'O-absent';
  return {store, input:{reportId, observationId, reviewerName:'Demo officer', note:'Track this water request.'}};
}
test('only explicit tracking creates one source-linked water task and never changes case or outreach', () => {
  const {store,input} = fixture();
  store.act(state => {state.cases[0].reviewState='resolved';state.cases[0].welfareState='confirmed_safe';});
  const before = store.read();
  assert.equal(before.assistance.length,0);
  const first = store.act(trackReportedAssistance,input);
  const after = store.read();
  const [task] = after.assistance;
  assert.equal(first.taskId,task.id);assert.equal(first.status,'unassigned');assert.equal(first.duplicate,false);
  assert.equal(task.observationId,input.observationId);assert.equal(task.reportId,input.reportId);
  assert.equal(task.reviewerName,input.reviewerName);assert.equal(task.note,input.note);
  assert.equal(after.audit.length,before.audit.length+1);
  for (const field of ['cases','reports','participants','outbox']) assert.deepEqual(after[field],before[field]);
  const retry = store.act(trackReportedAssistance,input);
  assert.equal(retry.taskId,first.taskId);assert.equal(retry.duplicate,true);
  assert.deepEqual(store.read(),after);
});
test('a legacy water task is reused even if completed and lacks an observation ID',()=>{
  const {store,input} = fixture();
  store.act(state => {
    const report=state.reports.find(item=>item.id===input.reportId);
    state.assistance.push({id:'T-existing',caseId:report.caseId,reportId:report.id,type:'water_need',
      summary:report.observations[0].summary,status:'completed'});
  });
  const before=store.read(), result=store.act(trackReportedAssistance,input);
  assert.equal(result.taskId,'T-existing');assert.equal(result.status,'completed');assert.equal(result.duplicate,true);
  assert.deepEqual(store.read(),before);
});
for (const action of ['pending','dismiss']) test('cannot track '+action+' proposal',()=>{
  const {store,input}=fixture(action), before=store.read();
  assert.throws(()=>store.act(trackReportedAssistance,input),error=>error.code==='review_unavailable');
  assert.deepEqual(store.read(),before);
});
for (const [name,change] of [
  ['raw source changed',r=>{r.text+=' Correction.';}],
  ['accepted token changed',r=>{r.modelReview.reviewDecision.proposalToken='0'.repeat(64);}],
  ['accepted indices changed',r=>{r.modelReview.reviewDecision.observationIndices=[0];}],
  ['published observation edited',r=>{r.observations[0].quantity=99;}],
  ['unaccepted sighting injected',r=>{r.observations[0].type='sighting';}],
  ['source case missing',(_r,s)=>{s.cases=[];}],
]) test(name+' prevents tracking',()=>{
  const {store,input}=fixture();
  store.act(s=>{change(s.reports.find(item=>item.id===input.reportId),s);});
  const before=store.read();
  assert.throws(()=>store.act(trackReportedAssistance,input));
  assert.deepEqual(store.read(),before);
});
test('rejects unknown observation, empty officer note and client-supplied task status',()=>{
  const {store,input}=fixture(),before=store.read();
  for (const edit of [{observationId:'O-wrong'}, {note:' '}, {status:'completed'}]) {
    assert.throws(()=>store.act(trackReportedAssistance,{...input,...edit}));
    assert.deepEqual(store.read(),before);
  }
});
