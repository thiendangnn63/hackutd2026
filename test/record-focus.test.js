import test from 'node:test';
import assert from 'node:assert/strict';
import {recordFocusKey,rememberRecordFocus,restoreRecordFocus,viewportRecordFocus} from '../public/record-focus.js';

function element(dataset={},options={}){
  return {dataset:{...dataset},disabled:false,shown:true,visibility:'visible',...options,
    getClientRects(){return this.shown?[{}]:[];},
    focus(options){this.focusOptions=options;document.activeElement=this;},
    scrollIntoView(options){this.scrollOptions=options;},
    closest(){return this.detail||null;},querySelector(){return null;},querySelectorAll(){return [];}};
}
function fixture(id='C101'){
  const heading=recordFocusKey(element(),'heading'),next=recordFocusKey(element(),'match-next');
  const detail=recordFocusKey(element({threadId:id}),'detail'),selected=element({recordId:id}),search=element(),view={hidden:false,querySelector:()=>search};
  for(const item of [heading,next])item.detail=detail;
  detail.querySelector=selector=>selector==='[data-record-focus="heading"]'?heading:null;
  detail.querySelectorAll=selector=>selector==='[data-record-focus]'?[heading,next]:[];
  const root={
    contains:item=>[detail,heading,next,selected].includes(item),closest:()=>view,
    querySelector:selector=>selector==='.person-record,.conversation'?detail:selector==='[data-record-id][aria-pressed="true"]'?selected:null,
    querySelectorAll:selector=>selector==='[data-record-focus]'?[heading,next]:selector==='[data-message-id]'?[]:[]
  };
  return {root,view,detail,heading,next,selected,search};
}
function withDocument(run){
  const oldDocument=globalThis.document,oldStyle=globalThis.getComputedStyle;
  globalThis.document={activeElement:null};globalThis.getComputedStyle=item=>({visibility:item.visibility});
  try{return run();}finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
  }
}

test('message navigation focus survives a state rebuild within the same conversation',()=>withDocument(()=>{
  const before=fixture();document.activeElement=before.next;
  const memory=rememberRecordFocus(before.root);assert.deepEqual(memory,{kind:'detail',id:'C101',key:'match-next'});
  const after=fixture();restoreRecordFocus(after.root,memory);
  assert.equal(document.activeElement,after.next);assert.deepEqual(after.next.focusOptions,{preventScroll:true});
}));

test('a different selected conversation does not inherit another case control or message focus',()=>withDocument(()=>{
  const after=fixture('C102');
  restoreRecordFocus(after.root,{kind:'detail',id:'C101',key:'match-next'});
  assert.equal(document.activeElement,after.selected);
  assert.notEqual(document.activeElement,after.next);
  restoreRecordFocus(after.root,{kind:'detail',id:'C101',key:'message:shared-id'});
  assert.equal(document.activeElement,after.selected);
}));

test('a disabled match control falls back to the visible conversation heading',()=>withDocument(()=>{
  const after=fixture();after.next.disabled=true;
  restoreRecordFocus(after.root,{kind:'detail',id:'C101',key:'match-next'});
  assert.equal(document.activeElement,after.heading);assert.equal(after.heading.tabIndex,-1);
}));

test('a hidden compact Back button cannot take focus from the visible detail context',()=>withDocument(()=>{
  const after=fixture(),back=recordFocusKey(element({}, {shown:false}),'back');
  after.detail.querySelectorAll=()=>[after.heading,back];
  restoreRecordFocus(after.root,{kind:'detail',id:'C101',key:'back'},{reveal:true});
  assert.equal(document.activeElement,after.heading);assert.deepEqual(after.heading.scrollOptions,{block:'nearest'});
}));

test('hidden routes and focus outside records are left alone during background updates',()=>withDocument(()=>{
  const after=fixture(),outside=element();document.activeElement=outside;
  assert.equal(rememberRecordFocus(after.root),null);
  after.view.hidden=true;restoreRecordFocus(after.root,{kind:'detail',id:'C101',key:'match-next'});
  assert.equal(document.activeElement,outside);
}));

test('filter selection is remembered by its scope value and restored after rebuilding',()=>withDocument(()=>{
  const after=fixture(),filter=element({scopeValue:'follow_up'});
  after.root.contains=item=>item===filter;document.activeElement=filter;
  assert.deepEqual(rememberRecordFocus(after.root),{kind:'scope',key:'follow_up'});
  const replacement=element({scopeValue:'follow_up'});after.root.querySelectorAll=()=>[replacement];
  restoreRecordFocus(after.root,{kind:'scope',key:'follow_up'});
  assert.equal(document.activeElement,replacement);
}));

test('loading and retry feedback receive focus when a previously focused record disappears',()=>withDocument(()=>{
  const after=fixture(),loading=recordFocusKey(element(),'loading'),retry=recordFocusKey(element(),'retry');
  const normal=after.root.querySelector;
  after.root.querySelector=selector=>selector==='[data-record-focus="loading"]'?loading:selector==='[data-record-focus="retry"]'?retry:normal(selector);
  restoreRecordFocus(after.root,{kind:'detail',id:'removed',key:'message-lab'});assert.equal(document.activeElement,loading);assert.equal(loading.tabIndex,-1);
  loading.shown=false;restoreRecordFocus(after.root,{kind:'detail',id:'removed',key:'message-lab'});assert.equal(document.activeElement,retry);
}));


test('a media transition recovers a blurred detail token only for its current visible record and route',()=>withDocument(()=>{
  const after=fixture();after.root.id='messages-workspace';document.body=element();document.activeElement=document.body;
  const memory={kind:'detail',id:'C101',key:'match-next'},last={rootId:after.root.id,route:'#messages',memory};
  const recovered=viewportRecordFocus(after.root,null,last,'#messages');assert.deepEqual(recovered,memory);
  restoreRecordFocus(after.root,recovered,{reveal:true});assert.equal(document.activeElement,after.next);assert.deepEqual(after.next.scrollOptions,{block:'nearest'});
}));

test('viewport recovery never steals external focus or reopens a different/hidden record route',()=>withDocument(()=>{
  const after=fixture();after.root.id='messages-workspace';document.body=element();
  const last={rootId:after.root.id,route:'#messages',memory:{kind:'detail',id:'C101',key:'match-next'}};
  document.activeElement=element();assert.equal(viewportRecordFocus(after.root,null,last,'#messages'),null);
  document.activeElement=document.body;assert.equal(viewportRecordFocus(after.root,null,last,'#people'),null);
  assert.equal(viewportRecordFocus(after.root,null,{...last,rootId:'people-workspace'},'#messages'),null);
  assert.equal(viewportRecordFocus(after.root,null,{...last,memory:{...last.memory,id:'C102'}},'#messages'),null);
  after.view.hidden=true;assert.equal(viewportRecordFocus(after.root,null,last,'#messages'),null);
}));

test('live control focus wins over a remembered token and cleared external-focus memory cannot recover',()=>withDocument(()=>{
  const after=fixture();after.root.id='messages-workspace';document.body=element();document.activeElement=document.body;
  const current={kind:'scope',key:'follow_up'};
  assert.equal(viewportRecordFocus(after.root,current,null,'#messages'),current);
  assert.equal(viewportRecordFocus(after.root,null,null,'#messages'),null);
}));


test('empty-result clear actions keep keyboard focus after a same-state refresh',()=>withDocument(()=>{
  const before=fixture(),clear=recordFocusKey(element(),'clear-search');before.root.contains=item=>item===clear;document.activeElement=clear;
  const memory=rememberRecordFocus(before.root);assert.deepEqual(memory,{kind:'workspace',key:'clear-search'});
  const after=fixture(),replacement=recordFocusKey(element(),'clear-search');after.root.querySelectorAll=()=>[replacement];
  restoreRecordFocus(after.root,memory);assert.equal(document.activeElement,replacement);
}));

test('an empty-conversation Casework action keeps its focus in the same case',()=>withDocument(()=>{
  const before=fixture(),action=recordFocusKey(element(),'casework');action.detail=before.detail;before.root.contains=item=>item===action;document.activeElement=action;
  const memory=rememberRecordFocus(before.root),after=fixture(),replacement=recordFocusKey(element(),'casework');
  after.detail.querySelectorAll=()=>[replacement,after.heading];restoreRecordFocus(after.root,memory);assert.equal(document.activeElement,replacement);
}));
