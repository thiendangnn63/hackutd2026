// Preserve local input while a background state update rebuilds case evidence.
const fields=form=>[...form.querySelectorAll('input,textarea,select')].filter(field=>field.name&&!['file','password','submit','button'].includes(field.type));
const key=field=>field.name+'\u0000'+(['checkbox','radio'].includes(field.type)?field.value:'');
export function rememberDrafts(root=document){
  const active=root.activeElement||document.activeElement,caseId=root.querySelector('#case-detail')?.dataset.caseId;
  const forms=[...root.querySelectorAll('#case-form,#sms-form,#verify-form')].map(form=>({id:form.id,caseId:form.id==='verify-form'?caseId:null,values:fields(form).map(field=>({key:key(field),value:field.value,checked:field.checked}))}));
  const form=active?.closest('form'),focus=form&&forms.some(item=>item.id===form.id)?{formId:form.id,key:key(active),start:active.selectionStart,end:active.selectionEnd}:null;
  const keyedFocus=active?.closest('#case-detail')&&active.dataset.recordFocus?{caseId,key:active.dataset.recordFocus}:null;
  return {forms,focus,keyedFocus,scroll:root.querySelector('#casework-view')?.scrollTop||0};
}
export function restoreDrafts(root=document,memory){
  if(!memory)return;
  let target=null;
  for(const saved of memory.forms){
    const form=root.querySelector('#'+saved.id);
    if(!form||(saved.id==='verify-form'&&saved.caseId!==root.querySelector('#case-detail')?.dataset.caseId))continue;
    const current=fields(form);
    for(const item of saved.values){
      const field=current.find(field=>key(field)===item.key);if(!field||field.disabled)continue;
      if(['checkbox','radio'].includes(field.type))field.checked=item.checked;
      else if(field.tagName!=='SELECT'||[...field.options].some(option=>option.value===item.value&&!option.disabled))field.value=item.value;
    }
    if(memory.focus?.formId===saved.id)target=current.find(field=>key(field)===memory.focus.key&&!field.disabled);
  }
  if(!target&&memory.keyedFocus&&memory.keyedFocus.caseId===root.querySelector('#case-detail')?.dataset.caseId)target=[...root.querySelectorAll('#case-detail [data-record-focus]')].find(element=>element.dataset.recordFocus===memory.keyedFocus.key);
  const view=root.querySelector('#casework-view');if(view&&!view.hidden)view.scrollTop=memory.scroll;
  if(target?.getClientRects().length){
    if(document.activeElement!==target)target.focus({preventScroll:true});
    if(memory.focus?.start!==null&&memory.focus?.start!==undefined&&typeof target.setSelectionRange==='function')try{target.setSelectionRange(memory.focus.start,memory.focus.end);}catch{/* Native date/select fields do not have text selection. */}
    const box=target.getBoundingClientRect(),bounds=view?.getBoundingClientRect();
    if(bounds&&(box.top<bounds.top||box.bottom>bounds.bottom))target.scrollIntoView({block:'nearest'});
  }
}
