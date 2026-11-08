// Preserve an explicitly focused record control across a view rebuild.
// These tokens describe UI identity, never a new association between people or cases.
export const recordFocusKey=(element,key)=>{element.dataset.recordFocus=key;return element;};
const visible=element=>Boolean(element&&element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'&&!element.disabled);
const detailId=element=>element?.dataset.personId||element?.dataset.threadId;
export function rememberRecordFocus(root){
  const active=document.activeElement;if(!root.contains(active))return null;
  const detail=active.closest('.person-record,.conversation');
  if(detail)return {kind:'detail',id:detailId(detail),key:active.dataset.recordFocus||(active.dataset.messageId?'message:'+active.dataset.messageId:active===detail?'detail':null)};
  if(active.dataset.scopeValue)return {kind:'scope',key:active.dataset.scopeValue};
  if(active.dataset.recordFocus)return {kind:'workspace',key:active.dataset.recordFocus};
  return null;
}
export function restoreRecordFocus(root,memory,{reveal=false}={}){
  if(!memory||root.closest('.app-view')?.hidden)return;
  const detail=root.querySelector('.person-record,.conversation'),same=memory.kind==='detail'&&detailId(detail)===memory.id;
  let target=null;
  if(memory.kind==='scope')target=[...root.querySelectorAll('[data-scope-value]')].find(element=>element.dataset.scopeValue===memory.key);
  else if(memory.kind==='workspace'||same){
    target=memory.key?.startsWith('message:')?[...root.querySelectorAll('[data-message-id]')].find(element=>element.dataset.messageId===memory.key.slice(8)):
      [...(same?detail:root).querySelectorAll('[data-record-focus]')].find(element=>element.dataset.recordFocus===memory.key);
    if(memory.key==='detail'&&same)target=detail;
  }
  if(!visible(target)){
    const candidates=[root.querySelector('[data-record-focus="loading"]'),root.querySelector('[data-record-focus="retry"]')];
    if(memory.kind==='detail'&&!same)candidates.push(root.querySelector('[data-record-id][aria-pressed="true"]'));
    candidates.push(detail?.querySelector('[data-record-focus="heading"]'),detail,root.closest('.app-view')?.querySelector('input[type="search"]'));
    target=candidates.find(visible);
  }
  if(!target)return;
  if(target.dataset.messageId||target.dataset.recordFocus==='heading'||target.dataset.recordFocus==='loading')target.tabIndex=-1;
  target.focus({preventScroll:true});if(reveal)target.scrollIntoView({block:'nearest'});
}

// A responsive display:none can blur its control before matchMedia's change
// callback runs. Recover only that record's last focus, never external focus.
export function viewportRecordFocus(root,current,last,route){
  if(current)return current;
  const doc=root.ownerDocument||document;
  if(doc.activeElement!==doc.body||last?.rootId!==root.id||last.route!==route||root.closest('.app-view')?.hidden)return null;
  const detail=root.querySelector('.person-record,.conversation');
  if(last.memory?.kind!=='detail'||detailId(detail)!==last.memory.id)return null;
  return {...last.memory};
}
