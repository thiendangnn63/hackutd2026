import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.js';
import {ProviderLedger} from '../src/provider-ledger.js';
import {bindPhotonIdentity} from '../src/photon-inbox.js';
import {createPhoneRuntime,PhoneRuntimeError} from '../src/phone-runtime.js';
import {validatePhoneConfig,parsePhoneArgs,preparePhoneServer,shutdownPhoneServer} from '../src/phone-server.js';

const canonical=(kind,n=1)=>`pho_${kind}_${String(n).padStart(26,'0')}`;
const PROJECT=canonical('prj'),PERSON=canonical('usr',2),AGENT=canonical('usr'),SPACE=canonical('spc');
const TEXT='I saw Elena at Oak School. They need water for two people and the road is blocked.';
const REPLY='Beacon fictional test: Your report was received for human review. This does not confirm safety or that help has been assigned.';
const proposal={observations:[{type:'sighting',sourceSpan:'I saw Elena at Oak School',quantity:null,location:'Oak School'},{type:'water_need',sourceSpan:'They need water for two people',quantity:2,location:null}],reviewFlags:[]};
const domain=state=>({cases:state.cases,participants:state.participants,assistance:state.assistance,outbox:state.outbox});
function message(n=1,text=TEXT){const at=new Date().toISOString();return {id:canonical('msg',n),projectId:PROJECT,platform:'imessage',status:'received',space:{id:SPACE,projectId:PROJECT,platform:'imessage',kind:'direct',participantIds:[AGENT,PERSON]},sentBy:{id:PERSON,projectId:PROJECT,platform:'imessage',kind:'human',handle:'+12125550199'},receivedBy:{id:AGENT,projectId:PROJECT,platform:'imessage',kind:'agent',handle:'private-agent'},content:{type:'text',format:'plain',text},timestamps:{receivedAt:at},createdAt:at,updatedAt:at};}
function fakeTimers(){let id=0;const queue=new Map();return {setTimeout(fn,delay){const token=++id;queue.set(token,{fn,delay});return token;},clearTimeout(token){queue.delete(token);},size:()=>queue.size,async run(delay){const entry=[...queue.entries()].find(([,value])=>value.delay===delay);assert.ok(entry,'Expected scheduled callback');queue.delete(entry[0]);await entry[1].fn();await new Promise(resolve=>setImmediate(resolve));},async expire(){const entry=[...queue.entries()].sort((a,b)=>b[1].delay-a[1].delay)[0];assert.ok(entry);queue.delete(entry[0]);await entry[1].fn();await new Promise(resolve=>setImmediate(resolve));}};}
function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'beacon-runtime-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new Store(join(dir,'state.json')),ledger=new ProviderLedger(join(dir,'private-ledger.json')),timers=fakeTimers();
  const scope={id:'runtime-fixture',projectId:PROJECT,platform:'imessage',agentUsrId:AGENT,from:new Date(Date.now()-60000).toISOString(),to:new Date(Date.now()+60000).toISOString(),maxPages:1,maxMessages:5,maxPolls:20,dataClass:'synthetic'};
  const identity=bindPhotonIdentity(store.read(),{projectId:PROJECT,platform:'imessage',personUsrId:PERSON,spaceId:SPACE,agentUsrId:AGENT,fixtureAlias:'neighbor-1',caseId:'C104',approvedTexts:[TEXT]});ledger.setMappings([identity]);
  const replyApproval={personUsrId:PERSON,spaceId:SPACE,fixtureAlias:'neighbor-1',caseId:'C104',text:REPLY,maxSendRequests:2,maxDeliveryChecks:4};
  const calls={poll:[],model:[],reply:[],delivery:[]};let next=[];
  const client={enabled:true,async listReceived(value){calls.poll.push(value);return {platform:'imessage',pages:1,items:structuredClone(next)};},async reply(value){calls.reply.push(value);const msg={id:canonical('msg',99),projectId:PROJECT,platform:'imessage',status:'accepted',space:{id:SPACE},sentBy:{id:AGENT},parentMessageId:value.parentMessageId};return {id:msg.id,platform:'imessage',status:'accepted',delivered:false,message:msg};},async getDelivery(id){calls.delivery.push(id);return {id,platform:'imessage',status:'delivered',delivered:true,message:{id,projectId:PROJECT,platform:'imessage',status:'delivered',space:{id:SPACE},sentBy:{id:AGENT},parentMessageId:canonical('msg')}};}};
  const modelClient={async extract(input){calls.model.push(input);return structuredClone(proposal);}};
  const runtime=createPhoneRuntime({enabled:true,store,ledger,client,modelClient,scope,replyApproval,timers,...options});
  return {dir,store,ledger,timers,scope,identity,replyApproval,calls,client,modelClient,runtime,setMessages(value){next=value;}};
}

test('default runtime is inert and disabled without a client, environment or timers',async()=>{
  let calls=0;const timers={setTimeout(){calls++;},clearTimeout(){calls++;}};
  const runtime=createPhoneRuntime({timers});assert.equal(runtime.status().enabled,false);assert.equal(runtime.status().phoneConfigured,false);assert.equal(runtime.status().sendingEnabled,false);assert.deepEqual(runtime.status().eligibleReportIds,[]);
  assert.throws(()=>runtime.startListening(),error=>error instanceof PhoneRuntimeError&&error.status===409);
  await assert.rejects(runtime.pollOnce(),{code:'disabled'});assert.equal(calls,0);
});

test('explicit poll captures raw then interprets with same Store and never prepares or sends replies',async t=>{
  const f=fixture(t),before=domain(f.store.read());f.setMessages([message()]);let updates=0;f.store.onChange(()=>{updates++;});
  assert.equal(f.timers.size(),0);assert.equal(f.calls.poll.length,0);const result=await f.runtime.pollOnce();
  assert.equal(result.captured,1);assert.equal(f.calls.poll.length,1);assert.equal(f.calls.model.length,1);assert.equal(f.calls.reply.length,0);assert.deepEqual(f.ledger.read().replyJobs,{});assert.ok(updates>=3);
  const report=f.store.read().reports[0];assert.equal(report.modelReview.status,'proposal_ready');assert.deepEqual(report.observations,[]);assert.deepEqual(domain(f.store.read()),before);
  const status=f.runtime.status();assert.equal(status.modelUsed,1);assert.equal(status.modelLimit,3);assert.equal(status.source,'injected-fixture');assert.deepEqual(status.eligibleReportIds,[report.id]);assert.equal(status.replyText,REPLY);
  const json=JSON.stringify(status);assert.doesNotMatch(json,/pho_|12125550199|private-agent|sourceHash|receipt|idempotency|claim/);assert.equal(f.timers.size(),0);
});

test('duplicate polls never repeat interpretation and at most three new reports consume model requests',async t=>{
  const f=fixture(t);f.setMessages([message(1),message(2),message(3),message(4)]);await f.runtime.pollOnce();assert.equal(f.calls.model.length,3);assert.equal(f.runtime.status().modelUsed,3);
  await f.runtime.pollOnce();assert.equal(f.calls.model.length,3);assert.equal(f.store.read().reports.length,4);assert.equal(f.runtime.status().counts.queued,1);
  const queued=f.store.read().reports.find(report=>report.modelReview.status==='queued');const result=await f.runtime.interpretOne(queued.id);assert.equal(result.reason,'budget_exhausted');assert.equal(f.calls.model.length,3);
});

test('phone-only configuration retains queued reports without inventing model success',async t=>{
  const f=fixture(t,{modelClient:undefined});f.setMessages([message()]);await f.runtime.pollOnce();assert.equal(f.calls.model.length,0);assert.equal(f.store.read().reports[0].modelReview.status,'queued');assert.equal(f.runtime.status().modelConfigured,false);
});

test('manual reply is an exact separate action and delivery is confirmed only by explicit check',async t=>{
  const f=fixture(t);f.setMessages([message()]);await f.runtime.pollOnce();const id=f.store.read().reports[0].id;
  f.replyApproval.text='Mutated external wording';assert.equal(f.runtime.status().replyText,REPLY);
  const prepared=f.runtime.prepareReply(id);assert.equal(prepared.status,'prepared');assert.equal(f.calls.reply.length,0);
  const sent=await f.runtime.sendReply(id);assert.equal(sent.status,'accepted');assert.equal(sent.delivered,false);assert.equal(f.calls.reply.length,1);assert.equal(f.calls.reply[0].senderId,AGENT);assert.equal(f.calls.reply[0].spaceId,SPACE);assert.equal(f.calls.reply[0].parentMessageId,canonical('msg'));assert.equal(f.calls.reply[0].text,REPLY);
  const delivered=await f.runtime.checkDelivery(id);assert.equal(delivered.status,'delivered');assert.equal(delivered.delivered,true);assert.equal(f.calls.delivery.length,1);
  assert.deepEqual(f.runtime.status().replyStates,[{reportId:id,status:'delivered',attempts:1,deliveryChecks:1,delivered:true}]);assert.doesNotMatch(JSON.stringify(f.runtime.status()),/pho_|12125550199|idempotency/);
});

test('listening returns immediately, schedules only on explicit start and stops after bounded polls',async t=>{
  const f=fixture(t,{listenPollLimit:2});f.setMessages([message()]);const started=f.runtime.startListening();assert.equal(started.started,true);assert.equal(f.calls.poll.length,0);assert.equal(f.timers.size(),2);
  assert.equal(f.runtime.startListening().started,false);await f.timers.run(0);assert.equal(f.calls.poll.length,1);await f.timers.run(3000);assert.equal(f.calls.poll.length,2);assert.equal(f.runtime.status().listening,false);assert.equal(f.timers.size(),0);assert.equal(f.calls.reply.length,0);
});

test('STOP during listening revokes consent and prevents further polls, model calls and sends',async t=>{
  const f=fixture(t);f.setMessages([message()]);f.runtime.startListening();await f.timers.run(0);assert.equal(f.calls.model.length,1);const id=f.store.read().reports[0].id;f.runtime.prepareReply(id);
  f.setMessages([message(2,'STOP')]);await f.timers.run(3000);assert.equal(f.runtime.status().listening,false);assert.equal(f.runtime.status().sendingEnabled,false);assert.equal(f.runtime.status().lastStopReason,'consent_revoked');assert.deepEqual(f.runtime.status().eligibleReportIds,[id]);assert.equal(f.timers.size(),0);assert.equal(f.calls.model.length,1);await assert.rejects(f.runtime.sendReply(id),{code:'reply_failed'});assert.equal(f.calls.reply.length,0);
  const restarted=createPhoneRuntime({enabled:true,store:f.store,ledger:f.ledger,client:f.client,modelClient:f.modelClient,scope:f.scope,replyApproval:f.replyApproval,timers:f.timers});assert.equal(restarted.status().lastStopReason,'consent_revoked');assert.deepEqual(restarted.status().eligibleReportIds,[id]);assert.equal(restarted.status().sendingEnabled,false);
});

test('manual stop and expiry abort an in-flight poll and cancel all listener callbacks',async t=>{
  for(const cause of ['manual','expiry']){
    const f=fixture(t);let resolve,signal;f.client.listReceived=options=>{signal=options.signal;return new Promise(done=>{resolve=done;});};f.runtime.startListening();
    const ticking=f.timers.run(0);await new Promise(done=>setImmediate(done));
    if(cause==='manual')f.runtime.stopListening();else await f.timers.expire();
    await ticking;assert.equal(signal.aborted,true);assert.equal(f.timers.size(),0);assert.equal(f.runtime.status().listening,false);
    resolve({platform:'imessage',pages:1,items:[message()]});await new Promise(done=>setImmediate(done));assert.equal(f.store.read().reports.length,0);
  }
});

test('provider failures expose only safe runtime errors and listening does not retry silently',async t=>{
  const f=fixture(t);f.client.listReceived=async()=>{throw new Error('private API key and contact payload');};
  await assert.rejects(f.runtime.pollOnce(),error=>error instanceof PhoneRuntimeError&&error.status===409&&!String(error).includes('private API'));
  f.runtime.startListening();await f.timers.run(0);assert.equal(f.runtime.status().listening,false);assert.equal(f.timers.size(),0);assert.equal(f.runtime.status().lastStopReason,'poll_failed');
});

test('status excludes unknown quarantine IDs and deleted report IDs',async t=>{
  const f=fixture(t),raw=message();raw.sentBy.id=canonical('usr',9);raw.space.participantIds=[AGENT,raw.sentBy.id];f.setMessages([raw]);await f.runtime.pollOnce();assert.equal(f.runtime.status().counts.quarantined,1);assert.deepEqual(f.runtime.status().eligibleReportIds,[]);
  f.setMessages([message(2)]);await f.runtime.pollOnce();assert.equal(f.runtime.status().eligibleReportIds.length,1);f.store.reset();assert.deepEqual(f.runtime.status().eligibleReportIds,[]);
});

test('unconfigured reply approval cannot advertise sending enabled',t=>{
  const f=fixture(t,{replyApproval:{text:REPLY,maxSendRequests:99,maxDeliveryChecks:4}});assert.equal(f.runtime.status().sendingEnabled,false);
});

function config(f){return {approved:true,scope:f.scope,identities:[f.identity],replyApproval:f.replyApproval,maxModelRequests:3};}
test('launcher requires explicit approval, canonical scope and config flag before inspecting credentials',t=>{
  const f=fixture(t),path=join(f.dir,'config.json');let reads=0,apps=0;const env=new Proxy({},{get(){reads++;throw new Error('must not read credentials');}});
  for(const value of [{...config(f),approved:false},{...config(f),identities:[]},{...config(f),replyApproval:{...f.replyApproval,spaceId:canonical('spc',9)}}]){
    writeFileSync(path,JSON.stringify(value));assert.throws(()=>preparePhoneServer({configPath:path,rootDir:f.dir,env,appFactory(){apps++;}}),{code:'configuration'});
  }
  assert.equal(reads,0);assert.equal(apps,0);assert.equal(existsSync(join(f.dir,'.data/phone-provider-ledger.json')),false);
  for(const args of [[],['--config'],['--other',path],['--config',path,'--listen']])assert.throws(()=>parsePhoneArgs(args),{code:'configuration'});
  assert.equal(parsePhoneArgs(['--config',path]).configPath,path);
});

test('validated launcher uses fixed clients and a single Store, but starts no listening or provider work',async t=>{
  const f=fixture(t),path=join(f.dir,'approved-config.json');writeFileSync(path,JSON.stringify(config(f)),{mode:0o600});
  let stores=0,apps=0,options;class OneStore extends Store{constructor(file){super(file);stores++;}}
  const env={PHOTON_API_KEY:'pho_sk_synthetic_fixture_only',NVIDIA_API_KEY:'nvapi_synthetic_fixture_only'};
  const session=preparePhoneServer({configPath:path,rootDir:f.dir,env,StoreImpl:OneStore,mode:'fixture',photonFactory(value){assert.equal(value.enabled,true);assert.equal(value.projectId,PROJECT);return f.client;},modelFactory(value){assert.equal(value.baseUrl,'https://integrate.api.nvidia.com/v1');return f.modelClient;},appFactory(store,a,b,extra){apps++;options={store,a,b,extra};return new EventEmitter();}});
  assert.equal(stores,1);assert.equal(apps,1);assert.equal(options.a,undefined);assert.equal(options.b,undefined);assert.equal(options.extra.phone,session.phone);assert.equal(session.port,4173);assert.equal(session.phone.status().listening,false);assert.equal(f.calls.poll.length,0);assert.equal(f.calls.model.length,0);assert.equal(f.calls.reply.length,0);
  assert.equal(existsSync(join(f.dir,'.data/state.json.phone.lock')),true);
  assert.throws(()=>preparePhoneServer({configPath:path,rootDir:f.dir,env,photonFactory:()=>f.client,modelFactory:()=>f.modelClient,appFactory:()=>new EventEmitter()}),{code:'server_in_use'});
  await session.release();assert.equal(existsSync(join(f.dir,'.data/state.json.phone.lock')),false);await session.release();
});

test('shutdown aborts a pending manual model operation before resolving and prevents new work',async t=>{
  const f=fixture(t,{modelClient:undefined});f.setMessages([message()]);await f.runtime.pollOnce();const id=f.store.read().reports[0].id;let signal;
  const runtime=createPhoneRuntime({enabled:true,store:f.store,ledger:f.ledger,client:f.client,modelClient:{extract(input,options){signal=options.signal;return new Promise(()=>{});}},scope:f.scope,replyApproval:f.replyApproval});
  const interpreting=runtime.interpretOne(id);await new Promise(resolve=>setImmediate(resolve));await runtime.shutdown();await interpreting;
  assert.equal(signal.aborted,true);assert.equal(f.store.read().reports[0].modelReview.status,'failed');assert.equal(runtime.status().enabled,false);await assert.rejects(runtime.pollOnce(),{code:'disabled'});
});

test('server shutdown closes active SSE-style connections before releasing its lock',async()=>{
  const order=[];let closed;
  const session={phone:{shutdown(){order.push('drain');return Promise.resolve();}},app:{listening:true,close(callback){order.push('close');closed=callback;},closeAllConnections(){order.push('connections');this.listening=false;closed();}},async release(){order.push('release');}};
  await shutdownPhoneServer(session);assert.deepEqual(order,['drain','close','connections','release']);
});

test('CLI smoke rejects missing or unapproved config without a listener or credentials',()=>{
  const file=new URL('../src/phone-server.js',import.meta.url),template=new URL('../docs/PHONE_DEMO_CONFIG.example.json',import.meta.url);
  for(const args of [[],['--config',template.pathname]]){
    const result=spawnSync(process.execPath,[file.pathname,...args],{encoding:'utf8',timeout:3000,env:{PORT:'0'}});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/not configured/);assert.doesNotMatch(result.stderr,/pho_|nvapi|Error:|at file:/);
  }
});

test('invalid credentials or caps are rejected without app construction or exposing values',t=>{
  const f=fixture(t),path=join(f.dir,'config.json');writeFileSync(path,JSON.stringify(config(f)));let apps=0;
  for(const env of [{PHOTON_API_KEY:'pho_sk_private_fixture\n',NVIDIA_API_KEY:'nvapi_fixture'},{PHOTON_API_KEY:'pho_sk_fixture',NVIDIA_API_KEY:''},{PHOTON_API_KEY:'pho_sk_fixture',NVIDIA_API_KEY:'nvapi_fixture',PORT:'0'},{PHOTON_API_KEY:'pho_sk_fixture',NVIDIA_API_KEY:'nvapi_fixture',PORT:'4174'}])assert.throws(()=>preparePhoneServer({configPath:path,rootDir:f.dir,env,appFactory(){apps++;}}),error=>error instanceof PhoneRuntimeError&&!String(error).includes('private_fixture'));
  assert.equal(apps,0);assert.throws(()=>validatePhoneConfig({...config(f),maxModelRequests:4},f.store.read()),{code:'configuration'});
  const template=JSON.parse(readFileSync(new URL('../docs/PHONE_DEMO_CONFIG.example.json',import.meta.url),'utf8'));assert.equal(template.approved,false);assert.throws(()=>validatePhoneConfig(template,f.store.read()),{code:'configuration'});
});
