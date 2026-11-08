import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {openCase,setConsent} from '../src/domain.js';
import {captureRawReport} from '../src/report-inbox.js';
import {ProviderLedger} from '../src/provider-ledger.js';
import {createPhotonInbox,bindPhotonIdentity,adaptPhotonMessage,photonScopeFingerprint} from '../src/photon-inbox.js';
import {createNemotronJobs} from '../src/nemotron-jobs.js';
import {publicState} from '../src/public-state.js';

const id=(kind,value)=>`pho_${kind}_${String(value).padStart(26,'0')}`;
const projectId=id('prj',1),personUsrId=id('usr',2),agentUsrId=id('usr',3),spaceId=id('spc',4);
const text='I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.';
const proposal={observations:[{type:'sighting',sourceSpan:'I saw Rosa and Miguel at Oak School',quantity:null,location:'Oak School'},
  {type:'water_need',sourceSpan:'They need water for two people',quantity:2,location:null}],reviewFlags:[]};
function message(number,{content=text,timestamp=new Date().toISOString()}={}){
  return {id:id('msg',number),projectId,platform:'imessage',status:'received',timestamps:{receivedAt:timestamp},
    space:{id:spaceId,projectId,platform:'imessage',kind:'direct',participantIds:[personUsrId,agentUsrId]},
    sentBy:{id:personUsrId,kind:'human',projectId,platform:'imessage',handle:'private-consented-owner@fixture.test'},
    receivedBy:{id:agentUsrId,kind:'agent',projectId,platform:'imessage',handle:'private-test-line@fixture.test'},
    content:{type:'text',format:'plain',text:content}};
}
function setup(t,{messages=[message(10)],extract,timeoutMs=1000}={}){
  const dir=mkdtempSync(join(tmpdir(),'beacon-model-jobs-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const statePath=join(dir,'state.json'),ledgerPath=join(dir,'private','ledger.json'),store=new Store(statePath),ledger=new ProviderLedger(ledgerPath);
  const {caseId}=store.act(openCase,{subjectNames:'Rosa and Miguel Santos',description:'Fictional grandparents inquiry.',reporterId:'mom',lastKnownTile:'A1',lastContactAt:'2026-11-07T12:00:00Z',searchTiles:['A1'],consentToOutreach:true});
  const now=Date.now(),scope={id:'consented-synthetic-model-test',projectId,platform:'imessage',agentUsrId,dataClass:'synthetic',
    from:new Date(now-60_000).toISOString(),to:new Date(now+15*60_000).toISOString(),maxPages:1,maxMessages:10,maxPolls:5};
  ledger.setMappings([bindPhotonIdentity(store.read(),{projectId,platform:'imessage',personUsrId,spaceId,agentUsrId,fixtureAlias:'neighbor-1',caseId,approvedTexts:[text]})]);
  const calls={poll:0,model:0,reply:0},transport={async listReceived(options){calls.poll++;assert.equal(options.platform,'imessage');return {platform:'imessage',items:structuredClone(messages),pages:1};},reply(){calls.reply++;throw new Error('No outgoing provider call is part of this test.');}};
  const modelClient={async extract(input,options){calls.model++;return extract?extract(input,options):structuredClone(proposal);}};
  const bridge=createPhotonInbox({enabled:true,store,ledger,client:transport,messageAdapter:raw=>adaptPhotonMessage(raw,{providerTimestamp:raw.timestamps?.receivedAt}),scope});
  const jobs=options=>createNemotronJobs({enabled:true,store,ledger,modelClient,scope,timeoutMs,...options});
  return {dir,statePath,ledgerPath,store,ledger,caseId,scope,calls,bridge,jobs,modelClient,transport};
}
const getReport=(store,reportId)=>store.read().reports.find(report=>report.id===reportId);
const domain=state=>({cases:state.cases,participants:state.participants,assistance:state.assistance,outbox:state.outbox,integrations:state.integrations,incident:state.incident});
async function captured(system){const result=await system.bridge.pollOnce();assert.equal(result.captured,1);assert.equal(result.queuedReportIds.length,1);return result.queuedReportIds[0];}

test('actual mocked phone poll durably captures before bounded interpretation and leaves the first proposal unaccepted',async t=>{
  let system;
  system=setup(t,{extract(input,{signal}){
    assert.equal(signal.aborted,false);assert.deepEqual(input,{dataClass:'synthetic',text,subjectNames:['Rosa and Miguel Santos']});
    const persistedStore=new Store(system.statePath).read(),privateLedger=new ProviderLedger(system.ledgerPath).read();
    const report=persistedStore.reports[0],receipt=Object.values(privateLedger.receipts)[0];
    assert.equal(receipt.status,'captured');assert.equal(receipt.reportId,report.id);assert.equal(report.text,text);assert.equal(report.modelReview.status,'running');
    assert.equal(privateLedger.modelJobs[report.id].status,'reserved');assert.equal(privateLedger.budgets[photonScopeFingerprint(system.scope)].modelRequests,1);
    return structuredClone(proposal);
  }});
  const reportId=await captured(system),before=domain(system.store.read()),result=await system.jobs().interpretOne(reportId);
  assert.equal(result.ran,true);assert.equal(result.status,'proposal_ready');assert.equal(system.calls.model,1);assert.equal(system.calls.reply,0);
  const report=getReport(system.store,reportId);assert.deepEqual(report.observations,[]);assert.equal(report.processingState,'needs_review');
  assert.equal(report.modelReview.proposal.requiresReview,true);assert.match(report.modelReview.proposalToken,/^[a-f0-9]{64}$/);
  assert.deepEqual(domain(system.store.read()),before);assert.deepEqual(new Store(system.statePath).read(),system.store.read());
});

test('default disabled interpretation performs no reads, reservations, model requests or validation of unconfigured dependencies',async()=>{
  let touched=0;
  const forbidden=new Proxy({}, {get(){touched++;throw new Error('Disabled jobs must remain inert.');}});
  const jobs=createNemotronJobs({store:forbidden,ledger:forbidden,modelClient:forbidden,scope:forbidden});
  assert.deepEqual(await jobs.interpretOne('unconfigured'),{ran:false,reason:'disabled'});
  assert.deepEqual(jobs.status(),{enabled:false,maxRequests:3,usedRequests:0});assert.equal(touched,0);
});

test('the hard model cap is at most three and durable reservations survive restarts and duplicate polls',async t=>{
  const system=setup(t,{messages:[10,11,12,13].map(number=>message(number))}),polled=await system.bridge.pollOnce();
  assert.equal(polled.queuedReportIds.length,4);const ids=polled.queuedReportIds,jobs=system.jobs();
  for(const reportId of ids.slice(0,3))assert.equal((await jobs.interpretOne(reportId)).status,'proposal_ready');
  assert.deepEqual(await jobs.interpretOne(ids[3]),{ran:false,reason:'budget_exhausted',reportId:ids[3]});assert.equal(system.calls.model,3);
  const restartedStore=new Store(system.statePath),restartedLedger=new ProviderLedger(system.ledgerPath),restarted=system.jobs({store:restartedStore,ledger:restartedLedger});
  assert.deepEqual(restarted.status(),{enabled:true,maxRequests:3,usedRequests:3});
  assert.equal((await restarted.interpretOne(ids[3])).reason,'budget_exhausted');
  assert.equal((await restarted.interpretOne(ids[0])).reason,'not_queued');assert.equal(system.calls.model,3);
  const duplicate=await system.bridge.pollOnce();assert.equal(duplicate.captured,0);assert.equal(duplicate.duplicates,4);
  assert.equal(system.store.read().reports.length,4);assert.equal(system.calls.model,3);assert.equal(system.calls.reply,0);
  const persisted=JSON.parse(readFileSync(system.ledgerPath,'utf8'));assert.equal(persisted.budgets[photonScopeFingerprint(system.scope)].modelRequests,3);
  for(const maxRequests of [0,4,10,1.5])await assert.rejects(system.jobs({maxRequests}).interpretOne(ids[3]),{code:'invalid_configuration'});
  assert.equal(system.calls.model,3);
});

test('approved exact text, mapped identity, case fingerprint, fixture consent and active window are checked before budget use',async t=>{
  for(const change of ['text','identity','case','consent','fixture','mode','window','synthetic']){
    await t.test(change,async sub=>{
      const system=setup(sub),reportId=await captured(system);
      if(change==='identity')system.ledger.setMappings(system.ledger.mappings().map(identity=>({...identity,approvedTextHashes:[]})));
      else if(change==='window')sub.mock.method(Date,'now',()=>Date.parse(system.scope.to)+1);
      else if(change==='synthetic')system.scope.dataClass='real';
      else system.store.act(state=>{
        if(change==='text')state.reports.find(report=>report.id===reportId).text=text+' Unapproved extra content.';
        if(change==='case')state.cases.find(item=>item.id===system.caseId).createdAt='2020-01-01T00:00:00.000Z';
        if(change==='consent')state.participants.find(item=>item.id==='neighbor-1').optedIn=false;
        if(change==='fixture')state.participants.find(item=>item.id==='neighbor-1').source='real';
        if(change==='mode')state.mode='live';
      });
      const before=system.store.read(),privateBefore=system.ledger.read();
      await assert.rejects(system.jobs().interpretOne(reportId));assert.equal(system.calls.model,0);
      assert.deepEqual(system.store.read(),before);assert.deepEqual(system.ledger.read(),privateBefore);assert.deepEqual(privateBefore.modelJobs,{});
    });
  }
});

test('a queued report with no captured private receipt is never interpreted',async t=>{
  const system=setup(t);const {reportId}=system.store.act(captureRawReport,{dataClass:'synthetic',provider:'photon',projectId,messageId:id('msg',20),senderId:'neighbor-1',caseId:system.caseId,text,observedAt:null});
  const before=system.store.read();await assert.rejects(system.jobs().interpretOne(reportId),{code:'unapproved_report'});
  assert.equal(system.calls.model,0);assert.deepEqual(system.store.read(),before);assert.deepEqual(system.ledger.read().modelJobs,{});
});

test('a newly ambiguous identity mapping cannot authorize interpretation of an older queued receipt',async t=>{
  for(const kind of ['duplicate','same_route_new_id','same_id_new_route'])await t.test(kind,async sub=>{
    const system=setup(sub),reportId=await captured(system),mapping=system.ledger.mappings()[0],duplicate=structuredClone(mapping);
    if(kind==='same_route_new_id')duplicate.id='alternate-private-identity';
    if(kind==='same_id_new_route')duplicate.personUsrId=id('usr',99);
    system.ledger.setMappings([mapping,duplicate]);
    const before=system.store.read(),privateBefore=system.ledger.read();
    await assert.rejects(system.jobs().interpretOne(reportId));
    assert.equal(system.calls.model,0);assert.deepEqual(system.store.read(),before);assert.deepEqual(system.ledger.read(),privateBefore);
  });
});

test('identity ambiguity introduced after reservation is checked again immediately before extraction',async t=>{
  const system=setup(t),reportId=await captured(system),act=system.ledger.act.bind(system.ledger);let changed=false;
  system.ledger.act=(action,...args)=>{
    const result=act(action,...args);
    if(result?.reserved===true&&system.ledger.read().modelJobs[reportId]&&!changed){
      changed=true;const mapping=system.ledger.mappings()[0];system.ledger.setMappings([mapping,structuredClone(mapping)]);
    }
    return result;
  };
  const before=domain(system.store.read()),result=await system.jobs().interpretOne(reportId);
  assert.equal(changed,true);assert.equal(result.status,'failed');assert.equal(system.calls.model,0);
  assert.deepEqual(domain(system.store.read()),before);assert.deepEqual(getReport(system.store,reportId).observations,[]);
});

test('STOP after reservation and after claim prevents the pending model call without automatic replies',async t=>{
  for(const boundary of ['reservation','claim'])await t.test(boundary,async sub=>{
    const system=setup(sub),reportId=await captured(system),before=domain(system.store.read());let stopped=false;
    const stop=()=>{if(stopped)return;stopped=true;system.store.act(captureRawReport,{dataClass:'synthetic',provider:'photon',projectId,messageId:`synthetic-stop-${boundary}`,senderId:'neighbor-1',caseId:null,text:'STOP',observedAt:null});};
    if(boundary==='reservation'){
      const act=system.ledger.act.bind(system.ledger);system.ledger.act=(action,...args)=>{
        const result=act(action,...args);if(result?.reserved===true&&system.ledger.read().modelJobs[reportId])stop();return result;
      };
    }
    const pending=system.jobs().interpretOne(reportId);
    if(boundary==='claim'){assert.equal(getReport(system.store,reportId).modelReview.status,'running');stop();}
    const result=await pending;assert.equal(stopped,true);assert.equal(system.calls.model,0);assert.equal(system.calls.reply,0);
    assert.equal(result.status,'failed');assert.deepEqual(getReport(system.store,reportId).observations,[]);
    const expected=structuredClone(before);expected.participants.find(item=>item.id==='neighbor-1').optedIn=false;
    assert.deepEqual(domain(system.store.read()),expected);
    assert.equal(system.ledger.read().budgets[photonScopeFingerprint(system.scope)].modelRequests,1);
  });
});

function journal(system,envelope){
  const receipt=Object.values(system.ledger.read().receipts)[0];
  return system.ledger.journalRaw({projectId,platform:'imessage',messageId:envelope.id,envelope,
    scopeId:photonScopeFingerprint(system.scope),mappingSetHash:receipt.mappingSetHash});
}

test('a durable private STOP blocks interpretation before public consent capture, including after claim',async t=>{
  for(const boundary of ['before_reservation','after_claim'])await t.test(boundary,async sub=>{
    const system=setup(sub),reportId=await captured(system),before=domain(system.store.read());
    let pending;if(boundary==='after_claim')pending=system.jobs().interpretOne(reportId);
    journal(system,message(50,{content:' STOP '}));
    const stopReceipt=Object.values(new ProviderLedger(system.ledgerPath).read().receipts).find(receipt=>receipt.messageId===id('msg',50));
    assert.equal(stopReceipt.status,'pending');assert.equal(stopReceipt.reportId,null);
    assert.equal(system.store.read().participants.find(item=>item.id==='neighbor-1').optedIn,true);
    assert.equal(system.store.read().reports.length,1);
    if(pending)assert.equal((await pending).status,'failed');
    else await assert.rejects(system.jobs().interpretOne(reportId),{code:'consent_revoked'});
    assert.equal(system.calls.model,0);assert.equal(system.calls.reply,0);assert.deepEqual(domain(system.store.read()),before);
    assert.deepEqual(getReport(system.store,reportId).observations,[]);
    assert.equal(Object.keys(system.ledger.read().modelJobs).length,boundary==='after_claim'?1:0);
  });
});

test('a conflicting provider retry after capture blocks the original receipt without overwriting public raw text',async t=>{
  for(const boundary of ['before_reservation','after_claim'])await t.test(boundary,async sub=>{
    const system=setup(sub),reportId=await captured(system),before=domain(system.store.read());
    let pending;if(boundary==='after_claim')pending=system.jobs().interpretOne(reportId);
    const conflict=journal(system,message(10,{content:'Changed provider content using the same message ID.'}));
    assert.equal(conflict.conflict,true);assert.equal(conflict.receipt.status,'captured');assert.equal(conflict.receipt.conflicts.length,1);
    if(pending)assert.equal((await pending).status,'failed');
    else await assert.rejects(system.jobs().interpretOne(reportId),{code:'source_changed'});
    assert.equal(system.calls.model,0);assert.equal(system.calls.reply,0);assert.equal(getReport(system.store,reportId).text,text);
    assert.deepEqual(getReport(system.store,reportId).observations,[]);assert.deepEqual(domain(system.store.read()),before);
  });
});

test('private receipt key/hash corruption is rejected before a model reservation',async t=>{
  for(const corruption of ['key','envelope','conflicts'])await t.test(corruption,async sub=>{
    const system=setup(sub),reportId=await captured(system);
    system.ledger.act(state=>{
      const receipt=Object.values(state.receipts)[0];
      if(corruption==='key')receipt.key='incorrect-private-receipt-key';
      if(corruption==='envelope')receipt.envelope.sentBy.handle='changed-private-handle@fixture.test';
      if(corruption==='conflicts')receipt.conflicts=null;
    });
    const before=system.store.read(),privateBefore=system.ledger.read();
    await assert.rejects(system.jobs().interpretOne(reportId),{code:'source_changed'});
    assert.equal(system.calls.model,0);assert.deepEqual(system.store.read(),before);assert.deepEqual(system.ledger.read(),privateBefore);
  });
});

test('an unrelated malformed raw text envelope cannot poison STOP checks for an approved report',async t=>{
  const system=setup(t),reportId=await captured(system),malformed=message(51);malformed.content.text=42;
  journal(system,malformed);
  assert.equal((await system.jobs().interpretOne(reportId)).status,'proposal_ready');assert.equal(system.calls.model,1);
});

test('timeout retains raw report and durable budget; late output and repeated/restarted requests do not resend',async t=>{
  let finish,requestSignal;
  const system=setup(t,{timeoutMs:50,extract(input,{signal}){requestSignal=signal;return new Promise(resolve=>{finish=resolve;});}}),reportId=await captured(system);
  const before=domain(system.store.read()),result=await system.jobs().interpretOne(reportId);
  assert.equal(result.status,'failed');assert.equal(result.errorCode,'timeout');assert.equal(requestSignal.aborted,true);assert.equal(system.calls.model,1);
  const after=system.store.read();assert.equal(getReport(system.store,reportId).text,text);assert.deepEqual(getReport(system.store,reportId).observations,[]);assert.deepEqual(domain(after),before);
  finish(proposal);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(system.store.read(),after);
  assert.equal((await system.jobs().interpretOne(reportId)).reason,'not_queued');
  const restarted=system.jobs({store:new Store(system.statePath),ledger:new ProviderLedger(system.ledgerPath)});
  assert.equal((await restarted.interpretOne(reportId)).reason,'not_queued');assert.equal(restarted.status().usedRequests,1);
  assert.equal(system.calls.model,1);assert.equal(system.calls.reply,0);assert.deepEqual(system.ledger.read().replyJobs,{});
});

test('reservation persistence failure makes zero model calls and leaves the raw queue and budget unchanged',async t=>{
  const system=setup(t),reportId=await captured(system),before=system.store.read(),privateBefore=system.ledger.read();
  const blocker=join(system.dir,'not-a-directory');writeFileSync(blocker,'fixture filesystem blocker');system.ledger.path=join(blocker,'ledger.json');
  await assert.rejects(system.jobs().interpretOne(reportId),{code:'storage_failed'});
  assert.equal(system.calls.model,0);assert.deepEqual(system.store.read(),before);assert.deepEqual(system.ledger.read(),privateBefore);
  assert.equal(getReport(system.store,reportId).modelReview.status,'queued');
});

test('a failed claim consumes its durable reservation but cannot call or automatically retry extraction',async t=>{
  const system=setup(t),reportId=await captured(system),save=system.store.save.bind(system.store),before=system.store.read();
  system.store.save=()=>{throw new Error('Synthetic claim persistence failure');};
  await assert.rejects(system.jobs().interpretOne(reportId),/Synthetic claim persistence failure/);
  assert.equal(system.calls.model,0);assert.deepEqual(system.store.read(),before);
  assert.equal(system.ledger.read().modelJobs[reportId].status,'reserved');
  system.store.save=save;assert.equal((await system.jobs().interpretOne(reportId)).reason,'already_reserved');
  assert.equal(system.jobs().status().usedRequests,1);assert.equal(system.calls.model,0);
});

test('pre-cancelled and concurrent requests cannot create extra model reservations or invocations',async t=>{
  const system=setup(t,{extract:()=>new Promise(()=>{})}),reportId=await captured(system),jobs=system.jobs(),before=system.ledger.read();
  const cancelled=new AbortController();cancelled.abort();
  assert.deepEqual(await jobs.interpretOne(reportId,{signal:cancelled.signal}),{ran:false,reason:'cancelled'});
  assert.deepEqual(system.ledger.read(),before);assert.equal(system.calls.model,0);
  const controller=new AbortController(),pending=jobs.interpretOne(reportId,{signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(system.calls.model,1);
  assert.deepEqual(await jobs.interpretOne(reportId),{ran:false,reason:'busy'});
  controller.abort();assert.equal((await pending).errorCode,'cancelled');
  assert.equal(system.jobs().status().usedRequests,1);assert.equal(system.calls.model,1);assert.equal(system.calls.reply,0);
});

test('private receipt envelopes and actual handles remain in the separate ledger, never in Store or public proposal payloads',async t=>{
  const system=setup(t),reportId=await captured(system);await system.jobs().interpretOne(reportId);
  const privateText=JSON.stringify(system.ledger.read());assert.match(privateText,/private-consented-owner@fixture\.test/);assert.match(privateText,/private-test-line@fixture\.test/);
  const stored=system.store.read(),view=publicState(stored);
  for(const data of [stored,view])assert.doesNotMatch(JSON.stringify(data),/private-consented-owner|private-test-line|mappingFingerprint|receiptKey|"receipts"|"modelJobs"/);
  assert.doesNotMatch(JSON.stringify(view),/"providerIdentity"|"claimToken"|"sourceHash"|"sourceSnapshot"/);
  assert.equal(view.reports[0].text,text);assert.equal(view.reports[0].modelReview.proposal.requiresReview,true);
  assert.equal(view.participants[0].phone,'+12125550100');assert.deepEqual(stored.outbox,[]);assert.deepEqual(stored.assistance,[]);
});
