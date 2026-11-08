import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
async function server(t, store=new Store()) {
  const app=createApp(store); await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const port=app.address().port; const origin=`http://127.0.0.1:${port}`;
  async function call(path, {method='GET',body,headers={}}={}) {
    return new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method,headers:{...(method==='POST'?{'content-type':'application/json',origin}:{}),...headers}},res=>{
        let text=''; res.setEncoding('utf8'); res.on('data',chunk=>text+=chunk); res.on('end',()=>{ let data; try{data=JSON.parse(text);}catch{data=null;} resolve({status:res.statusCode,headers:res.headers,data,text});});
      }); req.on('error',reject); if(body!==undefined)req.write(typeof body==='string'?body:JSON.stringify(body));req.end();
    });
  }
  return {call,store,origin};
}
const input={subjectNames:'Rosa and Miguel Santos',description:'Fictional grandparents have not replied.',reporterId:'mom',lastKnownTile:'A1',lastContactAt:'2026-11-07T12:00:00Z',searchTiles:['A1','A2'],consentToOutreach:true};
test('HTTP family workflow returns full state and preserves separate assistance and pending case',async t=>{
  const {call}=await server(t);
  const health=await call('/api/health'); assert.equal(health.status,200); assert.deepEqual(health.data,{ok:true,mode:'simulation',liveSendingEnabled:false});
  let response=await call('/api/cases',{method:'POST',body:input}); assert.equal(response.status,201);const caseId=response.data.caseId;assert.equal(caseId,'C105');assert.equal(response.data.cases.length,2);
  response=await call(`/api/cases/${caseId}/outreach`,{method:'POST',body:{}});assert.equal(response.data.queued,2);
  const report={providerEventId:'http-1',senderId:'neighbor-1',caseId,text:'I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.',observedAt:'2026-11-07T14:20:00Z'};
  response=await call('/api/reports',{method:'POST',body:report});assert.equal(response.status,200);const reportId=response.data.reportId;assert.equal(response.data.cases[0].welfareState,'unknown');
  const duplicate=await call('/api/reports',{method:'POST',body:report}); assert.equal(duplicate.data.duplicate,true);assert.deepEqual(duplicate.data.outbox,response.data.outbox);
  response=await call(`/api/cases/${caseId}/verify`,{method:'POST',body:{officerName:'Officer Rivera (demo)',evidenceIds:[reportId],note:'Direct fictional responder contact with Rosa and Miguel at Oak School.',welfare:'confirmed_safe',resolve:true}});
  assert.equal(response.status,200);assert.equal(response.data.cases[0].reviewState,'resolved');assert.equal(response.data.assistance[0].status,'unassigned');assert.equal(response.data.cases.find(c=>c.id==='C104').reviewState,'follow_up_requested');
  response=await call('/api/participants/neighbor-1/consent',{method:'POST',body:{optedIn:false}});assert.equal(response.data.participants.find(p=>p.id==='neighbor-1').optedIn,false);
  response=await call('/api/reset',{method:'POST',body:{}});assert.equal(response.data.cases.length,1);assert.equal(response.data.reports.length,0);
});
test('HTTP rejects CSRF, cross-origin reads and DNS-rebinding hosts without mutation',async t=>{
  const {call,store}=await server(t);const before=store.read();
  for(const headers of [{origin:''},{origin:'https://evil.example'},{origin:'null'},{host:'evil.example'},{host:'127.0.0.1.evil.example'}]) {
    const response=await call('/api/cases',{method:'POST',body:input,headers});assert.equal(response.status,403); assert.deepEqual(store.read(),before);
  }
  assert.equal((await call('/api/state',{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await call('/api/state',{headers:{host:'evil.example'}})).status,403);
});
test('HTTP validates JSON shape, content type, size and fields without partial changes',async t=>{
  const {call,store}=await server(t);const before=store.read();
  for(const body of ['{broken','[]','null','true','12','"text"']) {const r=await call('/api/cases',{method:'POST',body});assert.equal(r.status,400);assert.equal(typeof r.data.error,'string');}
  assert.equal((await call('/api/cases',{method:'POST',body:input,headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await call('/api/cases',{method:'POST',body:{...input,description:'x'.repeat(17000)}})).status,413);
  assert.equal((await call('/api/cases',{method:'POST',body:{...input,lastContactAt:'2026-12-01T00:00:00Z'}})).status,400);
  assert.deepEqual(store.read(),before);
});
test('static allowlist never exposes source, secrets, persisted state or traversal targets',async t=>{
  const {call}=await server(t);
  for(const path of ['/src/server.js','/.env','/.env.example','/.data/state.json','/AGENTS.md','/package.json','/../src/server.js','/%2e%2e/src/server.js','/%2e%2e%2fsrc%2fserver.js','/styles.css/../../.env']) {
    const r=await call(path);assert.equal(r.status,404,path);assert.deepEqual(r.data,{error:'Not found.'});assert.doesNotMatch(r.text,/\/Users\/|secret|createServer/);
  }
  for(const path of ['/','/app.js','/styles.css']) {const r=await call(path);assert.equal(r.status,200,path);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff');assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);}
  assert.equal((await call('/api/state',{method:'DELETE'})).status,404);
});
test('storage failure returns generic error without state mutation or path disclosure',async t=>{
  const store=new Store();store.save=()=>{throw new Error('/private/secret/state.json permission failure');};
  const {call}=await server(t,store);const before=store.read();const r=await call('/api/cases',{method:'POST',body:input});
  assert.equal(r.status,500);assert.doesNotMatch(r.text,/private|secret|permission failure/);assert.deepEqual(store.read(),before);
});
test('HTTP retains conflicting case report without family update or fabricated assistance',async t=>{
  const {call}=await server(t);const opened=await call('/api/cases',{method:'POST',body:input});const caseId=opened.data.caseId;
  const text='C104: I saw Rosa and Miguel at Oak School. They need water for two people.';
  const response=await call('/api/reports',{method:'POST',body:{caseId,providerEventId:'conflict-http',senderId:'neighbor-1',text,observedAt:'2026-11-07T14:20:00Z'}});
  assert.equal(response.status,200);assert.equal(response.data.reports[0].text,text);assert.ok(response.data.reports[0].reviewFlags.includes('case_reference_conflict'));assert.deepEqual(response.data.reports[0].observations,[]);
  assert.equal(response.data.assistance.length,0);assert.ok(!response.data.outbox.some(m=>m.kind==='family_update'));assert.equal(response.data.cases[0].locationState,'unknown');
});
