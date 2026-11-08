import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeed, openCase, sendOutreach, receiveReport, verifyCase, setConsent, eligibleRecipients, extractSimulated, applyAction } from '../src/domain.js';
import { Store } from '../src/store.js';
const caseInput = (extra = {}) => ({ subjectNames: 'Rosa and Miguel Santos', description: 'Fictional grandparents have not replied.', reporterId: 'mom', lastKnownTile: 'A1', lastContactAt: '2026-11-07T12:00:00Z', searchTiles: ['A1', 'A2'], consentToOutreach: true, ...extra });
const reportInput = (caseId, extra = {}) => ({ providerEventId: 'event-1', senderId: 'neighbor-1', caseId, text: 'I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.', observedAt: '2026-11-07T14:20:00Z', ...extra });
const verifyInput = (reportId, extra = {}) => ({ officerName: 'Officer Rivera (demo)', evidenceIds: [reportId], note: 'Direct fictional responder contact with Rosa and Miguel at Oak School.', welfare: 'confirmed_safe', resolve: true, ...extra });
function setup() { const store = new Store(); const {caseId} = store.act(openCase, caseInput()); return {store, caseId}; }
function unchanged(store, action) { const before = store.read(); assert.throws(action); assert.deepEqual(store.read(), before); }

test('grandparents workflow preserves separate welfare, assistance, unresolved case and simulated delivery', () => {
  const {store, caseId} = setup(); assert.equal(caseId, 'C105');
  let state = store.act(sendOutreach, caseId);
  assert.equal(state.queued, 2); assert.equal(state.cases[0].welfareState, 'unknown');
  assert.deepEqual(state.outbox.map(m=>m.recipientId), ['neighbor-1','neighbor-2']);
  const result = store.act(receiveReport, reportInput(caseId));
  assert.equal(result.cases[0].locationState, 'unverified_sighting'); assert.equal(result.cases[0].welfareState, 'unknown');
  assert.deepEqual(result.reports[0].observations.map(o=>o.type), ['sighting','water_need','road_blockage']);
  assert.ok(result.reports[0].observations.every(o=>o.verification === 'reported' && o.sourceSpan));
  assert.equal(result.assistance[0].status, 'unassigned');
  assert.match(result.outbox.find(m=>m.kind==='family_update').text, /unverified.*does not confirm/i);
  state = store.act(verifyCase, caseId, verifyInput(result.reportId));
  assert.equal(state.cases[0].reviewState, 'resolved'); assert.equal(state.cases[0].locationState, 'verified_location');
  assert.equal(state.cases[0].welfareState, 'confirmed_safe'); assert.equal(state.cases[0].outreachState, 'stopped');
  assert.equal(state.assistance[0].status, 'unassigned');
  assert.deepEqual(state.cases.find(c=>c.id==='C104'), createSeed().cases[0]);
  assert.ok(state.outbox.every(m=>m.status==='simulated'));
  unchanged(store, ()=>store.act(sendOutreach, caseId));
  unchanged(store, ()=>store.act(verifyCase, caseId, verifyInput(result.reportId)));
});
test('outreach and provider event retries never duplicate external effects', () => {
  const {store, caseId} = setup(); store.act(sendOutreach, caseId); const first = store.read().outbox;
  assert.equal(store.act(sendOutreach, caseId).queued, 0); assert.deepEqual(store.read().outbox, first);
  const result = store.act(receiveReport, reportInput(caseId)); const before = store.read();
  const retry = store.act(receiveReport, reportInput(caseId, {text:'Different retry payload'}));
  assert.equal(retry.duplicate, true); assert.equal(retry.reportId, result.reportId); assert.deepEqual(store.read(), before);
});
test('recipient policy excludes stale, absent, future, out-of-scope and unconsented participants', () => {
  const state = createSeed(); openCase(state, caseInput());
  state.participants.push({...state.participants[1], id:'future', locationReportedAt:'2026-11-08T00:00:00Z'});
  state.participants.push({...state.participants[1], id:'malformed', locationReportedAt:'bad'});
  assert.deepEqual(eligibleRecipients(state,state.cases[0]).map(p=>p.id), ['neighbor-1','neighbor-2']);
  state.participants[1].locationReportedAt='2026-11-07T12:30:00Z';
  assert.equal(eligibleRecipients(state,state.cases[0]).length,2);
  state.participants[1].locationReportedAt='2026-11-07T12:29:59Z';
  assert.deepEqual(eligibleRecipients(state,state.cases[0]).map(p=>p.id),['neighbor-2']);
});
test('outreach permission, incident, tile breadth and recipient cap fail closed', () => {
  for (const patch of [{consentToOutreach:false},{searchTiles:['A1','A2','B1']}]) {
    const store = new Store(); const {caseId} = store.act(openCase,caseInput(patch));
    assert.equal(store.read().cases[0].outreachState,'needs_review'); unchanged(store,()=>store.act(sendOutreach,caseId));
  }
  const {store,caseId}=setup(); store.state.incident.active=false; unchanged(store,()=>store.act(sendOutreach,caseId));
  store.state.incident.active=true; store.state.incident.policy.maxRecipients=1; unchanged(store,()=>store.act(sendOutreach,caseId));
});
test('missing, malformed and future inputs fail without mutation', () => {
  const store=new Store();
  for(const patch of [{subjectNames:''},{description:null},{reporterId:'unknown'},{lastKnownTile:'X'},{searchTiles:[]},{searchTiles:['X']},{lastContactAt:'bad'},{lastContactAt:'2026-11-08T00:00:00Z'}]) unchanged(store,()=>store.act(openCase,caseInput(patch)));
  const {caseId}=store.act(openCase,caseInput());
  for(const patch of [{providerEventId:''},{senderId:'missing'},{text:''},{caseId:'C999'},{observedAt:'bad'},{observedAt:'2026-11-08T00:00:00Z'}]) unchanged(store,()=>store.act(receiveReport,reportInput(caseId,patch)));
  unchanged(store,()=>store.act(setConsent,'neighbor-1',{optedIn:'false'}));
});
test('impossible calendar dates are rejected instead of normalized', () => {
  const store=new Store(); unchanged(store,()=>store.act(openCase,caseInput({lastContactAt:'2026-02-30T12:00:00Z'})));
});
test('stale and missing report time retain raw evidence for review', () => {
  for(const [observedAt,flag] of [[undefined,'observation_time_missing'],['2026-11-07T10:00:00Z','stale_observation']]) {
    const {store,caseId}=setup(); const result=store.act(receiveReport,reportInput(caseId,{observedAt}));
    assert.equal(result.reports[0].processingState,'needs_review'); assert.ok(result.reports[0].reviewFlags.includes(flag)); assert.equal(result.cases[0].welfareState,'unknown');
  }
});
test('negations and corrections never create positive observations', () => {
  for(const text of ['I did not see them at Oak School.','Correction: wrong people at Oak School.','I saw them yesterday at Oak School.','I saw them at Oak School but they do not need water.']) {
    const extracted=extractSimulated(text); assert.deepEqual(extracted.observations.map(o=>o.type),['correction']); assert.ok(extracted.reviewFlags.includes('correction_or_negation'));
  }
});
test('common contraction negations must not become positive findings', () => {
  for(const text of ["I saw them at Oak School but they don't need water.","I saw them at Oak School but the road isn't blocked.","I haven't seen them at Oak School."]) {
    const result=extractSimulated(text); assert.ok(result.reviewFlags.includes('correction_or_negation'),text); assert.ok(!result.observations.some(o=>['sighting','water_need','road_blockage'].includes(o.type)),text);
  }
});
test('failed extraction preserves raw report without fabricated observations', () => {
  const {store,caseId}=setup(); const input=reportInput(caseId,{simulateFailure:true}); const result=store.act(receiveReport,input);
  assert.equal(result.reports[0].text,input.text); assert.equal(result.reports[0].processingPath,'failed'); assert.equal(result.reports[0].processingState,'needs_review');
  assert.deepEqual(result.reports[0].observations,[]); assert.equal(result.assistance.length,0); assert.equal(result.cases[0].locationState,'unknown');
  unchanged(store,()=>store.act(verifyCase,caseId,verifyInput(result.reportId)));
});
test('STOP immediately revokes consent with no automatic reply; CHECKIN neither reenrolls nor confirms safety', () => {
  const {store,caseId}=setup(); const result=store.act(receiveReport,reportInput(caseId,{text:' STOP '}));
  assert.equal(result.participants.find(p=>p.id==='neighbor-1').optedIn,false); assert.equal(result.outbox.length,0); assert.equal(result.reports[0].processingPath,'deterministic');
  const next=store.act(sendOutreach,caseId); assert.deepEqual(next.outbox.map(m=>m.recipientId),['neighbor-2']);
  store.act(receiveReport,reportInput(caseId,{providerEventId:'check',text:'CHECKIN'}));
  assert.equal(store.read().outbox.length,1); assert.equal(store.read().cases[0].welfareState,'unknown');
  store.act(setConsent,'neighbor-2',{optedIn:false}); assert.equal(store.act(sendOutreach,caseId).queued,0);
});
test('self-check-in and unrecognized messages are not family safety evidence', () => {
  const {store,caseId}=setup(); store.act(receiveReport,reportInput(caseId,{text:'I am safe at Oak School.'}));
  assert.equal(store.read().cases[0].welfareState,'unknown'); assert.equal(store.read().cases[0].locationState,'unknown');
  const result=store.act(receiveReport,reportInput(caseId,{providerEventId:'unknown',text:'Some opaque text.'}));
  assert.ok(result.reports[1].reviewFlags.includes('unrecognized_text')); assert.equal(result.reports[1].text,'Some opaque text.');
});
test('verification requires case-owned sighting evidence and meaningful direct confirmation', () => {
  const {store,caseId}=setup(); const {reportId}=store.act(receiveReport,reportInput(caseId));
  const {reportId:foreign}=store.act(receiveReport,reportInput('C104',{providerEventId:'other'}));
  for(const patch of [{evidenceIds:[]},{evidenceIds:['missing']},{evidenceIds:[foreign]},{evidenceIds:[reportId,foreign]},{note:'Looks fine'},{officerName:''},{welfare:'probably_safe'}]) unchanged(store,()=>store.act(verifyCase,caseId,verifyInput(reportId,patch)));
  const result=store.act(verifyCase,caseId,verifyInput(reportId,{resolve:false,welfare:'assistance_needed'}));
  assert.equal(result.cases[0].reviewState,'follow_up_requested'); assert.equal(result.cases[0].welfareState,'assistance_needed'); assert.equal(result.assistance[0].status,'unassigned');
});
test('applyAction and Store isolate reads and rollback arbitrary action failures', () => {
  const state=createSeed(); assert.throws(()=>applyAction(state,next=>{next.cases=[];throw new Error('failure');})); assert.equal(state.cases.length,1);
  const store=new Store(); unchanged(store,()=>store.act(next=>{next.cases=[];throw new Error('failure');})); const copy=store.read(); copy.cases=[]; assert.equal(store.read().cases.length,1);
});
test('disk persistence reloads all evidence; corrupt file is never overwritten', () => {
  const dir=mkdtempSync(join(tmpdir(),'family-test-')); const path=join(dir,'state.json');
  try {
    const store=new Store(path); const {caseId}=store.act(openCase,caseInput()); store.act(receiveReport,reportInput(caseId)); assert.deepEqual(new Store(path).read(),store.read());
    unchanged(store,()=>store.act(openCase,caseInput({subjectNames:''}))); assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),store.read());
    writeFileSync(path,'broken JSON'); assert.throws(()=>new Store(path),/not overwritten/); assert.equal(readFileSync(path,'utf8'),'broken JSON');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('timestamps require explicit timezone and reject impossible dates/times', () => {
  for (const lastContactAt of ['2026-11-07T12:00:00','2026-02-29T12:00:00Z','2026-11-31T12:00:00Z','2026-11-07T25:00:00Z','2026-11-07T12:61:00Z']) {
    const store=new Store(); unchanged(store,()=>store.act(openCase,caseInput({lastContactAt})));
  }
  const store=new Store(); assert.equal(store.act(openCase,caseInput({lastContactAt:'2026-11-07T06:00:00-06:00'})).cases[0].lastContactAt,'2026-11-07T12:00:00.000Z');
});
test('negated urgent messages retain urgent human-review warning', () => {
  const extracted=extractSimulated("I don't know where they are. They may be injured.");
  assert.ok(extracted.reviewFlags.includes('correction_or_negation')); assert.ok(extracted.reviewFlags.includes('urgent_human_review'));
  assert.ok(!extracted.observations.some(o=>o.type==='sighting'));
});
test('unassociated reports remain raw, flagged and cannot verify another case', () => {
  const {store,caseId}=setup(); const result=store.act(receiveReport,reportInput(undefined));
  assert.equal(result.reports[0].caseId,null); assert.ok(result.reports[0].reviewFlags.includes('case_needs_clarification')); assert.equal(result.outbox.length,0);assert.equal(result.assistance.length,0);
  unchanged(store,()=>store.act(verifyCase,caseId,verifyInput(result.reportId)));
});
test('conflicting text case IDs are review-only and cannot generate positive family or assistance effects', () => {
  for (const text of ['C104: I saw Rosa and Miguel at Oak School. They need water for two people.', 'c104 and C105: I saw them at Oak School.']) {
    const {store,caseId}=setup(); const result=store.act(receiveReport,reportInput(caseId,{text})); const report=result.reports[0];
    assert.equal(report.text,text); assert.equal(report.processingPath,'deterministic'); assert.equal(report.processingState,'needs_review');assert.ok(report.reviewFlags.includes('case_reference_conflict'));
    assert.deepEqual(report.observations,[]);assert.equal(result.assistance.length,0);assert.ok(!result.outbox.some(m=>m.kind==='family_update'));
    assert.equal(result.cases[0].welfareState,'unknown');assert.equal(result.cases[0].locationState,'unknown'); assert.deepEqual(result.cases.find(c=>c.id==='C104'),createSeed().cases[0]);
    unchanged(store,()=>store.act(verifyCase,caseId,verifyInput(result.reportId)));
    const before=store.read();assert.equal(store.act(receiveReport,reportInput(caseId,{text})).duplicate,true);assert.deepEqual(store.read(),before);
  }
});
test('matching case reference allows extraction while an unassociated reference stays ambiguous', () => {
  const {store,caseId}=setup(); const text=`${caseId}: I saw Rosa and Miguel at Oak School.`;
  const matched=store.act(receiveReport,reportInput(caseId,{text}));assert.equal(matched.reports[0].observations[0].type,'sighting');
  const unassociated=store.act(receiveReport,reportInput(undefined,{text,providerEventId:'unassociated-case'}));
  const report=unassociated.reports[1];assert.equal(report.caseId,null);assert.ok(report.reviewFlags.includes('case_reference_conflict'));assert.deepEqual(report.observations,[]);
});

test('objects and unclear pronouns cannot create a person sighting or family reassurance', () => {
  for (const text of ['I saw a tree at Oak School.', 'I saw them at Oak School.']) {
    const { store, caseId } = setup();
    const result = store.act(receiveReport, reportInput(caseId, { text }));
    assert.ok(result.reports[0].reviewFlags.includes('sighting_subject_needs_clarification'));
    assert.ok(!result.reports[0].observations.some((o) => o.type === 'sighting'));
    assert.equal(result.cases.find((c) => c.id === caseId).locationState, 'unknown');
    assert.equal(result.outbox.filter((m) => m.kind === 'family_update').length, 0);
  }
});
