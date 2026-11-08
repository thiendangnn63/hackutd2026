import {stateClient} from './state-client.js';
import {rememberDrafts,restoreDrafts,createCaseDraftStore,readMessageDraft,writeMessageDraft} from './form-drafts.js';
import {createProposalView,rememberProposalState} from './proposal-view.js';
'use strict';
let state = null;
let selectedCaseId = null;
let busy = false;
let hasRendered=false,stateDirty=false;
const caseDrafts=createCaseDraftStore();
let pendingSmsCaseId=null,exampleMessageDraft=null;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
const label = value => String(value || 'unknown').replaceAll('_', ' ');
const names = value => Array.isArray(value) ? value.join(' and ') : (value || 'Unnamed family');
const formatTime = value => { if (!value) return 'Time unavailable'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString('en-GB', { timeZone:'UTC', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) + ' UTC'; };
const tag = (text, tone = 'muted') => el('span', 'tag ' + tone, text);
const empty = text => el('p', 'empty', text);
const person = id => state.participants.find(p => p.id === id)?.name || id || 'Unknown';
const providerIds=()=>[...(state?.reports||[]).map(report=>report.providerEventId),exampleMessageDraft?.providerEventId].filter(Boolean);
function rememberMessageDraft(){
  const memory=readMessageDraft($('#sms-form'));if(memory)caseDrafts.saveMessage(memory.caseId,memory.draft);
}
function rememberScopedDrafts(memory){
  const verification=memory?.forms.find(form=>form.id==='verify-form');if(verification?.caseId)caseDrafts.saveVerification(verification.caseId,verification);
  rememberMessageDraft();
}
function restoreVerificationDraft(){
  const draft=caseDrafts.verification($('#case-detail').dataset.caseId);
  if(draft)restoreDrafts(document,{forms:[draft]},{focus:false,scroll:false});
}
function targetMessageCase(caseId){
  if(!state?.cases.some(item=>item.id===caseId))return;
  rememberMessageDraft();pendingSmsCaseId=caseId;renderSelects();
}
function notify(text, error = false) { const node = $('#notice'); const message=el('span','notice-message',text);const dismiss=el('button','notice-dismiss','×');dismiss.type='button';dismiss.setAttribute('aria-label','Dismiss status message');dismiss.addEventListener('click',()=>{node.hidden=true;const heading=$('#casework-view h1');heading.tabIndex=-1;heading.focus({preventScroll:true});});node.replaceChildren(message,dismiss);node.className = 'notice' + (error ? ' error' : ''); node.hidden = false; node.scrollIntoView({block:'nearest', behavior:'smooth'}); }
async function request(path,payload){
  const body=await stateClient.request(path,payload);state=stateClient.getState();return body;
}
async function mutate(path, payload, success, onResult) {
  if (busy) return;
  const actionFocus=rememberDrafts(),actionRoute=location.hash;
  busy = true; const buttons = $$('button'); buttons.forEach(b => { b.dataset.wasDisabled = b.disabled ? 'true' : 'false'; b.disabled = true; });
  document.body.setAttribute('aria-busy','true'); notify('Processing local simulation…');
  try { const result = await request(path,payload); if (onResult) onResult(result); render(); notify(result.duplicate ? 'Duplicate event recognized. No additional reports or messages were created.' : (typeof success === 'function' ? success(result) : success)); document.dispatchEvent(new CustomEvent('family-action-complete',{detail:{path,duplicate:Boolean(result.duplicate)}})); }
  catch (error) { notify(error.message, true); }
  finally { busy = false; if(stateDirty&&state)render(); document.body.removeAttribute('aria-busy'); buttons.forEach(b => { if (b.isConnected) { b.disabled = b.dataset.wasDisabled === 'true'; delete b.dataset.wasDisabled; } });
    if(location.hash===actionRoute&&document.activeElement===document.body)restoreDrafts(document,{...actionFocus,forms:[]},{scroll:false});
  }
}
async function load() {
  $('#loading').hidden = false; $('#load-error').hidden = true;
  try { await request('/api/state'); render(); $('#workspace').hidden = false; }
  catch(error) { if(!hasRendered){ $('#load-error').hidden = false; $('#load-error-text').textContent = error.message; } }
  finally { $('#loading').hidden = true; }
}
function render() {
  const drafts=hasRendered?rememberDrafts():null;
  rememberScopedDrafts(drafts);caseDrafts.prune(state.cases);
  if (!state.cases.some(c => c.id === selectedCaseId)) selectedCaseId = state.cases.at(-1)?.id;
  renderStats(); renderTiles(); renderQueue(); renderCase(); renderSelects(); renderNeeds(); renderMessages(); renderAudit();
  restoreVerificationDraft();if(drafts)restoreDrafts(document,{...drafts,forms:drafts.forms.filter(form=>form.id==='case-form')});hasRendered=true;stateDirty=false;
  document.dispatchEvent(new CustomEvent('family-state-changed', {detail:state}));
}
function renderStats() {
  const items = [
    ['Cases needing follow-up',state.cases.filter(c => c.reviewState !== 'resolved').length,'Unanswered stays open'],
    ['Unverified sightings',state.cases.filter(c => c.locationState === 'unverified_sighting').length,'Leads, not safety confirmation'],
    ['Open assistance tasks',state.assistance.filter(a => a.status !== 'completed').length,'Tracked independently'],
    ['Simulated messages',state.outbox.length,'No external delivery']
  ];
  $('#stats').replaceChildren(...items.map(([title,value,note]) => { const node = el('article','stat'); node.append(el('div','stat-label',title),el('div','stat-value',value),el('div','stat-note',note)); return node; }));
}
function renderTiles() {
  const policy = state.incident.policy; const now = new Date(state.scenarioTime).valueOf();
  $('#tile-grid').replaceChildren(...state.incident.tiles.map(tile => {
    const eligible = state.participants.filter(p => p.id !== 'mom' && p.currentTile === tile && p.optedIn && now - new Date(p.locationReportedAt).valueOf() <= policy.locationMaxAgeMinutes * 60000 && now >= new Date(p.locationReportedAt).valueOf());
    const needs = state.assistance.filter(a => a.status !== 'completed' && state.cases.find(c => c.id === a.caseId)?.lastKnownTile === tile);
    const node = el('div','tile'); const heading = el('div','tile-title'); heading.append(el('span','',tile),el('span','tile-caption','DEMO TILE'));
    node.append(heading,el('div','tile-metric',`${eligible.length} eligible contributor${eligible.length === 1 ? '' : 's'}`),el('div','tile-need',`${needs.length} open reported need${needs.length === 1 ? '' : 's'}`)); return node;
  }));
  $('#policy').textContent = `Policy: up to ${policy.maxTiles} tiles · location within ${policy.locationMaxAgeMinutes} minutes · up to ${policy.maxRecipients} recipients. Needs grouped by case’s last known tile, not a verified incident location.`;
}
function renderQueue() {
  $('#case-count').textContent = `${state.cases.length} fictional cases`;
  const nodes = [...state.cases].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(c => { const button = el('button','case-card'); button.type='button';button.dataset.recordFocus='case-card:'+c.id; button.setAttribute('aria-pressed',String(c.id === selectedCaseId)); button.append(el('div','case-id',c.id),el('strong','',names(c.subjectNames)),tag(label(c.reviewState),c.reviewState === 'resolved' ? 'teal' : 'amber'),tag(label(c.welfareState))); button.addEventListener('click',() => { const memory=rememberDrafts();rememberScopedDrafts(memory);selectedCaseId=c.id;caseDrafts.prune(state.cases);renderQueue();renderCase();restoreVerificationDraft();restoreDrafts(document,{...memory,forms:[]},{scroll:false}); }); return button; });
  $('#case-list').replaceChildren(...(nodes.length ? nodes : [empty('No cases yet. Create a fictional family report below.')]));
}
function renderCase() {
  const root = $('#case-detail'); rememberProposalState(root); const c = state.cases.find(c => c.id === selectedCaseId); root.replaceChildren();
  root.dataset.caseId=c?.id||'';
  if (!c) { root.append(empty('Select or create a case to review its evidence.')); return; }
  const title = el('div','case-title'); const heading = el('div'); heading.append(el('div','eyebrow',`${c.id} / FAMILY INQUIRY`),el('h2','',names(c.subjectNames))); title.append(heading,tag(label(c.reviewState),c.reviewState==='resolved'?'teal':'amber')); root.append(title,el('p','fine-print','Original inquiry'),el('p','case-description',c.description));
  heading.querySelector('h2').dataset.recordFocus='heading';heading.querySelector('h2').tabIndex=-1;
  root.append(el('p','fine-print',`Last known: ${c.lastKnownTile} · Last contact: ${formatTime(c.lastContactAt)} · Search: ${c.searchTiles.join(', ') || 'no tiles'}`));
  const status = el('div','status-grid'); [['Location',c.locationState],['Welfare',c.welfareState],['Outreach',c.outreachState]].forEach(([name,value])=> { const item = el('div','status-item'); item.append(el('small','',name),el('strong','',label(value))); status.append(item); }); root.append(status); if(c.nextStep)root.append(el('p','panel-intro',c.nextStep));
  const outreach = el('div','outreach-row'); const outreachCopy = el('div'); outreachCopy.append(el('h3','','Scoped outreach'),el('p','','Fresh, opted-in contributors only. Simulation only.'));
  const send = el('button','button small',c.outreachState === 'stopped' ? 'Outreach stopped' : 'Queue simulated inquiry'); send.type='button'; send.disabled=['needs_review','stopped'].includes(c.outreachState) || c.reviewState === 'resolved'; send.addEventListener('click',()=>mutate(`/api/cases/${encodeURIComponent(c.id)}/outreach`,{},result => result.queued === 0 ? 'No new inquiries queued. Check the case’s next step: there may be no eligible recipients, or an inquiry was already queued.' : `${result.queued ?? 'Eligible'} inquiry messages queued in simulation. No real SMS sent.`)); outreach.append(outreachCopy,send); root.append(outreach);
  send.dataset.recordFocus='outreach';
  if(c.policyReasons?.length) root.append(el('p','policy-reasons',`Policy review: ${c.policyReasons.map(label).join(' · ')}`));
  const reports = state.reports.filter(r=>r.caseId===c.id);
  root.append(el('h3','',`Reported evidence (${reports.length})`));
  const verificationForm=el('form'); verificationForm.id='verify-form';
  const evidenceList=el('div','evidence-list');
  reports.forEach(r=>{
    const card=el('article','evidence'); const head=el('div','evidence-header'); const select=el('label','evidence-select'); const check=el('input'); check.type='checkbox'; check.name='evidenceIds'; check.value=r.id; check.disabled=Boolean(c.verification)||Boolean(r.modelReview&&r.modelReview.status!=='accepted'); select.append(check,document.createTextNode(`${r.id} · ${person(r.senderId)}`)); head.append(select,tag(r.processingState==='needs_review'?'Needs review':'Reported, not verified', 'amber')); card.append(head,el('p','evidence-text',r.text),el('small','',`Observed ${formatTime(r.observedAt)} · ${label(r.processingPath)}`));
    (r.observations || []).forEach(o=>{ const observation=el('div','observation'); observation.append(el('strong','',label(o.type)),el('p','',o.summary)); if(o.sourceSpan) observation.append(el('p','',`Source: “${o.sourceSpan}”`)); card.append(observation); });
    const proposal=createProposalView(r);if(proposal)card.append(proposal);
    if(r.reviewFlags?.length) card.append(el('p','review-flag',`Review flags: ${r.reviewFlags.map(label).join(' · ')}`)); evidenceList.append(card);
  });
  if(!reports.length) evidenceList.append(empty('No evidence received. The case remains open. Silence is not a safety signal.'));
  verificationForm.append(evidenceList);
  if(c.verification) {
    root.append(verificationForm); const verified=el('div','resolved-note'); verified.append(el('strong','',`Officer-reviewed: ${label(c.welfareState)}`),el('p','',c.verification.note),el('p','fine-print',`${c.verification.officerName} · ${formatTime(c.verification.verifiedAt)} · Evidence: ${c.verification.evidenceIds.join(', ')}`),el('p','','Any open assistance tasks remain open separately.')); root.append(verified);
  } else {
    const box=el('div','verification'); box.append(el('h3','','Officer verification'),el('p','panel-intro','Demo officer role. Select supporting reports and record an actual fictional verification basis. A neighbor’s sighting alone does not establish safety.'));
    const noteLabel=el('label','','Verification basis'); const note=el('textarea'); note.name='note'; note.rows=3; note.required=true; note.minLength=20; note.maxLength=1500; note.placeholder='Describe the fictional responder check-in and how location and welfare were confirmed.'; noteLabel.append(note);
    const welfareLabel=el('label','','Verified welfare outcome'); const welfare=el('select'); welfare.name='welfare'; [['assistance_needed','Located; assistance needed'],['confirmed_safe','Confirmed safe']].forEach(([value,text])=>{const option=el('option','',text);option.value=value;welfare.append(option);}); welfareLabel.append(welfare);
    const submit=el('button','button primary','Verify outcome & stop inquiry'); submit.type='submit';submit.disabled=!reports.some(report=>(!report.modelReview||report.modelReview.status==='accepted')&&report.observations.some(observation=>observation.type==='sighting'));
    submit.dataset.recordFocus='verify-submit';
    box.append(noteLabel,welfareLabel,el('p','fine-print',submit.disabled?'A reviewed sighting and a direct confirmation basis are needed before verification. Unaccepted suggestions cannot verify welfare.':'Recorded as Officer Rivera (demo). Resolves the inquiry, not assistance tasks.'),submit); verificationForm.append(box);
    verificationForm.addEventListener('submit',event=>{event.preventDefault(); const data=new FormData(verificationForm); const evidenceIds=data.getAll('evidenceIds'); if(!evidenceIds.length){notify('Select at least one supporting evidence report before verifying.',true);return;} mutate(`/api/cases/${encodeURIComponent(c.id)}/verify`,{officerName:'Officer Rivera (demo)',evidenceIds,note:String(data.get('note')).trim(),welfare:data.get('welfare'),resolve:true},'Officer review recorded. Inquiry stopped; outstanding assistance is still tracked separately.');}); root.append(verificationForm);
  }
}
function renderSelects() {
  const form=$('#sms-form'),caseSelect=$('#sms-case'),requested=pendingSmsCaseId||form.dataset.draftCaseId||caseSelect.value||selectedCaseId;
  const caseId=state.cases.some(item=>item.id===requested)?requested:state.cases.some(item=>item.id===selectedCaseId)?selectedCaseId:state.cases[0]?.id;
  caseSelect.replaceChildren(...state.cases.map(c=>{const option=el('option','',`${c.id} · ${names(c.subjectNames)}`);option.value=c.id;return option;}));caseSelect.value=caseId||'';
  const senderSelect=$('#sms-sender');const previousSender=senderSelect.value; senderSelect.replaceChildren(...state.participants.map(p=>{const option=el('option','',`${p.name}${p.optedIn?'':' (opted out)'}`);option.value=p.id;return option;}));senderSelect.value=state.participants.some(p=>p.id===previousSender)?previousSender:'neighbor-1';
  pendingSmsCaseId=null;
  const draft=caseDrafts.message(caseId,{usedIds:providerIds()});writeMessageDraft(form,caseId,draft);if(!draft)return;
  if(!state.participants.some(item=>item.id===senderSelect.value))senderSelect.value='neighbor-1';
}
function renderNeeds() {
  $('#needs-list').replaceChildren(...(state.assistance.length?state.assistance.map(a=>{const node=el('article','need-card');node.append(tag(label(a.status),a.status==='completed'?'teal':'amber'),el('h3','',label(a.type)),el('p','',a.summary),el('small','',`${a.caseId} · ${a.reportId} · Reported need, not independently verified`));return node;}):[empty('No assistance reports yet. Water requests will appear here, separately from family safety. Road blockages remain in reported evidence.')]));
}
function renderMessages() {
  $('#message-list').replaceChildren(...(state.outbox.length?[...state.outbox].reverse().map(m=>{const node=el('article','message');const head=el('div','message-heading');head.append(el('strong','',`${label(m.kind)} · ${m.caseId}`),tag('SIMULATED','teal'));node.append(head,el('p','',m.text),el('small','',`To ${person(m.recipientId)} · ${formatTime(m.createdAt)}`));return node;}):[empty('No simulated messages yet. Outreach and family updates will appear here with their exact wording.')]));
}
function renderAudit() {
  $('#audit-count').textContent=`(${state.audit.length} events)`;$('#audit-list').replaceChildren(...[...state.audit].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,75).map(a=>{const row=el('div','audit-entry');const text=el('div');text.append(el('strong','',label(a.action)),el('p','',typeof a.detail==='string'?a.detail:JSON.stringify(a.detail)));row.append(el('span','',formatTime(a.at)),text);return row;}));
}
$('#case-form').addEventListener('submit',event=>{event.preventDefault();const data=new FormData(event.currentTarget);const searchTiles=data.getAll('searchTiles');if(!searchTiles.length){notify('Choose at least one outreach tile.',true);return;}mutate('/api/cases',{subjectNames:String(data.get('subjectNames')).trim(),description:String(data.get('description')).trim(),reporterId:'mom',lastKnownTile:data.get('lastKnownTile'),lastContactAt:new Date(data.get('lastContactAt')+'Z').toISOString(),searchTiles,consentToOutreach:data.get('consentToOutreach')==='on'},'Family case created. Review the policy status before queuing simulated outreach.',result=>{selectedCaseId=result.caseId||state.cases.at(-1)?.id;if(exampleMessageDraft&&String(data.get('subjectNames')).trim()==='Rosa and Miguel Santos')caseDrafts.saveMessage(selectedCaseId,exampleMessageDraft);exampleMessageDraft=null;targetMessageCase(selectedCaseId);});});
$('#sms-form').addEventListener('submit',event=>{event.preventDefault();const data=new FormData(event.currentTarget);mutate('/api/reports',{providerEventId:String(data.get('providerEventId')).trim(),senderId:data.get('senderId'),caseId:data.get('caseId'),text:String(data.get('text')).trim(),observedAt:data.get('observedAt')?new Date(data.get('observedAt')+'Z').toISOString():null,simulateFailure:data.get('simulateFailure')==='on'},'Simulated SMS processed. Review the evidence and processing status; no safety outcome is inferred.',()=>{selectedCaseId=data.get('caseId');});});
$('#example').addEventListener('click',()=>{const form=$('#case-form');form.elements.subjectNames.value='Rosa and Miguel Santos';form.elements.description.value='Mom is looking for her parents, Rosa and Miguel Santos. Last contact was before the road closures. Please ask nearby opted-in neighbors for a recent sighting.';form.elements.lastKnownTile.value='A1';form.elements.lastContactAt.value='2026-11-07T12:00';$$('input[name=searchTiles]',form).forEach(c=>c.checked=c.value==='A1');form.elements.consentToOutreach.checked=true;rememberMessageDraft();exampleMessageDraft={text:'I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.',senderId:'neighbor-1',observedAt:'2026-11-07T14:20',providerEventId:caseDrafts.nextMessageId(providerIds()),simulateFailure:false};notify('Grandparents inquiry filled in. Its example SMS will be ready in Message lab after you create the case.');$('#family').scrollIntoView({behavior:'smooth',block:'start'});form.elements.subjectNames.focus({preventScroll:true});});
$('#sms-case').addEventListener('change',event=>targetMessageCase(event.detail?.caseId||event.currentTarget.value));
for(const [selector,key]of [['#case-form button[type=submit]','intake-submit'],['#sms-form button[type=submit]','message-submit']])$(selector).dataset.recordFocus=key;
stateClient.subscribe(next=>{
  state=next;stateDirty=true;
  if(!busy){render();$('#workspace').hidden=false;$('#loading').hidden=true;$('#load-error').hidden=true;}
});
try{stateClient.connect();}catch{/* HTTP loading and all local controls remain available without streaming. */}
let resetTrigger = null;
function resetDemo(event) {
  resetTrigger = event.currentTarget;
  $('#reset-confirmation').hidden = false;
  $('#reset-confirmation').scrollIntoView({behavior:'smooth',block:'center'});
  $('#reset-heading').focus({preventScroll:true});
}
function cancelReset() {
  $('#reset-confirmation').hidden = true;
  resetTrigger?.focus();
}
$('#reset').addEventListener('click',resetDemo);
$('#reset-footer').addEventListener('click',resetDemo);
$('#reset-cancel').addEventListener('click',cancelReset);
$('#reset-confirmation').addEventListener('keydown',event=>{if(event.key==='Escape' && !busy){event.preventDefault();cancelReset();}});
$('#reset-confirm').addEventListener('click',()=>mutate('/api/reset',{},'Fictional demo reset. C104 remains an unanswered, open case.',()=>{
  selectedCaseId=null;
  caseDrafts.clear();exampleMessageDraft=null;pendingSmsCaseId=null;hasRendered=false;$('#sms-form').dataset.draftCaseId='';
  $('#case-form').reset();
  $('#sms-form').reset();
  $('#reset-confirmation').hidden=true;
  // The trigger remains disabled until mutation cleanup finishes.
  setTimeout(()=>resetTrigger?.focus(),0);
}));
$('#retry').addEventListener('click',load);
load();

// Satellite data has its own request/state path; never feed it to family-state mutations.
const satelliteClasses = ['no-damage','minor-damage','major-damage','destroyed'];
let satelliteData = null;
let satelliteTileId = null;
let satelliteBuildingId = null;
let satellitePending = false;
let satelliteError = '';
const satelliteInferences = new Map();
async function satelliteRequest(path, payload) {
  const response = await fetch(path, payload === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  let body;
  try { body = await response.json(); } catch { throw new Error('Satellite evidence returned an unreadable response.'); }
  if (!response.ok) throw new Error(body.error || `Satellite request failed (${response.status}).`);
  return body;
}
async function loadSatellite() {
  const root = $('#satellite-content');
  root.replaceChildren(el('p','empty','Checking for an imported trained model…'));
  try { const next = await satelliteRequest('/api/satellite'); if (next.model?.sha256 !== satelliteData?.model?.sha256) satelliteInferences.clear(); satelliteData = next; satelliteError = ''; renderSatellite(); }
  catch (error) {
    root.replaceChildren(el('h3','','Satellite evidence unavailable'),el('p','panel-intro',error.message));
    const retry = el('button','button small','Retry satellite evidence'); retry.type='button'; retry.addEventListener('click',loadSatellite); root.append(retry);
  }
}
function satellitePercent(value) { return typeof value === 'number' && Number.isFinite(value) ? `${(value*100).toFixed(1)}%` : 'Not reported'; }
function satelliteKey(tileId, buildingId) { return JSON.stringify([tileId,buildingId]); }
function satelliteImage(tile, building, phase) {
  const figure = el('figure','satellite-image');
  figure.append(el('figcaption','',phase === 'pre' ? 'Before Hurricane Harvey · 2017' : 'After Hurricane Harvey · 2017'));
  const src = phase === 'pre' ? tile.preImageUrl : tile.postImageUrl;
  let url;
  try { url = new URL(src,location.origin); } catch { /* Invalid URLs are not rendered. */ }
  if (typeof src !== 'string' || !url || url.origin !== location.origin || !url.pathname.startsWith('/api/satellite/')) {
    figure.append(empty('Image unavailable.')); return figure;
  }
  const frame = el('div','satellite-image-frame');
  const image = el('img'); image.src=url.href; image.alt=`Historical ${phase === 'pre' ? 'before' : 'after'} satellite image, tile ${tile.id}`; image.width=tile.width; image.height=tile.height;
  image.addEventListener('error',()=>frame.replaceChildren(empty('Image could not be loaded. No substitute imagery is shown.')),{once:true});
  frame.append(image);
  const box = building?.box;
  if (Number.isFinite(tile.width) && tile.width>0 && Number.isFinite(tile.height) && tile.height>0 && Array.isArray(box) && box.length===4 && box.every(Number.isFinite) && box[0]>=0 && box[1]>=0 && box[2]<=tile.width && box[3]<=tile.height && box[2]>box[0] && box[3]>box[1]) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox',`0 0 ${tile.width} ${tile.height}`); svg.setAttribute('aria-hidden','true');
    const rect=document.createElementNS(svg.namespaceURI,'rect');
    for (const [key,value] of Object.entries({x:box[0],y:box[1],width:box[2]-box[0],height:box[3]-box[1]})) rect.setAttribute(key,String(value));
    rect.setAttribute('vector-effect','non-scaling-stroke'); svg.append(rect); frame.append(svg);
  }
  figure.append(frame); return figure;
}
function satellitePrediction(prediction, title) {
  const card=el('article','satellite-result'); card.append(el('h3','',title));
  if (!prediction || prediction.state!=='estimated' || !['cached_model_output','local_model_inference'].includes(prediction.source) || !satelliteClasses.includes(prediction.damageClass)) {
    card.append(empty('No valid model estimate available.')); return card;
  }
  card.append(tag(`Estimated: ${prediction.damageClass}`,'amber'),el('p','fine-print','Uncalibrated model probabilities, not confidence in safety.'));
  const list=el('dl','satellite-probabilities');
  satelliteClasses.forEach((name,index)=>{ list.append(el('dt','',name),el('dd','',satellitePercent(Array.isArray(prediction.probabilities)?prediction.probabilities[index]:prediction.probabilities?.[name]))); });
  card.append(list);
  if (prediction.source==='local_model_inference') card.append(el('p','fine-print',`Computed ${formatTime(prediction.computedAt)} · ${Number.isFinite(prediction.durationMs)?prediction.durationMs+' ms':'duration not reported'}`),el('p','fine-print satellite-hash',`Model SHA-256: ${prediction.modelSha256 || 'Not reported'}`));
  return card;
}
function renderSatellite() {
  const root=$('#satellite-content'); root.replaceChildren();
  if (!satelliteData?.available) {
    root.append(el('h3','','Trained model not imported yet'),el('p','panel-intro',satelliteData?.reason || 'No trained model results or imagery are available.'));
    const refresh=el('button','button small','Check for imported model'); refresh.type='button'; refresh.addEventListener('click',loadSatellite); root.append(refresh); return;
  }
  const tiles=Array.isArray(satelliteData.tiles)?satelliteData.tiles:[];
  const tile=tiles.find(t=>t.id===satelliteTileId) || tiles[0]; satelliteTileId=tile?.id;
  const buildings=Array.isArray(tile?.buildings)?tile.buildings:[];
  const building=buildings.find(b=>b.id===satelliteBuildingId) || buildings[0]; satelliteBuildingId=building?.id;
  const controls=el('div','satellite-controls');
  for (const [title,items,selected,onChange] of [
    ['Held-out satellite tile',tiles,tile?.id,value=>{satelliteTileId=value;satelliteBuildingId=null;}],
    ['Known building crop',buildings,building?.id,value=>{satelliteBuildingId=value;}]
  ]) {
    const wrapper=el('label','',title); const select=el('select');
    select.replaceChildren(...items.map(item=>{const option=el('option','',item.id);option.value=item.id;return option;})); select.value=selected || ''; select.disabled=satellitePending || !items.length;
    select.addEventListener('change',()=>{onChange(select.value);satelliteError='';renderSatellite();}); wrapper.append(select);controls.append(wrapper);
  }
  root.append(controls);
  if (tile) {
    const pair=el('div','satellite-pair'); pair.append(satelliteImage(tile,building,'pre'),satelliteImage(tile,building,'post'));root.append(pair);
    root.append(el('p','fine-print',building?`Outline: selected building crop ${building.id} only. The box is supplied, not detected by the classifier.`:'No building crops available for this tile.'));
  } else root.append(empty('No held-out image tiles are available.'));
  if (building) {
    const results=el('div','satellite-results');results.append(satellitePrediction(building,'Cached model output'));
    const live=satelliteInferences.get(satelliteKey(tile.id,building.id)); if(live)results.append(satellitePrediction(live,'Local model inference'));
    root.append(results);
    const infer=el('button','button small',satellitePending?'Running local inference…':'Run local inference on this crop');infer.type='button';infer.disabled=satellitePending || !satelliteData.liveInferenceAvailable;
    infer.addEventListener('click',()=>runSatelliteInference(tile.id,building.id));root.append(infer);
    const status=el('p','fine-print',satellitePending?'Computing locally. Family-case state is unchanged.':satelliteData.liveInferenceAvailable?'Uses the imported model and selected historical before/after crop locally.':'Local inference unavailable. Only cached model outputs are shown.');status.setAttribute('role','status');root.append(status);
  }
  if(satelliteError){const error=el('p','notice error',satelliteError);error.setAttribute('role','alert');root.append(error);}
  renderSatelliteMetadata(root);
}
function renderSatelliteMetadata(root) {
  const model=satelliteData.model || {}; const metrics=satelliteData.metrics || {};
  const detail=el('details','satellite-metadata');detail.append(el('summary','','Model, held-out evaluation, and limitations'));
  detail.append(el('p','fine-print',`${model.architecture || 'Architecture not reported'} · Best epoch: ${model.bestEpoch ?? 'Not reported'}`),el('p','fine-print satellite-hash',`Model SHA-256: ${model.sha256 || 'Not reported'}`));
  detail.append(el('p','panel-intro',`Held-out macro F1: ${satellitePercent(metrics.macroF1)} · Majority baseline macro F1: ${satellitePercent(metrics.majorityMacroF1)} · Accuracy: ${satellitePercent(metrics.accuracy)}`));
  const perClass=metrics.perClass;
  const rows=Array.isArray(perClass)?perClass.map((row,index)=>[row.class || row.label || satelliteClasses[index],row]):Object.entries(perClass || {});
  const weak=rows.filter(([,row])=>Number.isFinite(row.f1) && row.f1<0.5 && row.support>0);
  if(weak.length) root.append(el('p','notice',`Research demo only. Low held-out F1: ${weak.map(([name,row])=>`${name} ${satellitePercent(row.f1)}`).join('; ')}. Predictions require independent review.`));
  for(const [name,row] of rows) detail.append(el('p','fine-print',`${name}: F1 ${satellitePercent(row.f1)} · Support ${row.support ?? 'Not reported'}`));
  if (!rows.length) detail.append(el('p','fine-print','Per-class evaluation not reported.'));
  const list=el('ul','satellite-limitations');
  list.append(el('li','','Single-event, tile-disjoint evaluation does not establish performance on other disasters.'));
  for(const limitation of satelliteData.limitations || [])list.append(el('li','',limitation));
  detail.append(list);root.append(detail);
  const attribution=satelliteData.attribution || {};
  root.append(el('p','fine-print',`${attribution.dataset || 'xBD / xView2'} · ${Array.isArray(attribution.authors)?attribution.authors.join(', '):attribution.authors || 'Gupta et al.; DIU, CMU SEI and collaborators; Maxar imagery'}`),el('p','fine-print',`License: ${attribution.license || 'CC BY-NC-SA 4.0'}. Noncommercial use only; attribution and applicable share-alike terms required.`));
  for (const [title,value] of [['Dataset source',attribution.source],['License terms',attribution.license_url]]) {
    if (typeof value !== 'string') continue;
    let url;try {url=new URL(value);}catch{continue;}
    if(url.protocol!=='https:')continue;
    const link=el('a','satellite-source',title);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';root.append(link);
  }
}
async function runSatelliteInference(tileId,buildingId) {
  if(satellitePending || !satelliteData?.liveInferenceAvailable)return;
  satellitePending=true;satelliteError='';renderSatellite();
  try {
    const result=await satelliteRequest('/api/satellite/infer',{tileId,buildingId});
    if(result.prediction?.source!=='local_model_inference' || result.prediction?.state!=='estimated')throw new Error('No valid local inference result was returned.');
    satelliteInferences.set(satelliteKey(tileId,buildingId),result.prediction);
  }catch(error){satelliteError=error.message;}
  finally{satellitePending=false;renderSatellite();}
}
loadSatellite();
