import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaseDraftStore,readMessageDraft,writeMessageDraft,rememberDrafts,restoreDrafts} from '../public/form-drafts.js';

const cases=[{id:'C104',reviewState:'open',verification:null},{id:'C105',reviewState:'open',verification:null}];
const verification=(id,text)=>({id:'verify-form',caseId:id,values:[{key:'note\u0000',value:text,start:3,end:8},{key:'welfare\u0000',value:'confirmed_safe'},{key:'evidenceIds\u0000R-'+id,value:'R-'+id,checked:true}]});

test('case verification drafts retain independent evidence, welfare and caret without aliasing',()=>{
  const store=createCaseDraftStore(),first=verification('C104','Elena context'),second=verification('C105','Rosa context');
  store.saveVerification('C104',first);store.saveVerification('C105',second);first.values[0].value='caller mutation';
  assert.equal(store.verification('C104').values[0].value,'Elena context');assert.deepEqual(store.verification('C105'),second);
  const saved=store.verification('C105');saved.values[0].start=0;saved.values[2].checked=false;
  assert.equal(store.verification('C105').values[0].start,3);assert.equal(store.verification('C105').values[2].checked,true);
});

test('verification, missing-case and reset boundaries cannot resurrect an old C104 note',()=>{
  const store=createCaseDraftStore();for(const item of cases)store.saveVerification(item.id,verification(item.id,'Old note'));
  store.message('C104');store.message('C105');
  store.prune([{...cases[0],verification:{note:'Recorded'},reviewState:'resolved'}]);
  assert.equal(store.verification('C104'),null);assert.equal(store.verification('C105'),null);
  assert.equal(store.message('C104').text,''); // Follow-up reports may still target a verified case.
  store.saveVerification('C104',verification('C104','Before reset'));store.clear();store.prune([cases[0]]);
  assert.equal(store.verification('C104'),null);assert.equal(store.message('C104').providerEventId,'demo-sms-001');
});

test('new unsent message drafts reserve unused IDs while retries keep their exact original ID and text',()=>{
  const store=createCaseDraftStore(),used=['demo-sms-001','demo-sms-003'];
  const first=store.message('C104',{usedIds:used}),second=store.message('C105',{usedIds:used});
  assert.equal(first.providerEventId,'demo-sms-002');assert.equal(second.providerEventId,'demo-sms-004');assert.equal(second.text,'');assert.equal(second.observedAt,'');
  store.saveMessage('C104',{...first,text:'Elena draft',providerEventId:'manual-retry-id',selection:{text:{start:2,end:5}}});
  const retry=store.message('C104',{usedIds:[...used,'manual-retry-id']});
  assert.equal(retry.providerEventId,'manual-retry-id');assert.equal(retry.text,'Elena draft');assert.deepEqual(retry.selection.text,{start:2,end:5});
  retry.text='mutated read';assert.equal(store.message('C104').text,'Elena draft');assert.equal(store.message('C105').text,'');
});

function field(name,value='',options={}){
  return {name,value,type:'text',tagName:'INPUT',checked:false,disabled:false,dataset:{},selectionStart:2,selectionEnd:4,...options,
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
    focus(){document.activeElement=this;},getClientRects(){return [{}];},
    getBoundingClientRect(){return {top:10,bottom:30};},scrollIntoView(){},closest(selector){return selector==='form'?this.form:selector==='#case-detail'?this.detail:selector==='#casework-view'?this.view:null;}};
}
function messageForm(id='C104'){
  const elements={caseId:field('caseId',id,{tagName:'SELECT',type:'select-one'}),senderId:field('senderId','neighbor-1',{tagName:'SELECT',type:'select-one'}),text:field('text','Elena draft',{tagName:'TEXTAREA',type:'textarea'}),observedAt:field('observedAt','',{type:'datetime-local',selectionStart:null,selectionEnd:null}),providerEventId:field('providerEventId','retry-104'),simulateFailure:field('simulateFailure','on',{type:'checkbox',checked:true})};
  const form={id:'sms-form',dataset:{draftCaseId:id},elements,querySelectorAll:()=>Object.values(elements)};for(const item of Object.values(elements))item.form=form;return form;
}

test('native case selection changes save the outgoing body under its old DOM case context',()=>{
  const store=createCaseDraftStore(),form=messageForm();form.elements.caseId.value='C105';
  const old=readMessageDraft(form);assert.equal(old.caseId,'C104');assert.equal(old.draft.text,'Elena draft');assert.equal(old.draft.providerEventId,'retry-104');
  store.saveMessage(old.caseId,old.draft);const next=store.message('C105');writeMessageDraft(form,'C105',next);
  assert.equal(form.dataset.draftCaseId,'C105');assert.equal(form.elements.text.value,'');assert.equal(form.elements.simulateFailure.checked,false);assert.notEqual(form.elements.providerEventId.value,'retry-104');
  writeMessageDraft(form,'C104',store.message('C104'));assert.equal(form.elements.text.value,'Elena draft');assert.equal(form.elements.providerEventId.value,'retry-104');assert.equal(form.elements.text.selectionStart,2);assert.equal(form.elements.simulateFailure.checked,true);
});

function fixture(caseId='C104'){
  const view={hidden:false,scrollTop:45,getBoundingClientRect:()=>({top:0,bottom:100})},detail={dataset:{caseId}};
  const note=field('note','Existing note',{tagName:'TEXTAREA',type:'textarea'}),evidence=field('evidenceIds','R-'+caseId,{type:'checkbox',checked:true});
  const welfare=field('welfare','confirmed_safe',{tagName:'SELECT',type:'select-one',options:[{value:'assistance_needed',disabled:false},{value:'confirmed_safe',disabled:false}]});
  const form={id:'verify-form',dataset:{},querySelectorAll:()=>[note,evidence,welfare]};
  const action=field('', '',{type:'button',tagName:'BUTTON',dataset:{recordFocus:'outreach'}}),heading=field('','',{tagName:'H2',dataset:{recordFocus:'heading'}}),card=field('','',{tagName:'BUTTON',type:'button',dataset:{recordFocus:'case-card:'+caseId}});
  for(const item of [note,evidence,welfare,action,heading]){item.detail=detail;item.view=view;}for(const item of [note,evidence,welfare])item.form=form;card.view=view;
  const root={activeElement:null,
    querySelector:selector=>selector==='#case-detail'?detail:selector==='#casework-view'?view:selector==='#verify-form'?form:selector==='#case-detail [data-record-focus="heading"]'?heading:selector==='.case-card[aria-pressed="true"]'?card:null,
    querySelectorAll:selector=>selector==='#case-form,#sms-form,#verify-form'?[form]:selector==='#casework-view [data-record-focus]'?[action,heading,card]:[]};
  return {root,view,detail,note,evidence,welfare,form,action,heading,card};
}
function withDocument(run){const previous=globalThis.document;globalThis.document={activeElement:null,body:{}};try{return run();}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}}

test('background rebuild restores a focused Casework action, or its same-case heading when disabled',()=>withDocument(()=>{
  const before=fixture();document.activeElement=before.action;const memory=rememberDrafts(before.root);
  const after=fixture();document.activeElement=document.body;restoreDrafts(after.root,memory);
  assert.equal(document.activeElement,after.action);assert.equal(after.view.scrollTop,45);
  after.action.disabled=true;document.activeElement=document.body;restoreDrafts(after.root,memory);assert.equal(document.activeElement,after.heading);
}));

test('case-card navigation retains the clicked case control without focusing another case draft',()=>withDocument(()=>{
  const before=fixture('C104');before.card.dataset.recordFocus='case-card:C105';document.activeElement=before.card;
  const memory=rememberDrafts(before.root),after=fixture('C105');document.activeElement=document.body;
  restoreDrafts(after.root,{...memory,forms:[]},{scroll:false});assert.equal(document.activeElement,after.card);assert.equal(after.note.value,'Existing note');
}));

test('draft values/caret survive blur, but another case cannot inherit their evidence or focus',()=>withDocument(()=>{
  const before=fixture();before.note.selectionStart=3;before.note.selectionEnd=7;document.activeElement=before.note;
  const memory=rememberDrafts(before.root),same=fixture(),other=fixture('C105');same.note.value='';same.evidence.checked=false;
  document.activeElement=document.body;restoreDrafts(same.root,memory);
  assert.equal(same.note.value,'Existing note');assert.equal(same.evidence.checked,true);assert.equal(same.note.selectionStart,3);assert.equal(document.activeElement,same.note);
  document.activeElement=document.body;other.note.value='Other case note';other.evidence.checked=false;restoreDrafts(other.root,memory);
  assert.equal(other.note.value,'Other case note');assert.equal(other.evidence.checked,false);assert.equal(document.activeElement,document.body);
}));

test('background draft restoration cannot copy one case message values or focus into another',()=>withDocument(()=>{
  const before=messageForm('C104'),after=messageForm('C105');
  const root=form=>({querySelector:selector=>selector==='#sms-form'?form:null,querySelectorAll:selector=>selector==='#case-form,#sms-form,#verify-form'?[form]:[]});
  document.activeElement=before.elements.text;const memory=rememberDrafts(root(before));document.activeElement=document.body;
  after.elements.text.value='Rosa draft';restoreDrafts(root(after),memory);assert.equal(after.elements.text.value,'Rosa draft');assert.equal(document.activeElement,document.body);
}));
