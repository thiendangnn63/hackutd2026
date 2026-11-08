import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {publicState} from '../src/public-state.js';
import {ProviderLedger,ProviderLedgerError} from '../src/provider-ledger.js';
import {createPhotonInbox,adaptPhotonMessage,bindPhotonIdentity,fixtureCaseFingerprint,photonScopeFingerprint} from '../src/photon-inbox.js';
const canonical=(kind,n=1)=>`pho_${kind}_${String(n).padStart(26,'0')}`;
const PROJECT=canonical('prj'),PERSON=canonical('usr',2),AGENT=canonical('usr'),SPACE=canonical('spc'),TEXT='I saw Elena at Oak School.';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const domain=state=>({cases:state.cases,participants:state.participants,assistance:state.assistance,outbox:state.outbox,integrations:state.integrations});
const adapter=raw=>adaptPhotonMessage(raw,{providerTimestamp:raw.timestamps?.receivedAt});
function message(n=1,patch={}){const now=new Date().toISOString();return {id:canonical('msg',n),projectId:PROJECT,platform:'imessage',status:'received',space:{id:SPACE,projectId:PROJECT,platform:'imessage',kind:'direct',participantIds:[AGENT,PERSON]},sentBy:{id:PERSON,projectId:PROJECT,platform:'imessage',kind:'human',handle:'+12125550199'},receivedBy:{id:AGENT,projectId:PROJECT,platform:'imessage',kind:'agent',handle:'private-agent'},content:{type:'text',format:'plain',text:TEXT},timestamps:{receivedAt:now},createdAt:now,updatedAt:now,metadata:{privateFixtureKey:'private_fixture_not_a_credential'},...patch};}
function fixture(t,{maxPolls=5,maxMessages=20}={}){
  const dir=mkdtempSync(join(tmpdir(),'beacon-inbox-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const storePath=join(dir,'state.json'),ledgerPath=join(dir,'provider-private.json'),store=new Store(storePath),ledger=new ProviderLedger(ledgerPath);
  const scope={id:'synthetic-phone-test',projectId:PROJECT,platform:'imessage',agentUsrId:AGENT,from:new Date(Date.now()-60000).toISOString(),to:new Date(Date.now()+60000).toISOString(),maxPages:1,maxMessages,maxPolls,dataClass:'synthetic'};
  const identity=bindPhotonIdentity(store.read(),{projectId:PROJECT,platform:'imessage',personUsrId:PERSON,spaceId:SPACE,agentUsrId:AGENT,fixtureAlias:'neighbor-1',caseId:'C104',approvedTexts:[TEXT,'C105: '+TEXT]});ledger.setMappings([identity]);
  const calls=[];let items=[];
  const client={async listReceived(options){calls.push(options);return {platform:'imessage',pages:1,items:structuredClone(items)};},reply(){throw new Error('Reply must never be called');},getDelivery(){throw new Error('Delivery must never be called');}};
  const create=(options={})=>createPhotonInbox({enabled:true,store,ledger,client,scope,messageAdapter:adapter,...options});
  return {store,ledger,storePath,ledgerPath,scope,identity,client,calls,create,setItems(value){items=value;}};
}
const receipts=ledger=>Object.values(ledger.read().receipts);

test('disabled/default bridge and invalid configured adapters/scopes make zero provider calls',async t=>{
  assert.deepEqual(await createPhotonInbox().pollOnce(),{polled:false,reason:'disabled'});const f=fixture(t);
  for(const options of [{messageAdapter:undefined},{scope:{...f.scope,dataClass:'real'}},{scope:{...f.scope,maxPages:0}},{scope:{...f.scope,agentUsrId:PERSON} ,messageAdapter:undefined}])await assert.rejects(f.create(options).pollOnce());
  assert.equal(f.calls.length,0);assert.equal(receipts(f.ledger).length,0);assert.equal(Object.keys(f.ledger.read().polls).length,0);
});

test('known exact synthetic text is privately durable before raw Store capture and uses no transport time as observation',async t=>{
  const f=fixture(t),raw=message(),before=domain(f.store.read());raw.timestamps.receivedAt=new Date(Date.now()-30000).toISOString();f.setItems([raw]);
  const act=f.store.act.bind(f.store);let observed=0;f.store.onChange(()=>{observed++;});
  f.store.act=(action,...args)=>{const receipt=receipts(f.ledger)[0];assert.equal(receipt.status,'capturing');assert.equal(receipt.envelope.sentBy.handle,'+12125550199');assert.equal(receipt.binding.caseId,'C104');assert.ok(readFileSync(f.ledgerPath,'utf8').includes(TEXT));return act(action,...args);};
  const result=await f.create().pollOnce();assert.equal(result.polled,true);assert.equal(result.captured,1);assert.equal(result.queuedReportIds.length,1);assert.equal(observed,1);
  const report=f.store.read().reports[0];assert.equal(report.senderId,'neighbor-1');assert.equal(report.caseId,'C104');assert.equal(report.observedAt,null);assert.notEqual(report.receivedAt,raw.timestamps.receivedAt);assert.equal(report.text,TEXT);assert.deepEqual(report.observations,[]);
  assert.deepEqual(domain(f.store.read()),before);assert.equal(receipts(f.ledger)[0].reportId,report.id);
  assert.equal(f.calls[0].platform,'imessage');assert.equal(f.calls[0].createdSince,f.scope.from);assert.equal(f.calls[0].createdBefore,f.scope.to);assert.equal(f.calls[0].maxPages,1);
  const visible=JSON.stringify(publicState(f.store.read()));assert.doesNotMatch(visible,/12125550199|private-agent|private_fixture_not_a_credential|pho_usr_|pho_spc_/);
});

test('canonical direct/person/agent contract is strict and never accepts flat legacy sender guessing',()=>{
  const raw=message();assert.equal(adapter(raw).agentUsrId,AGENT);assert.equal(adapter(raw).personUsrId,PERSON);
  for(const changed of [{...raw,space:{...raw.space,kind:'group'}},{...raw,space:{...raw.space,participantIds:[PERSON,AGENT,canonical('usr',3)]}},{...raw,sentBy:{...raw.sentBy,kind:'agent'}},{...raw,receivedBy:{...raw.receivedBy,projectId:canonical('prj',2)}},{...raw,sentBy:null,senderId:PERSON},{...raw,timestamps:{receivedAt:'2026-02-30T00:00:00Z'}}])assert.throws(()=>adapter(changed));
  assert.throws(()=>adaptPhotonMessage(raw),{code:'invalid_timestamp'});
});

test('duplicate identities survive restart and exercise reset without recapturing old phone events',async t=>{
  const f=fixture(t);f.setItems([message()]);const first=await f.create().pollOnce(),reportId=first.reportIds[0];
  const store=new Store(f.storePath),ledger=new ProviderLedger(f.ledgerPath),bridge=f.create({store,ledger});
  const second=await bridge.pollOnce();assert.equal(second.captured,0);assert.equal(second.duplicates,1);assert.equal(store.read().reports[0].id,reportId);
  store.reset();const afterReset=await bridge.pollOnce();assert.equal(afterReset.captured,0);assert.equal(store.read().reports.length,0);assert.equal(receipts(ledger)[0].reportId,reportId);
});

test('unknown identities, unsupported content and unapproved or conflicting text remain private quarantine only',async t=>{
  const f=fixture(t),unknown=message(1);unknown.sentBy.id=canonical('usr',9);unknown.space.participantIds=[AGENT,unknown.sentBy.id];
  const wrongAgent=message(2);wrongAgent.receivedBy.id=canonical('usr',9);wrongAgent.space.participantIds=[PERSON,wrongAgent.receivedBy.id];
  f.setItems([unknown,wrongAgent,message(3,{content:{type:'image',url:'https://private.invalid/photo'}}),message(4,{content:{type:'text',format:'plain',text:'Private free-form unapproved text'}}),message(5,{content:{type:'text',format:'plain',text:'C105: '+TEXT}}),message(6,{timestamps:{receivedAt:new Date(Date.parse(f.scope.from)-1000).toISOString()}}),message(7,{content:{type:'text',format:'plain',text:'x'.repeat(3001)}})]);
  const before=f.store.read(),result=await f.create().pollOnce();assert.equal(result.captured,0);assert.equal(result.quarantined,7);assert.deepEqual(f.store.read(),before);
  assert.deepEqual(new Set(receipts(f.ledger).map(receipt=>receipt.reason)),new Set(['unknown_identity','wrong_agent','unsupported_content','unapproved_text','case_reference_conflict','outside_test_window','oversized_text']));
  assert.ok(receipts(f.ledger).every(receipt=>receipt.status==='quarantined'));assert.equal(Object.values(f.ledger.read().polls)[0].status,'complete');
});

test('STOP revokes the known alias immediately with null case despite stale case context and no automatic reply',async t=>{
  const f=fixture(t);f.store.act(state=>{state.cases[0].subjectNames='Changed case subjects';});const before=domain(f.store.read());
  f.setItems([message(1,{content:{type:'text',format:'plain',text:' STOP '}})]);const result=await f.create().pollOnce();
  assert.equal(result.captured,1);assert.deepEqual(result.queuedReportIds,[]);const state=f.store.read();assert.equal(state.participants.find(person=>person.id==='neighbor-1').optedIn,false);
  const expected=structuredClone(before);expected.participants.find(person=>person.id==='neighbor-1').optedIn=false;assert.deepEqual(domain(state),expected);
  assert.equal(state.reports[0].caseId,null);assert.equal(state.reports[0].observedAt,null);assert.equal(state.reports[0].modelReview.status,'command_processed');assert.equal(receipts(f.ledger)[0].binding.caseId,null);
});

test('CHECKIN remains review-only and never reenrolls or produces a model/reply job',async t=>{
  const f=fixture(t);f.store.act(state=>{state.participants.find(person=>person.id==='neighbor-1').optedIn=false;});const before=domain(f.store.read());f.setItems([message(1,{content:{type:'text',format:'plain',text:'CHECKIN'}})]);
  const result=await f.create().pollOnce();assert.deepEqual(result.queuedReportIds,[]);assert.equal(f.store.read().reports[0].modelReview.status,'command_review');assert.deepEqual(domain(f.store.read()),before);
});

test('a journal-only crash resumes approved raw work, retaining original IDs and completing only terminal receipts',async t=>{
  const f=fixture(t),raw=message(),scopeId=photonScopeFingerprint(f.scope);
  f.ledger.journalRaw({projectId:PROJECT,platform:'imessage',messageId:raw.id,envelope:raw,scopeId,mappingSetHash:hash(f.ledger.mappings())});
  const result=await f.create().pollOnce();assert.equal(result.captured,1);assert.equal(f.store.read().reports.length,1);assert.equal(receipts(f.ledger)[0].status,'captured');
});

test('crash after Store commit but before ledger acknowledgment recovers without repeating domain effects',async t=>{
  const f=fixture(t);f.setItems([message()]);f.ledger.markCaptured=()=>{throw new Error('private acknowledgment failure');};
  await assert.rejects(f.create().pollOnce(),error=>!String(error).includes('private acknowledgment'));assert.equal(f.store.read().reports.length,1);assert.equal(receipts(f.ledger)[0].status,'capturing');const reportId=f.store.read().reports[0].id;
  const store=new Store(f.storePath),ledger=new ProviderLedger(f.ledgerPath);const result=await f.create({store,ledger}).pollOnce();assert.equal(store.read().reports.length,1);assert.equal(store.read().reports[0].id,reportId);assert.ok(result.queuedReportIds.includes(reportId));assert.equal(receipts(ledger)[0].status,'captured');
});

test('an ambiguous capture intent cannot replay an old event into a reset exercise',async t=>{
  const f=fixture(t);f.setItems([message()]);f.ledger.markCaptured=()=>{throw new Error('ack failure');};await assert.rejects(f.create().pollOnce());f.store.reset();
  const ledger=new ProviderLedger(f.ledgerPath);await f.create({ledger}).pollOnce();assert.equal(f.store.read().reports.length,0);assert.equal(receipts(ledger)[0].status,'quarantined');assert.equal(receipts(ledger)[0].reason,'capture_outcome_unknown');
});

test('Store capture failure retains raw text privately and never advances past a pending receipt',async t=>{
  const f=fixture(t);f.setItems([message()]);f.store.act=()=>{throw new Error('private failure payload');};const result=await f.create().pollOnce();
  assert.equal(result.captured,0);assert.equal(result.quarantined,1);assert.equal(receipts(f.ledger)[0].reason,'capture_failed');assert.equal(receipts(f.ledger)[0].envelope.content.text,TEXT);assert.equal(f.store.read().reports.length,0);
  assert.doesNotMatch(JSON.stringify(result),/private failure payload/);assert.equal(Object.values(f.ledger.read().polls)[0].status,'complete');
});

test('a failed private capture-intent save cannot mutate Store or complete the poll',async t=>{
  const f=fixture(t);f.setItems([message()]);f.ledger.beginCapture=()=>{throw new ProviderLedgerError('storage_failed');};
  await assert.rejects(f.create().pollOnce(),{code:'storage_failed'});assert.equal(f.store.read().reports.length,0);assert.equal(receipts(f.ledger)[0].status,'pending');assert.equal(Object.values(f.ledger.read().polls)[0].status,'failed');
  const ledger=new ProviderLedger(f.ledgerPath);await f.create({ledger}).pollOnce();assert.equal(f.store.read().reports.length,1);assert.equal(receipts(ledger)[0].status,'captured');
});

test('partial private identity records cannot bypass explicit configuration or publish raw sender data',async t=>{
  const f=fixture(t);const invalid={...f.identity};delete invalid.approvedTextHashes;f.ledger.setMappings([invalid]);f.setItems([message()]);
  const result=await f.create().pollOnce();assert.equal(result.quarantined,1);assert.equal(receipts(f.ledger)[0].reason,'invalid_mapping');assert.equal(f.store.read().reports.length,0);
});

test('changed provider content under a captured identity never replaces the source report',async t=>{
  const f=fixture(t);const first=message();f.setItems([first]);await f.create().pollOnce();const before=f.store.read();
  f.setItems([{...first,content:{...first.content,text:'Changed message under the same provider ID'}}]);const result=await f.create().pollOnce();assert.equal(result.quarantined,1);assert.deepEqual(f.store.read(),before);assert.equal(receipts(f.ledger)[0].conflicts.length,1);
});

test('in-flight case and private mapping changes cannot reinterpret a message for another case',async t=>{
  for(const kind of ['case','mapping']){
    const f=fixture(t),gate={};const pending=new Promise(resolve=>{gate.resolve=resolve;});const bridge=f.create({client:{listReceived:()=>pending}}),running=bridge.pollOnce();
    if(kind==='case')f.store.act(state=>{state.cases[0].subjectNames='Different case subjects';});
    else f.ledger.setMappings([{...f.identity,fixtureAlias:'neighbor-2'}]);
    gate.resolve({platform:'imessage',pages:1,items:[message()]});await running;assert.equal(f.store.read().reports.length,0);assert.equal(receipts(f.ledger)[0].reason,kind==='case'?'case_changed':'invalid_mapping');
  }
});

test('poll budgets persist failed attempts across restart and out-of-window scopes make no new calls',async t=>{
  const f=fixture(t,{maxPolls:1});let calls=0;const client={listReceived:async()=>{calls++;throw new Error('private provider error');}};
  await assert.rejects(f.create({client}).pollOnce(),error=>error.code==='poll_failed'&&!String(error).includes('private provider'));
  const ledger=new ProviderLedger(f.ledgerPath);assert.equal((await f.create({ledger,client}).pollOnce()).reason,'poll_limit');assert.equal(calls,1);
  const oldScope={...f.scope,from:new Date(Date.now()-120000).toISOString(),to:new Date(Date.now()-60000).toISOString()};assert.equal((await f.create({scope:oldScope,client}).pollOnce()).reason,'outside_window');assert.equal(calls,1);
});

test('one bounded poll owns the in-flight slot and ignores a late transport after timeout',async t=>{
  const f=fixture(t);let finish,seenSignal;const client={listReceived:options=>{seenSignal=options.signal;return new Promise(resolve=>{finish=resolve;});}};
  const bridge=f.create({client,timeoutMs:50}),first=bridge.pollOnce();assert.equal((await bridge.pollOnce()).reason,'busy');await assert.rejects(first,{code:'poll_timeout'});assert.equal(seenSignal.aborted,true);
  finish({platform:'imessage',pages:1,items:[message()]});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.store.read().reports.length,0);assert.equal(receipts(f.ledger).length,0);
});

test('result bounds fail closed before intake and cancellation makes no provider request',async t=>{
  const f=fixture(t,{maxMessages:1}),client={listReceived:async()=>({platform:'imessage',pages:1,items:[message(1),message(2)]})};
  await assert.rejects(f.create({client}).pollOnce(),{code:'poll_failed'});assert.equal(f.store.read().reports.length,0);assert.equal(receipts(f.ledger).length,0);
  const controller=new AbortController();controller.abort();assert.equal((await f.create().pollOnce({signal:controller.signal})).reason,'cancelled');assert.equal(f.calls.length,0);
});

test('case fingerprints and exact scope identities cannot be guessed from message names or receipt time',t=>{
  const f=fixture(t);assert.equal(fixtureCaseFingerprint(f.store.read(),null),null);assert.equal(fixtureCaseFingerprint(f.store.read(),'C104'),f.identity.caseFingerprint);
  assert.throws(()=>bindPhotonIdentity(f.store.read(),{...f.identity,fixtureAlias:'+12125550199'}));assert.throws(()=>bindPhotonIdentity(f.store.read(),{...f.identity,caseId:'C999'}));
  assert.notEqual(photonScopeFingerprint(f.scope),photonScopeFingerprint({...f.scope,id:'another-approved-run'}));
});
