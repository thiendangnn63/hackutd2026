import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,openCase,sendOutreach,receiveReport} from '../src/domain.js';
import {peopleIndex,matches,caseEvents,caseSearchText,searchPeople,messageThreads,outgoingForParticipant,searchSegments,messageHitIds} from '../public/records.js';
function story(){const state=createSeed();const {caseId}=openCase(state,{subjectNames:'Rosa and Miguel Santos',description:'Grandparents with a blue coat.',reporterId:'mom',lastKnownTile:'A1',lastContactAt:'2026-11-07T12:00:00Z',searchTiles:['A1'],consentToOutreach:true});sendOutreach(state,caseId);receiveReport(state,{providerEventId:'search-test',senderId:'neighbor-1',caseId,text:'I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.',observedAt:'2026-11-07T14:20:00Z'});return {state,caseId};}
test('person lookup connects the existing case, raw sightings and exact message text without changing state',()=>{
  const {state,caseId}=story(),before=structuredClone(state),index=peopleIndex(state),rosa=index.find(p=>p.id===`subject:${caseId}`);
  assert.ok(matches(rosa.searchText,'ROSA oak school'));assert.ok(matches(rosa.searchText,'blue coat'));
  assert.deepEqual(rosa.caseIds,[caseId]);assert.equal(rosa.welfare,'unknown');assert.deepEqual(state,before);
});
test('message search is case scoped and preserves direction and observation vs receipt times',()=>{
  const {state,caseId}=story(),c=state.cases.find(c=>c.id===caseId),events=caseEvents(state,caseId);
  const inbound=events.find(e=>e.direction==='incoming');assert.ok(inbound.text.includes('Oak School'));assert.equal(inbound.at,'2026-11-07T14:20:00.000Z');assert.ok(inbound.receivedAt);
  assert.ok(events.some(e=>e.direction==='outgoing'));assert.equal(caseEvents(state,'C104').length,0);
  assert.ok(matches(caseSearchText(state,c),'Jordan water'));assert.equal(matches(caseSearchText(state,state.cases.find(c=>c.id==='C104')),'Oak School'),false);
});
test('empty searches show existing records only; Unicode names and literal hostile strings stay plain searchable text',()=>{
  const state=createSeed(),p=peopleIndex(state);assert.equal(p.length,state.cases.length+state.participants.length);
  assert.ok(p.every(x=>matches(x.searchText,'')));assert.equal(matches('José Santos','jose'),true);assert.equal(matches('Elena Brooks','nonexistent'),false);assert.equal(matches('<script>alert(1)</script>','<script>'),true);
});


test('person search ranks a direct name ahead of matching related-case content',()=>{
  const {state,caseId}=story();
  const jordan=searchPeople(state,'Jordan');
  assert.equal(jordan[0].participantId,'neighbor-1');
  assert.equal(jordan[0].matchKind,'name');
  assert.ok(jordan.some(p=>p.id===`subject:${caseId}`&&p.matchKind==='related'));
  const rosa=searchPeople(state,'Rosa');
  assert.equal(rosa[0].id,`subject:${caseId}`);assert.equal(rosa[0].matchKind,'name');
  assert.ok(rosa.slice(1).every(p=>p.matchKind==='related'));
});

test('own record matches rank ahead of message context while multiword context remains searchable',()=>{
  const {state,caseId}=story();
  const coat=searchPeople(state,'blue coat');
  assert.equal(coat[0].id,`subject:${caseId}`);assert.equal(coat[0].matchKind,'record');
  assert.ok(coat.some(p=>p.participantId==='neighbor-1'&&p.matchKind==='related'));
  const sighting=searchPeople(state,'rosa OAK SCHOOL');
  assert.ok(sighting.some(p=>p.id===`subject:${caseId}`&&p.matchKind==='related'));
  assert.deepEqual(searchPeople(state,'Rosa nonexistent'),[]);
});

test('people scopes separate inquiries from community records without inferring participant welfare',()=>{
  const {state,caseId}=story(),before=structuredClone(state);
  state.cases.find(c=>c.id===caseId).welfareState='confirmed_safe';
  const inquiries=searchPeople(state,'','inquiries'),community=searchPeople(state,'','community');
  assert.equal(inquiries.length,state.cases.length);assert.ok(inquiries.every(p=>!p.participantId));
  assert.equal(community.length,state.participants.length);assert.ok(community.every(p=>p.participantId));
  assert.ok(community.every(p=>p.welfare==='unknown'));
  assert.equal(searchPeople(state,'Jordan','inquiries')[0].matchKind,'related');
  assert.equal(searchPeople(state,'Jordan','community')[0].matchKind,'name');
  // Queries are pure even when a related case carries a verified welfare outcome.
  const after=structuredClone(state);searchPeople(state,'Santos');messageThreads(state);
  assert.deepEqual(state,after);assert.equal(before.cases.find(c=>c.id===caseId).welfareState,'unknown');
});

test('unassigned and orphan case references remain visible without creating case identity links',()=>{
  const {state,caseId}=story();
  receiveReport(state,{providerEventId:'unassigned-search',senderId:'neighbor-2',text:'C104: an unassigned east gate report.',observedAt:'2026-11-07T14:20:00Z'});
  const raw=state.reports.at(-1);assert.equal(raw.caseId,null);
  state.reports.push({...raw,id:'R-orphan',providerEventId:'orphan-search',caseId:'C999',text:'Orphan record at the west gate.'});
  state.outbox.push({id:'M-unassigned',caseId:null,recipientId:'neighbor-2',kind:'acknowledgment',text:'Clarify the exercise case.',createdAt:'2026-11-07T14:25:00Z',status:'simulated'});
  const before=structuredClone(state),threads=messageThreads(state),unassigned=threads.find(t=>t.id==='unassigned');
  assert.ok(unassigned);assert.equal(unassigned.subjectNames,'Unassigned reports');assert.equal(unassigned.reviewState,'needs_clarification');
  assert.equal(unassigned.events.length,3);
  assert.equal(unassigned.events.find(e=>e.id===raw.id).caseId,null);
  assert.equal(unassigned.events.find(e=>e.id==='R-orphan').caseId,'C999');
  assert.equal(unassigned.events.find(e=>e.id==='R-orphan').report.caseId,'C999');
  assert.equal(threads.find(t=>t.id==='C104').events.length,0);
  assert.ok(threads.find(t=>t.id===caseId).events.every(e=>e.caseId===caseId));
  assert.ok(!peopleIndex(state).find(p=>p.participantId==='neighbor-2').caseIds.includes('C104'));
  assert.deepEqual(state,before);
});

test('unassigned raw text, original orphan case ID and sender name are searchable',()=>{
  const state=createSeed();
  receiveReport(state,{providerEventId:'unassigned-lookup',senderId:'neighbor-2',text:'Please review the east gate.',observedAt:'2026-11-07T14:20:00Z'});
  const raw=state.reports.at(-1);raw.caseId='C999';
  for(const query of ['east gate','C999','Sam Patel']){
    const result=messageThreads(state,query);assert.equal(result.length,1);assert.equal(result[0].id,'unassigned');
  }
  const sam=searchPeople(state,'east gate','community');
  assert.equal(sam.length,1);assert.equal(sam[0].participantId,'neighbor-2');assert.equal(sam[0].matchKind,'related');
  assert.deepEqual(sam[0].caseIds,[]);
});

test('follow-up scope retains unresolved and unassigned threads and excludes resolved cases',()=>{
  const {state,caseId}=story();state.cases.find(c=>c.id===caseId).reviewState='resolved';
  receiveReport(state,{providerEventId:'scope-unassigned',senderId:'neighbor-1',text:'Please review this observation.',observedAt:'2026-11-07T14:20:00Z'});
  assert.ok(messageThreads(state).some(c=>c.id===caseId));
  assert.deepEqual(messageThreads(state,'','follow_up').map(c=>c.id),['C104','unassigned']);
  assert.deepEqual(messageThreads(state,'Rosa','follow_up'),[]);
});

test('conversations order received reports by receipt time rather than earlier observation time',()=>{
  const {state,caseId}=story();
  state.reports=state.reports.map(r=>({...r,observedAt:'2026-11-07T10:00:00Z',receivedAt:'2026-11-07T14:30:00Z'}));
  state.outbox=state.outbox.map((m,i)=>({...m,createdAt:`2026-11-07T14:2${i}:00Z`}));
  const events=caseEvents(state,caseId);
  assert.equal(events.at(-1).direction,'incoming');
  assert.equal(events.at(-1).at,'2026-11-07T10:00:00Z');
  assert.equal(events.at(-1).receivedAt,'2026-11-07T14:30:00Z');
  assert.deepEqual(messageThreads(state).find(t=>t.id===caseId).events,events);
});


test('participant outgoing history retains unassigned CHECKIN acknowledgments without inventing a case link',()=>{
  const state=createSeed();
  receiveReport(state,{providerEventId:'unassigned-checkin',senderId:'neighbor-2',text:'CHECKIN',observedAt:'2026-11-07T14:20:00Z'});
  const before=structuredClone(state),sam=peopleIndex(state).find(p=>p.participantId==='neighbor-2');
  assert.deepEqual(sam.caseIds,[]);
  const events=outgoingForParticipant(state,'neighbor-2');
  assert.equal(events.length,1);assert.equal(events[0].caseId,null);assert.equal(events[0].recipientId,'neighbor-2');
  assert.equal(events[0].kind,'acknowledgment');assert.ok(events[0].text.includes('CHECKIN alone does not confirm safety'));
  assert.deepEqual(state,before);
});

test('participant outgoing history includes known, orphan and unassigned messages only for their actual recipient',()=>{
  const {state,caseId}=story();
  state.outbox.push({id:'M-orphan-recipient',caseId:'C999',recipientId:'neighbor-1',kind:'acknowledgment',text:'Clarify the orphan case.',createdAt:'2026-11-07T14:26:00Z',status:'simulated'});
  state.outbox.push({id:'M-null-recipient',caseId:null,recipientId:'neighbor-1',kind:'acknowledgment',text:'Clarify this report.',createdAt:'2026-11-07T14:25:00Z',status:'simulated'});
  state.outbox.push({id:'M-other-person',caseId:null,recipientId:'neighbor-2',kind:'acknowledgment',text:'A separate participant.',createdAt:'2026-11-07T14:24:00Z',status:'simulated'});
  const events=outgoingForParticipant(state,'neighbor-1');
  assert.ok(events.every(e=>e.direction==='outgoing'&&e.recipientId==='neighbor-1'));
  assert.ok(events.some(e=>e.caseId===caseId));assert.ok(events.some(e=>e.caseId==='C999'));assert.ok(events.some(e=>e.caseId===null));
  assert.ok(!events.some(e=>e.id==='M-other-person'));
  assert.deepEqual(outgoingForParticipant(state,'missing-participant'),[]);assert.deepEqual(outgoingForParticipant(state,null),[]);
});


test('search segments highlight literal case/accent-insensitive tokens and retain every original character',()=>{
  const source='  José brought WATER, water & blankets.  ';
  const segments=searchSegments(source,'jose WATER');
  assert.equal(segments.map(s=>s.text).join(''),source);
  assert.deepEqual(segments.filter(s=>s.matched).map(s=>s.text),['José','WATER','water']);
  assert.ok(segments.every(s=>typeof s.text==='string'&&typeof s.matched==='boolean'));
  assert.deepEqual(searchSegments(source,''),[{text:source,matched:false}]);
  assert.deepEqual(searchSegments(source,'missing'),[{text:source,matched:false}]);
});

test('highlight offsets preserve combining accents, compatibility characters, emoji and contextual lowercase',()=>{
  const source='Jose\u0301 👩🏽‍🚒, CAFÉ 🇺🇸 and oﬃce.';
  const segments=searchSegments(source,'jose 👩 cafe ffi');
  assert.equal(segments.map(s=>s.text).join(''),source);
  assert.deepEqual(segments.filter(s=>s.matched).map(s=>s.text),['Jose\u0301','👩🏽‍🚒','CAFÉ','ﬃ']);
  const family='A 👩‍👩‍👧‍👦 B';
  assert.deepEqual(searchSegments(family,'👧'),[{text:'A ',matched:false},{text:'👩‍👩‍👧‍👦',matched:true},{text:' B',matched:false}]);
  assert.deepEqual(searchSegments('ΣΟΣ','σ'),[{text:'Σ',matched:true},{text:'ΟΣ',matched:false}]);
  const whitespace='\tCafé\u00a0\r\nWATER\t';
  assert.equal(searchSegments(whitespace,'cafe water').map(s=>s.text).join(''),whitespace);
});

test('overlapping or adjacent token hits merge without duplicating original text',()=>{
  assert.deepEqual(searchSegments('banana','ana nan'),[{text:'b',matched:false},{text:'anana',matched:true}]);
  assert.deepEqual(searchSegments('ab','a b a'),[{text:'ab',matched:true}]);
  assert.deepEqual(searchSegments('oﬃce','f fi'),[{text:'o',matched:false},{text:'ﬃ',matched:true},{text:'ce',matched:false}]);
});

test('HTML and regular-expression-shaped queries remain literal plain text',()=>{
  const source='<script>alert(1)</script> [a-z] .* (a+)+$';
  for(const query of ['<script>','[a-z]','.*','(a+)+$']){
    const segments=searchSegments(source,query);
    assert.equal(segments.map(s=>s.text).join(''),source);
    assert.deepEqual(segments.filter(s=>s.matched).map(s=>s.text),[query]);
  }
  assert.deepEqual(searchSegments('ordinary text','.*'),[{text:'ordinary text',matched:false}]);
  assert.deepEqual(searchSegments('aaa','(a+)+$'),[{text:'aaa',matched:false}]);
});

test('message hits combine visible sender, kind and message tokens while preserving event order',()=>{
  const events=[
    {id:'E-later-id',name:'Jordán Lee',kind:'Reported observation',text:'Water at Oak School.'},
    {id:'E-earlier-id',name:'Maya Santos',kind:'Inquiry',text:'Jordan, have you seen Rosa?'},
    {id:'E-third',name:'Sam Patel',kind:'Acknowledgment',text:'The water report was received.'},
  ];
  assert.deepEqual(messageHitIds(events,'jordan water'),{fullIds:['E-later-id'],relatedIds:['E-later-id','E-earlier-id','E-third']});
  assert.deepEqual(messageHitIds(events,'lee observation oak'),{fullIds:['E-later-id'],relatedIds:['E-later-id']});
  assert.deepEqual(messageHitIds(events,'water'),{fullIds:['E-later-id','E-third'],relatedIds:['E-later-id','E-third']});
  assert.deepEqual(messageHitIds(events,''),{fullIds:[],relatedIds:[]});
  assert.deepEqual(messageHitIds(events,'  \u0301  '),{fullIds:[],relatedIds:[]});
});

test('visible message hits exclude hidden IDs and never infer or mutate case/welfare associations',()=>{
  const {state,caseId}=story(),before=structuredClone(state),events=caseEvents(state,caseId);
  const hidden={id:'ONLY_HIDDEN_EVENT',caseId:'C999',name:'Neighbor',kind:'Reported observation',text:'Please review this report.',report:{senderId:'HIDDEN_SENDER'}};
  assert.deepEqual(messageHitIds([hidden],'C999'),{fullIds:[],relatedIds:[]});
  assert.deepEqual(messageHitIds([hidden],'ONLY_HIDDEN_EVENT'),{fullIds:[],relatedIds:[]});
  assert.deepEqual(messageHitIds([hidden],'HIDDEN_SENDER'),{fullIds:[],relatedIds:[]});
  const hits=messageHitIds(events,'Rosa water');assert.ok(hits.fullIds.length>0);
  for(const event of events)searchSegments(event.text,'Rosa water');
  assert.deepEqual(state,before);
  assert.equal(state.cases.find(c=>c.id===caseId).welfareState,'unknown');
});
