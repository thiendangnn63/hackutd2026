import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';
import {ProviderLedger} from '../src/provider-ledger.js';
import {createRehearsalRuntime,REHEARSAL_TEXT,REHEARSAL_REPLY} from '../src/rehearsal.js';
import {caseEvents} from '../public/records.js';
import {publicState} from '../src/public-state.js';

async function server(t,{rehearsal=true,maxInterpretations=100}={}){
  const dir=mkdtempSync(join(tmpdir(),'beacon-rehearsal-http-')),statePath=join(dir,'state.json'),ledgerPath=join(dir,'rehearsal.json');
  const store=new Store(statePath),ledger=new ProviderLedger(ledgerPath),phone=rehearsal?createRehearsalRuntime({store,ledger,maxInterpretations}):null;
  const app=createApp(store,undefined,undefined,{phone}),sockets=new Set();app.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{await phone?.shutdown();await new Promise(resolve=>{for(const socket of sockets)socket.destroy();app.close(resolve);});rmSync(dir,{recursive:true,force:true});});
  const port=app.address().port,origin=`http://127.0.0.1:${port}`;
  const call=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers:{...(method==='POST'?{origin,'content-type':'application/json'}:{}),...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=null;}resolve({status:res.statusCode,data,text,headers:res.headers});});
    });req.on('error',reject);if(body!==undefined)req.write(typeof body==='string'?body:JSON.stringify(body));req.end();
  });
  const simulate=(text=REHEARSAL_TEXT,scenario='message')=>call('/api/phone/simulate',{method:'POST',body:{text,scenario}});
  return {store,ledger,phone,call,simulate,statePath,ledgerPath};
}
const family=state=>({cases:state.cases,participants:state.participants,assistance:state.assistance,outbox:state.outbox});

test('rehearsal status handshakes with the UI contract and simulate produces an honest unaccepted local proposal',async t=>{
  const system=await server(t),before=family(system.store.read()),status=await system.call('/api/phone/status');
  assert.equal(status.status,200);assert.equal(status.data.mode,'rehearsal');assert.equal(status.data.extractorSource,'local_demo_rules');
  assert.equal(status.data.endsAt,null);assert.equal(status.data.modelUsed,0);assert.equal(status.data.modelLimit,100);
  assert.equal(status.data.canSimulate,true);assert.equal(status.data.canReset,true);assert.deepEqual(status.data.eligibleReportIds,[]);
  assert.deepEqual((await system.call('/api/health')).data,{ok:true,mode:'simulation',liveSendingEnabled:false});
  const response=await system.simulate();assert.equal(response.status,200);assert.equal(response.data.phoneAction.simulated,true);
  const id=response.data.phoneAction.reportId,report=response.data.reports.find(report=>report.id===id);
  assert.equal(report.caseId,'C104');assert.equal(report.senderId,'neighbor-1');assert.equal(report.text,REHEARSAL_TEXT);
  assert.equal(report.observedAt,null);assert.equal(report.modelReview.status,'proposal_ready');assert.equal(report.modelReview.extractorSource,'local_demo_rules');
  assert.equal(report.modelReview.proposal.processingPath,'local_demo_rules');assert.equal(report.modelReview.proposal.requiresReview,true);assert.deepEqual(report.observations,[]);
  assert.deepEqual(report.modelReview.proposal.observations.map(observation=>observation.type),['sighting','water_need','road_blockage']);
  assert.equal(response.data.phone.modelUsed,1);assert.deepEqual(response.data.phone.eligibleReportIds,[id]);assert.equal(response.data.phone.rehearsalInputText,REHEARSAL_TEXT);
  assert.deepEqual(family(system.store.read()),before);assert.deepEqual(new Store(system.statePath).read(),system.store.read());
  const persisted=JSON.parse(readFileSync(system.ledgerPath,'utf8'));assert.equal(persisted.rehearsal.interpretations,1);assert.deepEqual(persisted.receipts,{});assert.deepEqual(persisted.identities,[]);
  assert.doesNotMatch(response.text,/"providerIdentity"|"claimToken"|"sourceHash"|"sourceSnapshot"|"idempotencyKey"|nvidia_nemotron/);
});

test('replaying reuses the exact message/report identity and does not interpret twice or overwrite source text',async t=>{
  const system=await server(t),first=await system.simulate(),id=first.data.phoneAction.reportId,before=system.store.read();
  const duplicate=await system.simulate('This edited draft must not replace the replayed source.','duplicate');
  assert.equal(duplicate.status,200);assert.equal(duplicate.data.phoneAction.duplicate,true);assert.equal(duplicate.data.phoneAction.reportId,id);
  assert.equal(duplicate.data.phone.modelUsed,1);assert.equal(duplicate.data.reports.length,1);assert.deepEqual(system.store.read(),before);
  assert.equal(duplicate.data.reports[0].text,REHEARSAL_TEXT);assert.equal(duplicate.data.phone.rehearsalInputText,REHEARSAL_TEXT);
});

test('correction and arbitrary fictional input stay quoted review material without positive welfare or assistance effects',async t=>{
  const system=await server(t),before=family(system.store.read()),correction='Correction: I did not see Elena at Oak School.';
  const result=await system.simulate(correction,'correction');assert.equal(result.status,200);
  const report=result.data.reports.find(report=>report.id===result.data.phoneAction.reportId);
  assert.equal(report.text,correction);assert.deepEqual(report.observations,[]);assert.equal(report.modelReview.extractorSource,'local_demo_rules');
  assert.ok(report.modelReview.proposal.observations.every(observation=>['correction','unknown'].includes(observation.type)));
  const custom=await system.simulate('A fictional message outside the scripted sighting grammar.');
  assert.equal(custom.status,200);assert.deepEqual(custom.data.reports.at(-1).modelReview.proposal.observations.map(observation=>observation.type),['unknown']);
  assert.deepEqual(family(system.store.read()),before);
});

test('human review, simulated reply preparation/send/delivery and Messages outbox remain separate',async t=>{
  const system=await server(t),first=await system.simulate(),id=first.data.phoneAction.reportId,report=first.data.reports[0],originalCase=structuredClone(first.data.cases[0]);
  const review=await system.call(`/api/reports/${id}/review`,{method:'POST',body:{action:'accept',reviewerName:'Reviewer Demo',note:'Checked these exact source quotes in the fictional incoming report.',expectedProposalToken:report.modelReview.proposalToken}});
  assert.equal(review.status,200);assert.equal(review.data.reports[0].modelReview.status,'accepted');
  assert.ok(review.data.reports[0].observations.every(observation=>observation.verification==='reported'));
  assert.deepEqual(review.data.cases[0],{...originalCase,reportIds:[id]});assert.deepEqual(review.data.assistance,[]);assert.deepEqual(review.data.outbox,[]);
  assert.equal((await system.call(`/api/reports/${id}/reply/send`,{method:'POST',body:{}})).status,409);
  const prepared=await system.call(`/api/reports/${id}/reply/prepare`,{method:'POST',body:{}});assert.equal(prepared.status,200);assert.equal(prepared.data.phoneAction.status,'prepared');assert.deepEqual(prepared.data.outbox,[]);
  const accepted=await system.call(`/api/reports/${id}/reply/send`,{method:'POST',body:{}});assert.equal(accepted.status,200);assert.equal(accepted.data.phoneAction.status,'accepted');assert.equal(accepted.data.phoneAction.delivered,false);
  assert.equal(accepted.data.outbox.length,1);assert.equal(accepted.data.outbox[0].status,'simulated');assert.equal(accepted.data.outbox[0].kind,'rehearsal_reply');assert.equal(accepted.data.outbox[0].text,REHEARSAL_REPLY);
  assert.equal(caseEvents(accepted.data,'C104').filter(event=>event.direction==='outgoing').length,1);
  const repeated=await system.call(`/api/reports/${id}/reply/send`,{method:'POST',body:{}});assert.equal(repeated.data.outbox.length,1);assert.equal(repeated.data.phoneAction.attempts,1);
  const delivered=await system.call(`/api/reports/${id}/reply/delivery`,{method:'POST',body:{}});assert.equal(delivered.status,200);assert.equal(delivered.data.phoneAction.delivered,true);
  assert.equal(delivered.data.outbox[0].status,'simulated');assert.equal(delivered.data.cases[0].welfareState,'unknown');assert.equal(delivered.data.cases[0].locationState,'unknown');assert.deepEqual(delivered.data.assistance,[]);
  assert.equal((await system.call('/api/health')).data.liveSendingEnabled,false);
});

test('STOP blocks further interpretation/replies; Reset returns fresh rehearsal status and permits the next local run',async t=>{
  const system=await server(t),first=await system.simulate(),id=first.data.phoneAction.reportId;
  const stop=await system.simulate('STOP','stop');assert.equal(stop.status,200);assert.equal(stop.data.phoneAction.status,'command_processed');
  assert.equal(stop.data.phone.canSimulate,false);assert.equal(stop.data.phone.sendingEnabled,false);assert.equal(stop.data.phone.canReset,true);
  assert.equal(stop.data.phone.lastStopReason,'consent_revoked');assert.equal(stop.data.phone.modelUsed,1);
  assert.equal((await system.simulate()).status,409);
  assert.equal((await system.call(`/api/reports/${id}/interpret`,{method:'POST',body:{}})).status,409);
  assert.equal((await system.call(`/api/reports/${id}/reply/prepare`,{method:'POST',body:{}})).status,409);
  const reset=await system.call('/api/reset',{method:'POST',body:{}});assert.equal(reset.status,200);
  assert.equal(reset.data.phone.mode,'rehearsal');assert.equal(reset.data.phone.canSimulate,true);assert.equal(reset.data.phone.canReset,true);assert.equal(reset.data.phone.modelUsed,0);
  assert.equal(reset.data.phone.lastStopReason,null);assert.deepEqual(reset.data.phone.eligibleReportIds,[]);assert.deepEqual(reset.data.phone.replyStates,[]);
  assert.deepEqual(reset.data.reports,[]);assert.deepEqual(reset.data.outbox,[]);assert.equal(reset.data.participants.find(person=>person.id==='neighbor-1').optedIn,true);
  const next=await system.simulate();assert.equal(next.status,200);assert.notEqual(next.data.phoneAction.reportId,id);assert.equal(next.data.phone.modelUsed,1);
});

test('local interpretation limit and rejection contracts are reported without a remote request or hidden fallback',async t=>{
  const system=await server(t,{maxInterpretations:1});await system.simulate();
  const second=await system.simulate('Another fictional source message.');assert.equal(second.status,200);
  assert.equal(second.data.phone.modelUsed,1);assert.equal(second.data.phone.modelLimit,1);assert.equal(second.data.phoneAction.interpretation.reason,'budget_exhausted');
  assert.equal(second.data.reports.at(-1).modelReview.status,'queued');assert.deepEqual(second.data.reports.at(-1).observations,[]);
  const snapshot=system.store.read();
  for(const body of [{text:'',scenario:'message'},{text:'x'.repeat(3001),scenario:'message'},{text:'not STOP',scenario:'stop'},{text:REHEARSAL_TEXT,scenario:'unknown'},{text:REHEARSAL_TEXT,fixtureAlias:'neighbor-2'}])assert.equal((await system.call('/api/phone/simulate',{method:'POST',body})).status,400);
  assert.equal((await system.call('/api/phone/simulate?to=external',{method:'POST',body:{text:REHEARSAL_TEXT}})).status,400);
  assert.equal((await system.call('/api/phone/simulate',{method:'POST',body:{text:REHEARSAL_TEXT},headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await system.call('/api/reset',{method:'POST',body:{keepPhone:true}})).status,400);
  assert.deepEqual(system.store.read(),snapshot);
});

test('ordinary server cannot enable the rehearsal composer route by receiving its request',async t=>{
  const system=await server(t,{rehearsal:false}),before=system.store.read();
  assert.equal((await system.simulate()).status,409);assert.deepEqual(system.store.read(),before);
  assert.equal((await system.call('/api/health')).data.liveSendingEnabled,false);
});

async function acceptedReport(system,{text=REHEARSAL_TEXT,observationIndices}={}){
  const captured=await system.simulate(text),reportId=captured.data.phoneAction.reportId;
  assert.equal(captured.status,200);
  const source=captured.data.reports.find(item=>item.id===reportId);
  const reviewed=await system.call(`/api/reports/${reportId}/review`,{method:'POST',body:{action:'accept',reviewerName:'Reviewer Demo',note:'Checked the selected original fictional source clauses.',expectedProposalToken:source.modelReview.proposalToken,...(observationIndices?{observationIndices}:{})}});
  assert.equal(reviewed.status,200);
  return reviewed.data.reports.find(item=>item.id===reportId);
}
const trackingInput=observationId=>({observationId,reviewerName:'Officer Demo',note:'Track the reported need for human follow-up; no assistance is assigned.'});

test('HTTP assistance is an explicit human action after accepted water evidence and deduplicates one unassigned task',async t=>{
  const system=await server(t),captured=await system.simulate(),id=captured.data.phoneAction.reportId;
  const initial=system.store.read();
  const premature=await system.call(`/api/reports/${id}/assistance`,{method:'POST',body:trackingInput('O-unaccepted-proposal')});
  assert.equal(premature.status,409);assert.deepEqual(system.store.read(),initial);
  const proposal=captured.data.reports.find(item=>item.id===id).modelReview;
  const reviewed=await system.call(`/api/reports/${id}/review`,{method:'POST',body:{action:'accept',reviewerName:'Reviewer Demo',note:'Checked each literal fictional observation.',expectedProposalToken:proposal.proposalToken}});
  assert.equal(reviewed.status,200);assert.deepEqual(reviewed.data.assistance,[]);
  const accepted=reviewed.data.reports.find(item=>item.id===id),water=accepted.observations.find(item=>item.type==='water_need');
  assert.ok(water);assert.equal(water.verification,'reported');
  const before=system.store.read(),body=trackingInput(water.id),path=`/api/reports/${id}/assistance`;
  const tracked=await system.call(path,{method:'POST',body});
  assert.equal(tracked.status,200);assert.equal(tracked.data.duplicate,false);assert.equal(tracked.data.status,'unassigned');
  assert.equal(tracked.data.caseId,'C104');assert.equal(tracked.data.reportId,id);assert.equal(tracked.data.observationId,water.id);
  assert.equal(tracked.data.assistance.length,1);
  const task=tracked.data.assistance[0];
  assert.equal(task.id,tracked.data.taskId);assert.equal(task.caseId,'C104');assert.equal(task.reportId,id);assert.equal(task.observationId,water.id);
  assert.equal(task.type,'water_need');assert.equal(task.summary,water.summary);assert.equal(task.status,'unassigned');
  assert.equal(task.reviewerName,body.reviewerName);assert.equal(task.note,body.note);
  assert.deepEqual(tracked.data.cases,before.cases);assert.deepEqual(tracked.data.participants,before.participants);assert.deepEqual(tracked.data.reports,publicState(before).reports);
  assert.deepEqual(tracked.data.outbox,before.outbox);assert.equal(tracked.data.cases[0].welfareState,'unknown');assert.equal(tracked.data.cases[0].locationState,'unknown');
  assert.equal(tracked.headers['x-beacon-session'],system.store.version.sessionId);
  const persisted=system.store.read(),replayed=await system.call(path,{method:'POST',body});
  assert.equal(replayed.status,200);assert.equal(replayed.data.duplicate,true);assert.equal(replayed.data.taskId,task.id);assert.equal(replayed.data.assistance.length,1);
  assert.deepEqual(system.store.read(),persisted);assert.deepEqual(new Store(system.statePath).read(),persisted);
});

test('HTTP assistance rejects injected state, malformed selection, unaccepted types and wrong-source observation IDs',async t=>{
  const system=await server(t),accepted=await acceptedReport(system),water=accepted.observations.find(item=>item.type==='water_need'),sighting=accepted.observations.find(item=>item.type==='sighting');
  const other=await acceptedReport(system,{text:'They need water for three people.'}),otherWater=other.observations.find(item=>item.type==='water_need');
  const path=`/api/reports/${accepted.id}/assistance`,valid=trackingInput(water.id),before=system.store.read();
  for(const body of [{},{...valid,observationId:''},{...valid,reviewerName:''},{...valid,note:''},{...valid,note:'x'.repeat(1501)},{...valid,observationId:otherWater.id},{...valid,observationId:'O-missing'},{...valid,reportId:other.id},{...valid,caseId:'C105'},{...valid,status:'assigned'},{...valid,welfareState:'assistance_needed'},{...valid,type:'evacuation'},{...valid,quantity:999}]){
    const rejected=await system.call(path,{method:'POST',body});
    assert.equal(rejected.status,400,JSON.stringify({body,error:rejected.data}));
    assert.deepEqual(system.store.read(),before);
  }
  assert.equal((await system.call(path,{method:'POST',body:{...valid,observationId:sighting.id}})).status,409);
  assert.equal((await system.call(path+'?force=true',{method:'POST',body:valid})).status,400);
  assert.equal((await system.call(path,{method:'POST',body:valid,headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await system.call(path)).status,404);
  assert.equal((await system.call('/api/reports/R-missing/assistance',{method:'POST',body:valid})).status,404);
  assert.deepEqual(system.store.read(),before);
  const sightingOnly=await acceptedReport(system,{observationIndices:[0]});
  assert.deepEqual(sightingOnly.observations.map(item=>item.type),['sighting']);
  const noNeedBefore=system.store.read();
  assert.equal((await system.call(`/api/reports/${sightingOnly.id}/assistance`,{method:'POST',body:trackingInput(sightingOnly.observations[0].id)})).status,409);
  assert.deepEqual(system.store.read(),noNeedBefore);
});

test('HTTP assistance rechecks accepted raw/proposal/case linkage rather than trusting stale displayed water evidence',async t=>{
  for(const change of ['raw_text','case_subject','proposal','accepted_observation','accepted_selection','case_link'])await t.test(change,async sub=>{
    const system=await server(sub),accepted=await acceptedReport(system),water=accepted.observations.find(item=>item.type==='water_need');
    system.store.act(state=>{
      const report=state.reports.find(item=>item.id===accepted.id);
      if(change==='raw_text')report.text='Changed fictional source after acceptance.';
      else if(change==='case_subject')state.cases[0].subjectNames='Different fictional subject';
      else if(change==='proposal')report.modelReview.proposal.observations[1].summary='Unsupported changed claim';
      else if(change==='accepted_observation')report.observations.find(item=>item.id===water.id).quantity=999;
      else if(change==='accepted_selection')report.modelReview.reviewDecision.observationIndices=[0];
      else state.cases[0].reportIds=[];
    });
    const before=system.store.read(),result=await system.call(`/api/reports/${accepted.id}/assistance`,{method:'POST',body:trackingInput(water.id)});
    assert.ok([400,409].includes(result.status),change);assert.deepEqual(system.store.read(),before);assert.deepEqual(before.assistance,[]);assert.deepEqual(before.outbox,[]);
  });
});

test('HTTP assistance can remain unassigned after separate officer verification resolves welfare without reopening the case',async t=>{
  const system=await server(t),accepted=await acceptedReport(system),water=accepted.observations.find(item=>item.type==='water_need');
  const verified=await system.call('/api/cases/C104/verify',{method:'POST',body:{officerName:'Officer Demo',note:'Direct fictional confirmation of Elena Brooks at the exercise site.',evidenceIds:[accepted.id],welfare:'confirmed_safe',resolve:true}});
  assert.equal(verified.status,200);assert.equal(verified.data.cases[0].welfareState,'confirmed_safe');assert.equal(verified.data.cases[0].reviewState,'resolved');
  const before=system.store.read(),tracked=await system.call(`/api/reports/${accepted.id}/assistance`,{method:'POST',body:trackingInput(water.id)});
  assert.equal(tracked.status,200);assert.equal(tracked.data.assistance[0].status,'unassigned');
  assert.deepEqual(tracked.data.cases,before.cases);assert.deepEqual(tracked.data.outbox,before.outbox);assert.deepEqual(tracked.data.participants,before.participants);
  assert.equal(tracked.data.cases[0].welfareState,'confirmed_safe');assert.equal(tracked.data.cases[0].reviewState,'resolved');assert.equal(tracked.data.cases[0].outreachState,'stopped');
});
