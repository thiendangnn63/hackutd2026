// Preserve local input while a background state update rebuilds case evidence.
const fields=form=>[...form.querySelectorAll('input,textarea,select')].filter(field=>field.name&&!['file','password','submit','button'].includes(field.type));
const key=field=>field.name+'\u0000'+(['checkbox','radio'].includes(field.type)?field.value:'');
const copy=value=>value==null?null:structuredClone(value);

// This memory is local UI state, never new evidence or an association between
// cases. New drafts reserve IDs even before another draft has been submitted.
export function createCaseDraftStore(){
  const verification=new Map(),messages=new Map();
  const nextId=usedIds=>{
    const used=new Set([...usedIds,...[...messages.values()].map(draft=>draft.providerEventId)].filter(Boolean));
    let index=1;while(used.has(`demo-sms-${String(index).padStart(3,'0')}`))index++;
    return `demo-sms-${String(index).padStart(3,'0')}`;
  };
  return {
    saveVerification(caseId,draft){if(caseId)verification.set(caseId,copy(draft));},
    verification(caseId){return copy(verification.get(caseId));},
    saveMessage(caseId,draft){if(caseId)messages.set(caseId,copy(draft));},
    message(caseId,{usedIds=[]}={}){
      if(!caseId)return null;
      if(!messages.has(caseId))messages.set(caseId,{senderId:'neighbor-1',text:'',observedAt:'',providerEventId:nextId(usedIds),simulateFailure:false});
      return copy(messages.get(caseId));
    },
    nextMessageId(usedIds=[]){return nextId(usedIds);},
    prune(cases){
      const byId=new Map(cases.map(item=>[item.id,item]));
      for(const id of verification.keys())if(!byId.has(id)||byId.get(id).verification||byId.get(id).reviewState==='resolved')verification.delete(id);
      for(const id of messages.keys())if(!byId.has(id))messages.delete(id);
    },
    clear(){verification.clear();messages.clear();}
  };
}

// The selected option may already have changed when its change handler runs.
// The form's recorded context identifies the outgoing draft, not that option.
export function readMessageDraft(form){
  const caseId=form.dataset.draftCaseId;if(!caseId)return null;
  const draft={};for(const name of ['senderId','text','observedAt','providerEventId','simulateFailure']){const field=form.elements[name];draft[name]=field.type==='checkbox'?field.checked:field.value;}
  draft.selection={};for(const name of ['text','providerEventId']){const field=form.elements[name];draft.selection[name]={start:field.selectionStart,end:field.selectionEnd};}
  return {caseId,draft};
}
export function writeMessageDraft(form,caseId,draft){
  form.dataset.draftCaseId=caseId||'';if(!draft)return;
  for(const name of ['senderId','text','observedAt','providerEventId','simulateFailure']){const field=form.elements[name];if(field.type==='checkbox')field.checked=Boolean(draft[name]);else field.value=draft[name]??'';}
  for(const [name,selection]of Object.entries(draft.selection||{})){const field=form.elements[name];if(selection.start!==null&&selection.start!==undefined)try{field.setSelectionRange(selection.start,selection.end);}catch{/* Native controls may not support text selection. */}}
}

export function rememberDrafts(root=document){
  const active=root.activeElement||document.activeElement,caseId=root.querySelector('#case-detail')?.dataset.caseId;
  const scope=form=>form.id==='verify-form'?caseId:form.id==='sms-form'?form.dataset.draftCaseId:null;
  const forms=[...root.querySelectorAll('#case-form,#sms-form,#verify-form')].map(form=>({id:form.id,caseId:scope(form),values:fields(form).map(field=>({key:key(field),value:field.value,checked:field.checked,start:field.selectionStart,end:field.selectionEnd}))}));
  const form=active?.closest('form'),focus=form&&fields(form).includes(active)&&forms.some(item=>item.id===form.id)?{formId:form.id,caseId:scope(form),key:key(active),start:active.selectionStart,end:active.selectionEnd}:null;
  const keyedFocus=active?.closest('#casework-view')&&active.dataset.recordFocus?{caseId:active.closest('#case-detail')?caseId:null,key:active.dataset.recordFocus}:null;
  return {forms,focus,keyedFocus,scroll:root.querySelector('#casework-view')?.scrollTop||0};
}
export function restoreDrafts(root=document,memory,{focus:restoreFocus=true,scroll:restoreScroll=true}={}){
  if(!memory)return;
  let target=null;
  for(const saved of memory.forms){
    const form=root.querySelector('#'+saved.id);
    if(!form||(saved.id==='verify-form'&&saved.caseId!==root.querySelector('#case-detail')?.dataset.caseId)||(saved.id==='sms-form'&&saved.caseId!==form.dataset.draftCaseId))continue;
    const current=fields(form);
    for(const item of saved.values){
      const field=current.find(field=>key(field)===item.key);if(!field||field.disabled)continue;
      if(['checkbox','radio'].includes(field.type))field.checked=item.checked;
      else if(field.tagName!=='SELECT'||[...field.options].some(option=>option.value===item.value&&!option.disabled))field.value=item.value;
      if(item.start!==null&&item.start!==undefined&&typeof field.setSelectionRange==='function')try{field.setSelectionRange(item.start,item.end);}catch{/* Date/select fields do not expose selection. */}
    }
  }
  const focusedForm=memory.focus&&root.querySelector('#'+memory.focus.formId);
  const sameFocusCase=focusedForm&&(focusedForm.id==='verify-form'?memory.focus.caseId===root.querySelector('#case-detail')?.dataset.caseId:focusedForm.id==='sms-form'?memory.focus.caseId===focusedForm.dataset.draftCaseId:true);
  if(sameFocusCase)target=fields(focusedForm).find(field=>key(field)===memory.focus.key&&!field.disabled);
  if(!target&&memory.keyedFocus&&(memory.keyedFocus.caseId===null||memory.keyedFocus.caseId===root.querySelector('#case-detail')?.dataset.caseId))target=[...root.querySelectorAll('#casework-view [data-record-focus]')].find(element=>element.dataset.recordFocus===memory.keyedFocus.key&&!element.disabled);
  if(!target&&memory.keyedFocus?.key.startsWith('case-card:'))target=root.querySelector('.case-card[aria-pressed="true"]');
  if(!target&&memory.keyedFocus?.caseId===root.querySelector('#case-detail')?.dataset.caseId)target=root.querySelector('#case-detail [data-record-focus="heading"]');
  if(!target&&memory.focus?.formId==='verify-form'&&sameFocusCase)target=root.querySelector('#case-detail [data-record-focus="heading"]');
  const view=root.querySelector('#casework-view');if(restoreScroll&&view&&!view.hidden)view.scrollTop=memory.scroll;
  if(restoreFocus&&target?.getClientRects().length){
    if(document.activeElement!==target)target.focus({preventScroll:true});
    if(memory.focus?.start!==null&&memory.focus?.start!==undefined&&typeof target.setSelectionRange==='function')try{target.setSelectionRange(memory.focus.start,memory.focus.end);}catch{/* Native date/select fields do not have text selection. */}
    const box=target.getBoundingClientRect(),bounds=view?.getBoundingClientRect();
    if(bounds&&(box.top<bounds.top||box.bottom>bounds.bottom))target.scrollIntoView({block:'nearest'});
  }
}
