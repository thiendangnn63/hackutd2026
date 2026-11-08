import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,openCase,sendOutreach,receiveReport} from '../src/domain.js';
import {peopleIndex,matches,caseEvents,caseSearchText} from '../public/records.js';
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
