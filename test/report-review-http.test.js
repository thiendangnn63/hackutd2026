import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';
import {captureRawReport,runReportJob} from '../src/report-inbox.js';

async function fixture(t){
  const store=new Store(null),text='I saw Elena Brooks at Oak School. They need water for two people.';
  const captured=store.act(captureRawReport,{dataClass:'synthetic',provider:'fixture',projectId:'private-fixture-project',messageId:'one',senderId:'neighbor-1',caseId:'C104',text,observedAt:null});
  await runReportJob(store,{enabled:true,reportId:captured.reportId,extractor:async()=>({observations:[{type:'sighting',sourceSpan:'I saw Elena Brooks at Oak School',quantity:null,location:'Oak School'},{type:'water_need',sourceSpan:'They need water for two people',quantity:2,location:null}],reviewFlags:[]})});
  const app=createApp(store);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.closeAllConnections();app.close(resolve);}));
  const base='http://127.0.0.1:'+app.address().port;
  const request=(path,payload,origin=base)=>fetch(base+path,{method:payload===undefined?'GET':'POST',headers:payload===undefined?{}:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  const report=store.read().reports.find(item=>item.id===captured.reportId);
  const decision={action:'accept',reviewerName:'Officer Rivera (demo)',note:'Checked the exact source clauses against this fictional case.',expectedProposalToken:report.modelReview.proposalToken,observationIndices:[1]};
  return {store,request,report,path:'/api/reports/'+report.id+'/review',decision};
}

test('HTTP review exposes a public fingerprint, preserves source guards and commits only selected reported observations',async t=>{
  const f=await fixture(t),before=f.store.read(),publicBefore=await(await f.request('/api/state')).json();
  const visible=publicBefore.reports.find(item=>item.id===f.report.id).modelReview;
  assert.equal(visible.proposalToken,f.decision.expectedProposalToken);
  for(const forbidden of ['sourceHash','claimToken','providerIdentity','private-fixture-project'])assert.equal(JSON.stringify(publicBefore).includes(forbidden),false);
  assert.equal((await f.request(f.path,f.decision,null)).status,403);
  assert.equal((await f.request(f.path,{...f.decision,expectedProposalToken:'f'.repeat(64)})).status,409);
  assert.deepEqual(f.store.read(),before);
  let response=await f.request(f.path,f.decision);assert.equal(response.status,200);const accepted=await response.json();
  const report=accepted.reports.find(item=>item.id===f.report.id);
  assert.equal(report.modelReview.status,'accepted');assert.equal(report.modelReview.reviewDecision.action,'accepted');
  assert.equal(report.observations.length,1);assert.equal(report.observations[0].type,'water_need');assert.equal(report.observations[0].verification,'reported');
  assert.equal(accepted.cases[0].welfareState,'unknown');assert.deepEqual(accepted.assistance,[]);assert.deepEqual(accepted.outbox,[]);
  assert.equal(JSON.stringify(accepted).includes('sourceHash'),false);assert.equal(JSON.stringify(accepted).includes('private-fixture-project'),false);
  response=await f.request(f.path,f.decision);const duplicate=await response.json();assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.observationIds,accepted.observationIds);
  assert.equal((await f.request(f.path,{...f.decision,action:'dismiss'})).status,400); // indices are not dismissal input.
  assert.equal((await f.request(f.path,{action:'dismiss',reviewerName:f.decision.reviewerName,note:f.decision.note,expectedProposalToken:f.decision.expectedProposalToken})).status,409);
  const verify=await f.request('/api/cases/C104/verify',{officerName:'Officer Rivera (demo)',evidenceIds:[f.report.id],note:'A water request does not establish a sighting or direct welfare confirmation.',welfare:'confirmed_safe',resolve:true});
  assert.equal(verify.status,400);assert.equal(f.store.read().cases[0].welfareState,'unknown');
});

test('HTTP dismissal keeps the raw message and cannot accept injected review fields',async t=>{
  const f=await fixture(t),before=f.store.read();
  assert.equal((await f.request(f.path,{...f.decision,dispatch:true})).status,400);assert.deepEqual(f.store.read(),before);
  const response=await f.request(f.path,{action:'dismiss',reviewerName:f.decision.reviewerName,note:f.decision.note,expectedProposalToken:f.decision.expectedProposalToken});
  assert.equal(response.status,200);const result=await response.json(),report=result.reports.find(item=>item.id===f.report.id);
  assert.equal(report.modelReview.status,'dismissed');assert.equal(report.text,f.report.text);assert.deepEqual(report.observations,[]);
  assert.equal(report.modelReview.reviewDecision.reviewerName,'Officer Rivera (demo)');assert.deepEqual(result.assistance,[]);assert.deepEqual(result.outbox,[]);
  assert.deepEqual(result.cases,before.cases);
});
