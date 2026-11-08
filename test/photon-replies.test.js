import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderLedger} from '../src/provider-ledger.js';
import {fixtureCaseFingerprint, photonScopeFingerprint, bindPhotonIdentity} from '../src/photon-inbox.js';
import {Store} from '../src/store.js';
import {captureRawReport} from '../src/report-inbox.js';
import {createPhotonReplies, PhotonReplyError} from '../src/photon-replies.js';

const id = (kind, n) => 'pho_' + kind + '_' + String(n).padStart(26, '0');
const projectId = id('prj', 1), personUsrId = id('usr', 2), agentUsrId = id('usr', 3), spaceId = id('spc', 4);
const parentId = id('msg', 5), outgoingId = id('msg', 6);
const text = 'Beacon received your fictional exercise report.';
const raw = 'Synthetic exercise: the library needs water.';
const now = Date.now();
const scope = {id:'phone-test', platform:'imessage', dataClass:'synthetic', projectId, agentUsrId,
  from:new Date(now - 1000).toISOString(), to:new Date(now + 120000).toISOString(),
  maxPages:1, maxMessages:5, maxPolls:1};
const approval = {personUsrId,spaceId,fixtureAlias:'neighbor-1',caseId:'C104',text,maxSendRequests:2,maxDeliveryChecks:3};
const sentBy = {id:personUsrId, projectId, kind:'human', platform:'imessage', handle:'+15550009999'};
const receivedBy = {id:agentUsrId, projectId, kind:'agent', platform:'imessage', handle:'private-fixture@example.invalid'};
const incoming = {id:parentId,projectId,platform:'imessage',status:'received',sentBy,receivedBy,
  space:{id:spaceId,projectId,kind:'direct',platform:'imessage',participantIds:[agentUsrId,personUsrId]},
  timestamps:{receivedAt:new Date(now).toISOString()},createdAt:new Date(now).toISOString(),
  content:{type:'text',format:'plain',text:raw}};
const envelope = (status,id=outgoingId,platform='imessage') => ({id,platform,status,delivered:status==='delivered',
  message:{id,projectId,platform,status}});
const rejects = code => error => error instanceof PhotonReplyError && error.code === code &&
  !error.message.includes('15550009999') && !error.message.includes('credential');

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'beacon-fixture-replies-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'private-ledger.json'), store=new Store(join(dir,'exercise.json'));
  const ledger=new ProviderLedger(path);
  const identity=bindPhotonIdentity(store.read(),{projectId,platform:'imessage',personUsrId,agentUsrId,spaceId,
    fixtureAlias:approval.fixtureAlias,caseId:approval.caseId,approvedTexts:[raw]});
  ledger.setMappings([identity]);
  const {receipt}=ledger.journalRaw({projectId,platform:'imessage',messageId:parentId,
    envelope:incoming,scopeId:photonScopeFingerprint(scope)});
  ledger.bindReceipt(receipt.key,{identityId:identity.id,projectId,platform:'imessage',personUsrId,spaceId,agentUsrId,fixtureAlias:identity.fixtureAlias,
    caseId:identity.caseId,caseFingerprint:fixtureCaseFingerprint(store.read(),identity.caseId),
    mappingFingerprint:createHash('sha256').update(JSON.stringify(identity)).digest('hex')});
  const {reportId}=store.act(captureRawReport,{provider:'photon',projectId,messageId:parentId,
    dataClass:'synthetic',senderId:identity.fixtureAlias,caseId:identity.caseId,text:raw});
  const report = store.read().reports.find(r=>r.id===reportId);
  ledger.beginCapture(receipt.key,{providerEventId:report.providerEventId,caseFingerprint:identity.caseFingerprint});
  ledger.markCaptured(receipt.key,{reportId});
  const calls=[];
  const client={reply:async arg=>{calls.push(arg);return envelope('accepted');},
    getDelivery:async id=>{calls.push({id});return envelope('delivered');}};
  const api=(extra={})=>createPhotonReplies({enabled:true,store,ledger,client,scope,approval,
    now:()=>now,timeoutMs:100,...extra});
  return {api,store,ledger,path,reportId,client,calls,key:receipt.key};
}
function prepare(f) { return f.api().prepare({reportId:f.reportId,text}); }
const args = f=>({reportId:f.reportId});

test('disabled, missing approval and edited wording never schedule a send', async t=>{
  const f=fixture(t);
  assert.throws(()=>f.api({enabled:false}).prepare({...args(f),text}),rejects('disabled'));
  assert.throws(()=>f.api({approval:{...approval,maxSendRequests:3}}).prepare({...args(f),text}),rejects('configuration'));
  assert.throws(()=>f.api().prepare({...args(f),text:text+' ' }),rejects('wording'));
  await assert.rejects(f.api().send(args(f)),rejects('approval_changed'));
  assert.equal(f.calls.length,0);
  assert.equal(Object.keys(f.ledger.read().replyJobs).length,0);
});
test('only explicitly approved reply uses receiving agent, exact text and saved key; acceptance requires a separate delivery read',async t=>{
  const f=fixture(t), before=f.store.read(), original=prepare(f);
  assert.deepEqual(prepare(f),original);
  const queued=await f.api().send(args(f));
  assert.deepEqual(queued,{reportId:f.reportId,status:'accepted',attempts:1,deliveryChecks:0,delivered:false});
  assert.deepEqual(await f.api().send(args(f)),queued);
  const [{signal,...body}]=f.calls;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(body,{spaceId,senderId:agentUsrId,parentMessageId:parentId,text,
    idempotencyKey:f.ledger.read().replyJobs[f.key].idempotencyKey});
  assert.equal(f.calls.length,1);
  const done=await f.api().checkDelivery(args(f));
  assert.equal(done.delivered,true);
  assert.deepEqual(await f.api().checkDelivery(args(f)),done);
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.store.read(),before);
  for (const secret of [projectId,personUsrId,agentUsrId,spaceId,text,raw,sentBy.handle,body.idempotencyKey])
    assert.equal(JSON.stringify(done).includes(secret),false);
});
test('timeout or ambiguous crash requires affirmative manual retry; restart reuses identical key with a lifetime two-request cap',async t=>{
  const f=fixture(t);prepare(f);
  const keys=[];
  const failing={...f.client,reply:({idempotencyKey})=>{keys.push(idempotencyKey);return new Promise(()=>{});}};
  assert.equal((await f.api({client:failing,timeoutMs:5}).send(args(f))).status,'unknown');
  const ledger=new ProviderLedger(f.path), resumed=f.api({ledger,client:failing,timeoutMs:5});
  await assert.rejects(resumed.send(args(f)),rejects('manual_retry_required'));
  assert.equal((await resumed.send({...args(f),manualRetry:true})).status,'unknown');
  assert.deepEqual(keys,[keys[0],keys[0]]);
  await assert.rejects(resumed.send({...args(f),manualRetry:true}),rejects('budget'));
});
test('crash after reservation only allows manual retry with the persisted key',async t=>{
  const f=fixture(t);prepare(f);
  f.ledger.act(s=>{const j=s.replyJobs[f.key];j.status='sending';j.attempts=1;j.token='abandoned';});
  const resumed=f.api({ledger:new ProviderLedger(f.path)});
  await assert.rejects(resumed.send(args(f)),rejects('manual_retry_required'));
  assert.equal((await resumed.send({...args(f),manualRetry:true})).attempts,2);
  assert.equal(f.calls[0].idempotencyKey,f.ledger.read().replyJobs[f.key].idempotencyKey);
});
test('duplicate/concurrent sends reserve once even across wrappers sharing the ledger',async t=>{
  const f=fixture(t);prepare(f);let done;
  const slow={...f.client,reply:()=>new Promise(resolve=>{done=resolve;})};
  const first=f.api({client:slow}).send(args(f));
  await assert.rejects(f.api().send({...args(f),manualRetry:true}),rejects('busy'));
  done(envelope('delivered'));
  assert.equal((await first).delivered,false);
  assert.equal(f.ledger.read().replyJobs[f.key].attempts,1);
});
for (const [label,change,code] of [
  ['current alias opted out', f=>f.store.act(s=>{s.participants.find(p=>p.id===approval.fixtureAlias).optedIn=false;}),'consent'],
  ['journaled STOP before capture', f=>f.ledger.journalRaw({projectId,platform:'imessage',messageId:id('msg',7),
    envelope:{...incoming,id:id('msg',7),content:{type:'text',format:'plain',text:' STOP '}},
    scopeId:photonScopeFingerprint(scope)}),'consent'],
  ['conflicting payload under the same provider ID',f=>f.ledger.journalRaw({projectId,platform:'imessage',messageId:parentId,
    envelope:{...incoming,content:{type:'text',format:'plain',text:'conflict'}},scopeId:photonScopeFingerprint(scope)}),'route_changed'],
  ['route rebound', f=>f.ledger.act(s=>{s.identities[0].spaceId=id('spc',99);}),'route_changed'],
  ['report content changed',f=>f.store.act(s=>{s.reports.find(r=>r.id===f.reportId).text='edited';}),'source_changed'],
  ['case replaced',f=>f.store.act(s=>{s.cases[0].createdAt='2000-01-01T00:00:00Z';}),'source_changed'],
  ['public provider identity swapped',f=>f.store.act(s=>{s.reports.find(r=>r.id===f.reportId).providerIdentity.messageId=id('msg',8);}),'source_changed'],
]) {
  test(label+' prevents dispatch after approval',async t=>{
    const f=fixture(t);prepare(f);change(f);
    await assert.rejects(f.api().send(args(f)),rejects(code));assert.equal(f.calls.length,0);
  });
}
test('time window, platform and alternate wording cannot inherit a previous approval',async t=>{
  const f=fixture(t);prepare(f);
  await assert.rejects(f.api({now:()=>Date.parse(scope.to)+1}).send(args(f)),rejects('outside_window'));
  await assert.rejects(f.api({scope:{...scope,platform:'sms'}}).send(args(f)),rejects('configuration'));
  await assert.rejects(f.api({approval:{...approval,text:'Different response.'}}).send(args(f)),rejects('approval_changed'));
  assert.equal(f.calls.length,0);
});
test('consent changed after reserve but before network never sends',async t=>{
  const f=fixture(t);prepare(f);
  const act=f.ledger.act.bind(f.ledger);let first=true;
  f.ledger.act=(...args)=>{
    const result=act(...args);
    if(first){first=false;f.store.act(s=>{s.participants.find(p=>p.id===approval.fixtureAlias).optedIn=false;});}
    return result;
  };
  const result=await f.api().send(args(f));
  assert.equal(result.delivered,false);assert.equal(f.calls.length,0);
});
test('unknown POST responses redact sensitive provider diagnostics and never adopt another platform',async t=>{
  const f=fixture(t);prepare(f);
  const client={...f.client,reply:async()=>{throw Error('private-credential '+sentBy.handle);}};
  const first=await f.api({client}).send(args(f));assert.equal(first.status,'unknown');
  assert.equal(JSON.stringify(first).includes(sentBy.handle),false);
  const second=await f.api({client:{...f.client,reply:async()=>envelope('accepted',outgoingId,'sms')}})
    .send({...args(f),manualRetry:true});
  assert.equal(second.status,'unknown');assert.equal(second.delivered,false);
});
test('only matching project, channel and outgoing ID can confirm delivery; checks are bounded across restart',async t=>{
  const f=fixture(t);prepare(f);await f.api().send(args(f));
  for (const value of [envelope('delivered',parentId),envelope('delivered',outgoingId,'sms'),
    {...envelope('delivered'),message:{...envelope('delivered').message,projectId:id('prj',9)}}]) {
    const result=await f.api({client:{...f.client,getDelivery:async()=>value}}).checkDelivery(args(f));
    assert.equal(result.status,'delivery_unknown');assert.equal(result.delivered,false);
  }
  await assert.rejects(f.api({ledger:new ProviderLedger(f.path)}).checkDelivery(args(f)),rejects('budget'));
});
test('negative delivery result is terminal and cannot be sent again',async t=>{
  const f=fixture(t),before=f.store.read();prepare(f);await f.api().send(args(f));
  const api=f.api({client:{...f.client,getDelivery:async()=>envelope('failed')}});
  const failed=await api.checkDelivery(args(f));
  assert.equal(failed.status,'failed');assert.equal(failed.delivered,false);
  assert.deepEqual(await api.send({...args(f),manualRetry:true}),failed);
  assert.deepEqual(f.store.read(),before);
});
test('set a stricter one-attempt cap across restart',async t=>{
  const f=fixture(t);
  const api=f.api({approval:{...approval,maxSendRequests:1},
    client:{...f.client,reply:async()=>{throw Error('network');}}});
  api.prepare({...args(f),text});
  assert.equal((await api.send(args(f))).status,'unknown');
  await assert.rejects(api.send({...args(f),manualRetry:true}),rejects('budget'));
});

test('receipt captured by the actual polling bridge can be explicitly approved and sent',async t=>{
  const {createPhotonInbox,adaptPhotonMessage}=await import('../src/photon-inbox.js');
  const f=fixture(t), message={...incoming,id:id('msg',12)};
  const bridge=createPhotonInbox({enabled:true,store:f.store,ledger:f.ledger,scope,
    messageAdapter:msg=>adaptPhotonMessage(msg,{providerTimestamp:msg.timestamps.receivedAt}),
    client:{listReceived:async()=>({platform:'imessage',items:[message],pages:1})}});
  const poll=await bridge.pollOnce();
  assert.equal(poll.captured,1);
  const reportId=poll.reportIds[0], api=f.api(), prepared=api.prepare({reportId,text});
  assert.deepEqual(api.status({reportId}),prepared);
  assert.equal((await api.send({reportId})).status,'accepted');
  assert.equal(f.calls[0].parentMessageId,message.id);
  assert.equal(f.calls[0].senderId,agentUsrId);
});
test('explicit delivery read for the wrong direct space cannot confirm a reply',async t=>{
  const f=fixture(t);prepare(f);await f.api().send(args(f));
  const record=envelope('delivered');record.message.space={id:id('spc',55)};
  const api=f.api({client:{...f.client,getDelivery:async()=>record}});
  assert.equal((await api.checkDelivery(args(f))).status,'delivery_unknown');
});

test('a POST that reports failure is terminal across restart without another send or delivery read',async t=>{
  const f=fixture(t);prepare(f);
  const client={...f.client,reply:async arg=>{f.calls.push(arg);return envelope('failed');}};
  const failed=await f.api({client}).send(args(f));
  assert.deepEqual(failed,{reportId:f.reportId,status:'failed',attempts:1,deliveryChecks:0,delivered:false});
  const ledger=new ProviderLedger(f.path);
  assert.equal(ledger.read().replyJobs[f.key].providerMessageId,outgoingId);
  const resumed=f.api({ledger,client});
  assert.deepEqual(await resumed.send({...args(f),manualRetry:true}),failed);
  assert.deepEqual(await resumed.checkDelivery(args(f)),failed);
  assert.equal(f.calls.length,1);
});

test('quarantined numeric text on the same phone route does not block an approved reply',async t=>{
  const f=fixture(t);
  prepare(f);
  const messageId=id('msg',19);
  const {receipt}=f.ledger.journalRaw({projectId,platform:'imessage',messageId,
    envelope:{...incoming,id:messageId,content:{type:'text',format:'plain',text:42}},
    scopeId:photonScopeFingerprint(scope)});
  f.ledger.markQuarantined(receipt.key,'unsupported_content');

  const result=await f.api().send(args(f));
  assert.equal(result.status,'accepted');
  assert.equal(result.delivered,false);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].parentMessageId,parentId);
  assert.equal(f.ledger.read().receipts[receipt.key].status,'quarantined');
});
