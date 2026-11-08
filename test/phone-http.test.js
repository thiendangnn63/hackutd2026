import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';
import {openCase} from '../src/domain.js';
import {ProviderLedger} from '../src/provider-ledger.js';
import {bindPhotonIdentity} from '../src/photon-inbox.js';
import {createPhoneRuntime,PhoneRuntimeError} from '../src/phone-runtime.js';

async function server(t,{phone=null,store=new Store()}={}){
  const app=createApp(store,undefined,undefined,{phone}),sockets=new Set();
  app.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{await phone?.shutdown?.();await new Promise(resolve=>{for(const socket of sockets)socket.destroy();app.close(resolve);});});
  const port=app.address().port,origin=`http://127.0.0.1:${port}`;
  function call(path,{method='GET',body,headers={}}={}){
    return new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method,headers:{...(method==='POST'?{origin,'content-type':'application/json'}:{}),...headers}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=null;}resolve({status:res.statusCode,headers:res.headers,data,text});});
      });req.on('error',reject);if(body!==undefined)req.write(typeof body==='string'?body:JSON.stringify(body));req.end();
    });
  }
  return {call,store,origin};
}
const reportId='R-http-fixture';
const paths=['/api/phone/listen','/api/phone/stop','/api/phone/poll',`/api/reports/${reportId}/interpret`,`/api/reports/${reportId}/reply/prepare`,`/api/reports/${reportId}/reply/send`,`/api/reports/${reportId}/reply/delivery`];
function fakePhone(){
  const calls=[],state={enabled:true,phoneConfigured:true,modelConfigured:true,listening:false,sendingEnabled:true,mode:'fixture',endsAt:'2099-01-01T00:00:00Z',modelUsed:0,modelLimit:3,replyText:'Fictional receipt acknowledged.',eligibleReportIds:[reportId],replyStates:[]};
  const invoke=(name,result)=>(...args)=>{calls.push({name,args});return structuredClone(result);};
  return {calls,status:()=>structuredClone(state),
    startListening:invoke('listen',{started:true}),stopListening:invoke('stop',{stopped:true}),pollOnce:invoke('poll',{polled:true,captured:1}),
    interpretOne:invoke('interpret',{ran:true,status:'proposal_ready'}),prepareReply:invoke('prepare',{reportId,status:'prepared',delivered:false}),
    sendReply:invoke('send',{reportId,status:'accepted',delivered:false}),checkDelivery:invoke('delivery',{reportId,status:'delivered',delivered:true})};
}
test('default server phone routes remain off with unchanged simulation state and health',async t=>{
  const {call,store}=await server(t),before=store.read(),status=await call('/api/phone/status');
  assert.equal(status.status,200);assert.deepEqual(status.data,{enabled:false,phoneConfigured:false,modelConfigured:false,listening:false,sendingEnabled:false,mode:'offline',endsAt:null,modelUsed:0,modelLimit:3,replyText:null,eligibleReportIds:[],replyStates:[]});
  assert.deepEqual((await call('/api/health')).data,{ok:true,mode:'simulation',liveSendingEnabled:false});
  for(const path of paths){const result=await call(path,{method:'POST',body:{}});assert.equal(result.status,409);assert.deepEqual(result.data,{error:'The phone and model test is not configured.'});}
  assert.deepEqual(store.read(),before);assert.equal(store.version.revision,0);
});

test('same-origin phone commands delegate only their exact action and retain versioned full-state response shape',async t=>{
  const phone=fakePhone(),{call,store}=await server(t,{phone}),before=store.read();
  assert.equal((await call('/api/health')).data.liveSendingEnabled,false);
  for(const [index,path] of paths.entries()){
    const result=await call(path,{method:'POST',body:{}});assert.equal(result.status,200,path);
    assert.deepEqual(result.data.cases,before.cases);assert.deepEqual(result.data.assistance,[]);assert.deepEqual(result.data.outbox,[]);
    assert.equal(result.headers['x-beacon-session'],store.version.sessionId);assert.equal(result.headers['x-beacon-revision'],'0');
    assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['x-content-type-options'],'nosniff');
    assert.match(result.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.deepEqual(result.data.phone,phone.status());assert.equal(phone.calls.length,index+1);
  }
  assert.deepEqual(phone.calls.map(call=>call.name),['listen','stop','poll','interpret','prepare','send','delivery']);
  assert.deepEqual(phone.calls.slice(0,3).map(call=>call.args),[[],[],[]]);
  assert.deepEqual(phone.calls[3].args,[reportId]);assert.deepEqual(phone.calls[4].args,[reportId]);
  assert.deepEqual(phone.calls[5].args,[reportId,{manualRetry:false}]);assert.deepEqual(phone.calls[6].args,[reportId]);
  await call(paths[5],{method:'POST',body:{manualRetry:true}});assert.deepEqual(phone.calls.at(-1).args,[reportId,{manualRetry:true}]);
  assert.deepEqual(store.read(),before);
});

test('phone status and commands reject wrong hosts/origins before controller invocation',async t=>{
  const phone=fakePhone(),{call,store}=await server(t,{phone}),before=store.read();
  for(const headers of [{host:'evil.test'},{host:'127.0.0.1.evil.test'},{origin:'https://evil.test'},{origin:'null'}]){
    assert.equal((await call('/api/phone/status',{headers})).status,403);
    for(const path of paths)assert.equal((await call(path,{method:'POST',body:{},headers})).status,403,path);
  }
  for(const path of paths)assert.equal((await call(path,{method:'POST',body:{},headers:{origin:''}})).status,403);
  assert.deepEqual(phone.calls,[]);assert.deepEqual(store.read(),before);
});

test('strict phone payloads reject injected routing/credentials/text and invalid retry flags before delegation',async t=>{
  const phone=fakePhone(),{call}=await server(t,{phone});
  for(const path of paths){
    for(const body of [{to:'+15555550100'},{text:'Unapproved wording'},{apiKey:'fixture-secret'},{reportId:'R-other'},{force:true},{scope:'fixture'}]){
      assert.equal((await call(path,{method:'POST',body})).status,400,path);
    }
    if(!path.endsWith('/send'))assert.equal((await call(path,{method:'POST',body:{manualRetry:true}})).status,400,path);
  }
  for(const manualRetry of ['true',1,null,{},[]])assert.equal((await call(paths[5],{method:'POST',body:{manualRetry}})).status,400);
  assert.deepEqual(phone.calls,[]);
});

test('phone actions reject malformed JSON, non-object or oversized bodies and non-JSON MIME types',async t=>{
  const phone=fakePhone(),{call}=await server(t,{phone});
  for(const body of ['{broken','[]','null','true','12','"text"'])assert.equal((await call('/api/phone/poll',{method:'POST',body})).status,400);
  assert.equal((await call('/api/phone/poll',{method:'POST',body:{text:'x'.repeat(17000)}})).status,413);
  for(const type of ['text/plain','application/x-www-form-urlencoded','application/json-bogus'])assert.equal((await call('/api/phone/poll',{method:'POST',body:{},headers:{'content-type':type}})).status,415,type);
  assert.deepEqual(phone.calls,[]);
  assert.equal((await call('/api/phone/poll',{method:'POST',body:{},headers:{'content-type':'application/json; charset=utf-8'}})).status,200);
});

test('phone action queries and unknown route/method variants cannot invoke a command',async t=>{
  const phone=fakePhone(),{call}=await server(t,{phone});
  assert.equal((await call('/api/phone/status?key=fixture')).status,400);
  for(const path of paths){assert.equal((await call(`${path}?scope=fixture`,{method:'POST',body:{}})).status,400);assert.equal((await call(path)).status,404);}
  for(const path of ['/api/phone/status','/api/phone/send','/api/phone/poll/extra','/api/reports/R-/interpret','/api/reports/R-test/reply','/api/reports/R-test/reply/send/extra','/api/reports/R-test%2Fother/interpret'])assert.equal((await call(path,{method:'POST',body:{}})).status,404,path);
  assert.equal((await call('/api/phone/poll',{method:'DELETE'})).status,404);assert.deepEqual(phone.calls,[]);
});

test('safe runtime policy errors map to409 and unexpected errors return generic500 without private diagnostics',async t=>{
  const phone=fakePhone();phone.pollOnce=async()=>{throw new PhoneRuntimeError('outside_window');};
  phone.sendReply=async()=>{throw new PhoneRuntimeError('reply_failed');};phone.prepareReply=()=>{throw new Error('PRIVATE provider key and handle@fixture.test');};
  t.mock.method(console,'error',()=>{});const {call}=await server(t,{phone});
  const expired=await call('/api/phone/poll',{method:'POST',body:{}});assert.equal(expired.status,409);assert.deepEqual(expired.data,{error:'The approved phone-test window is not active.'});
  const reply=await call(paths[5],{method:'POST',body:{}});assert.equal(reply.status,409);assert.deepEqual(reply.data,{error:'The reviewed reply operation could not complete.'});
  const unexpected=await call(paths[4],{method:'POST',body:{}});assert.equal(unexpected.status,500);assert.doesNotMatch(unexpected.text,/PRIVATE|provider key|handle@fixture/);
});

const photonId=(kind,value)=>`pho_${kind}_${String(value).padStart(26,'0')}`;
async function runtime(t,{rejectPoll=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'beacon-phone-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new Store(),ledger=new ProviderLedger(join(dir,'private.json'));
  const {caseId}=store.act(openCase,{subjectNames:'Rosa and Miguel Santos',description:'Fictional grandparents inquiry.',reporterId:'mom',lastKnownTile:'A1',lastContactAt:'2026-11-07T12:00:00Z',searchTiles:['A1'],consentToOutreach:true});
  const projectId=photonId('prj',1),personUsrId=photonId('usr',2),agentUsrId=photonId('usr',3),spaceId=photonId('spc',4),inboundId=photonId('msg',10),outboundId=photonId('msg',20),now=Date.now();
  const source='I saw Rosa and Miguel at Oak School.',replyText='Fictional report received for human review. No assistance has been assigned.';
  const scope={id:'synthetic-http-test',projectId,platform:'imessage',agentUsrId,dataClass:'synthetic',from:new Date(now-60_000).toISOString(),to:new Date(now+600_000).toISOString(),maxPages:1,maxMessages:5,maxPolls:3};
  ledger.setMappings([bindPhotonIdentity(store.read(),{projectId,platform:'imessage',personUsrId,spaceId,agentUsrId,fixtureAlias:'neighbor-1',caseId,approvedTexts:[source]})]);
  const envelope={id:inboundId,projectId,platform:'imessage',status:'received',createdAt:new Date(now).toISOString(),timestamps:{receivedAt:new Date(now).toISOString()},space:{id:spaceId,projectId,platform:'imessage',kind:'direct',participantIds:[personUsrId,agentUsrId]},sentBy:{id:personUsrId,kind:'human',projectId,platform:'imessage',handle:'private-real-person@fixture.test'},receivedBy:{id:agentUsrId,kind:'agent',projectId,platform:'imessage',handle:'private-agent-line@fixture.test'},content:{type:'text',format:'plain',text:source}};
  const calls={poll:0,model:0,send:0,delivery:0},response=status=>({id:outboundId,platform:'imessage',status,delivered:status==='delivered',message:{id:outboundId,projectId,platform:'imessage',status,space:{id:spaceId},sentBy:{id:agentUsrId,handle:'private-agent-line@fixture.test'},privateCredential:'private-provider-diagnostic'}});
  const client={enabled:true,async listReceived(){calls.poll++;if(rejectPoll)throw new Error('PRIVATE phone credential handle@fixture.test');return {platform:'imessage',items:[structuredClone(envelope)],pages:1};},async reply(input){calls.send++;assert.equal(input.text,replyText);assert.equal(input.parentMessageId,inboundId);assert.match(input.idempotencyKey,/^beacon-reply-/);return response('accepted');},async getDelivery(){calls.delivery++;return response('delivered');}};
  const modelClient={async extract(input){calls.model++;assert.equal(input.dataClass,'synthetic');return {observations:[{type:'sighting',sourceSpan:'I saw Rosa and Miguel at Oak School',quantity:null,location:'Oak School'}],reviewFlags:[]};}};
  const phone=createPhoneRuntime({enabled:true,store,ledger,client,modelClient,scope,replyApproval:{personUsrId,spaceId,fixtureAlias:'neighbor-1',caseId,text:replyText,maxSendRequests:2,maxDeliveryChecks:2},mode:'fixture'});
  return {...await server(t,{phone,store}),phone,ledger,calls,source,replyText};
}

test('actual injected runtime keeps poll/interpretation, prepare, send acceptance and delivery as separate HTTP actions',async t=>{
  const system=await runtime(t),before=system.store.read();
  const polled=await system.call('/api/phone/poll',{method:'POST',body:{}});assert.equal(polled.status,200);
  assert.deepEqual(system.calls,{poll:1,model:1,send:0,delivery:0});const id=polled.data.phoneAction.reportIds[0];assert.ok(id);
  assert.equal(polled.data.reports[0].modelReview.status,'proposal_ready');assert.deepEqual(polled.data.reports[0].observations,[]);
  const sendPath=`/api/reports/${id}/reply/send`;
  assert.equal((await system.call(sendPath,{method:'POST',body:{}})).status,409);assert.equal(system.calls.send,0);
  const prepared=await system.call(`/api/reports/${id}/reply/prepare`,{method:'POST',body:{}});
  assert.equal(prepared.status,200);assert.equal(prepared.data.phoneAction.status,'prepared');assert.equal(system.calls.send,0);
  const accepted=await system.call(sendPath,{method:'POST',body:{}});assert.equal(accepted.status,200);assert.equal(accepted.data.phoneAction.status,'accepted');assert.equal(accepted.data.phoneAction.delivered,false);assert.equal(system.calls.send,1);assert.equal(system.calls.delivery,0);
  const repeated=await system.call(sendPath,{method:'POST',body:{}});assert.equal(repeated.data.phoneAction.status,'accepted');assert.equal(system.calls.send,1);
  const delivered=await system.call(`/api/reports/${id}/reply/delivery`,{method:'POST',body:{}});assert.equal(delivered.status,200);assert.equal(delivered.data.phoneAction.status,'delivered');assert.equal(delivered.data.phoneAction.delivered,true);assert.equal(system.calls.delivery,1);
  for(const field of ['cases','participants','assistance','outbox'])assert.deepEqual(system.store.read()[field],before[field]);
  assert.equal(system.store.read().reports[0].modelReview.status,'proposal_ready');
});

test('actual runtime HTTP status and action responses expose no private identity, receipts, keys or provider diagnostics',async t=>{
  const system=await runtime(t),responses=[];
  responses.push(await system.call('/api/phone/status'));responses.push(await system.call('/api/phone/poll',{method:'POST',body:{}}));
  const id=responses.at(-1).data.phoneAction.reportIds[0];
  for(const action of ['prepare','send','delivery'])responses.push(await system.call(`/api/reports/${id}/reply/${action}`,{method:'POST',body:{}}));
  responses.push(await system.call('/api/phone/status'));responses.push(await system.call('/api/state'));
  for(const response of responses){assert.equal(response.status,200);assert.doesNotMatch(response.text,/private-real-person|private-agent-line|private-provider-diagnostic|idempotencyKey|providerIdentity|claimToken|sourceHash|mappingFingerprint|receiptKey|"receipts"/);}
  assert.equal(responses[1].data.reports[0].text,system.source);assert.equal(responses[0].data.replyText,system.replyText);
  assert.match(JSON.stringify(system.ledger.read()),/private-real-person@fixture\.test/);
});

test('actual runtime sanitizes asynchronous provider failure and keeps saved state available over HTTP',async t=>{
  const system=await runtime(t,{rejectPoll:true}),before=system.store.read();
  const response=await system.call('/api/phone/poll',{method:'POST',body:{}});
  assert.equal(response.status,409);assert.deepEqual(response.data,{error:'The phone poll could not complete. Saved reports remain available.'});
  assert.doesNotMatch(response.text,/PRIVATE|credential|handle@fixture/);assert.deepEqual(system.store.read(),before);
  assert.equal((await system.call('/api/state')).status,200);assert.equal(system.calls.model,0);assert.equal(system.calls.send,0);
});
