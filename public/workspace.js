import {node,button,icon,iconButton,title,count} from './ui.js';
import {searchPeople,messageThreads,caseEvents} from './records.js';
const $=s=>document.querySelector(s);
const mobile=()=>window.matchMedia('(max-width:760px)').matches;
let familyState=null,selectedPerson=null,selectedThread=null,archiveData=null,archiveId=null;
let peopleScope='all',messageScope='all',personOpen=false,threadOpen=false,comparison=50;
const time=value=>{const d=new Date(value);return !value||Number.isNaN(d.valueOf())?'Time not recorded':new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d)+' CT';};
const subjectName=c=>Array.isArray(c.subjectNames)?c.subjectNames.join(' and '):c.subjectNames;
const initials=name=>{const words=name.split(' · ')[0].split(/\s+/).filter(s=>!['and','&'].includes(s.toLowerCase()));return [words[0]?.[0],words.length>1?words.at(-1)[0]:''].join('').toUpperCase();};
const pill=(text,tone='')=>node('span',`pill ${tone}`,text);
const welfareTone=value=>value==='confirmed_safe'?'green':value==='assistance_needed'?'amber':'';
function emptyState(heading,description,action){const e=node('div','empty-state');e.append(icon('search'),node('h3','',heading),node('p','',description));if(action)e.append(action);return e;}
function clearSearch(input){input.value='';input.dispatchEvent(new Event('input'));input.focus();}
function searchControls(){for(const input of [$('#person-search'),$('#message-search')]){
  const clear=iconButton('close',input.id==='person-search'?'Clear person search':'Clear message search',()=>clearSearch(input),'search-clear icon-button');clear.hidden=!input.value;input.parentElement.append(clear);
  input.addEventListener('input',()=>{clear.hidden=!input.value;});input.addEventListener('keydown',e=>{if(e.key==='Escape'&&input.value){e.preventDefault();clearSearch(input);}});
}}
function openConversation(caseId){
  selectedThread=caseId;messageScope='all';threadOpen=true;
  $('#message-search').value='';$('#message-search').dispatchEvent(new Event('input'));threadOpen=true;
  if(location.hash==='#messages')renderMessages();else location.hash='messages';
}
function openMessageLab(caseId){
  if(!caseId||caseId==='unassigned')return;
  $('#sms-case').value=caseId;$('#sms-case').dispatchEvent(new Event('change'));
  location.hash='simulator';requestAnimationFrame(()=>$('#sms-form textarea').focus({preventScroll:true}));
}
function route(){
  const hash=location.hash.slice(1)||'mayor',aliases={overview:'casework',family:'casework',simulator:'casework',assistance:'casework',satellite:'imagery'};
  const name=aliases[hash]||(['mayor','messages','people','casework','imagery'].includes(hash)?hash:'mayor');
  for(const [id,view]of [['map-view','mayor'],['messages-view','messages'],['people-view','people'],['casework-view','casework'],['imagery-view','imagery']])$('#'+id).hidden=name!==view;
  for(const a of document.querySelectorAll('.rail-link')){if(a.dataset.view===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
  $('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');
  if(name==='people')renderPeople();if(name==='messages')renderMessages();if(name==='imagery')loadArchive();
  if(name==='casework'){const section=hash==='family'?'intake':hash==='simulator'?'lab':hash==='assistance'?'assistance':'review';$('#casework-view').dataset.section=section;for(const a of document.querySelectorAll('.casework-navigation a')){if(a.dataset.section===section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}}
  if(aliases[hash])requestAnimationFrame(()=>$('#'+hash)?.scrollIntoView({block:'start'}));
  document.title=`${name==='mayor'?'Houston map':title(name)} · Family Response`;
}
function recordEvent(heading,text,at,extra=''){
  const e=node('article','record-event');e.append(node('strong','',heading),node('p','',text),node('small','',`${time(at)}${extra?' · '+extra:''}`));return e;
}
function scopeToolbar(type,choices,current,change,total){
  const toolbar=node('div','records-toolbar'),group=node('div','record-filters');group.setAttribute('role','group');group.setAttribute('aria-label',type+' filters');
  for(const [value,label]of choices){const b=button(label,()=>change(value),'filter-chip');b.setAttribute('aria-pressed',String(current===value));group.append(b);}
  toolbar.append(group,node('span','results-count',`${count(total)} ${total===1?(type==='Records'?'record':'conversation'):type.toLowerCase()}`));return toolbar;
}
function rememberList(root,selector){const old=root.querySelector(selector);return {scroll:old?.scrollTop||0,focus:document.activeElement?.dataset.recordId};}
function restoreList(list,memory){list.scrollTop=memory.scroll;if(memory.focus){const row=[...list.querySelectorAll('[data-record-id]')].find(e=>e.dataset.recordId===memory.focus);row?.focus({preventScroll:true});}}
function renderPeople(){
  if(!familyState)return;
  const root=$('#people-workspace'),memory=rememberList(root,'.people-list'),query=$('#person-search').value;
  const people=searchPeople(familyState,query,peopleScope);root.replaceChildren();
  root.append(scopeToolbar('Records',[['all','All records'],['inquiries','Family inquiries'],['community','Community']],peopleScope,value=>{peopleScope=value;personOpen=false;renderPeople();},people.length));
  if(!people.length){root.append(emptyState('No matching records','Try a name, last-known area, or phrase from a message.',query?button('Clear search',()=>clearSearch($('#person-search')),'control'):null));return;}
  if(!people.some(p=>p.id===selectedPerson))selectedPerson=people[0].id;
  const layout=node('div','people-layout'+(personOpen?' is-detail':'')),list=node('div','people-list');list.setAttribute('aria-label','Matching people');
  for(const p of people){
    const b=button('',()=>{selectedPerson=p.id;personOpen=true;renderPeople();if(mobile())$('#people-workspace .person-record').focus({preventScroll:true});},'person-row');b.dataset.recordId=p.id;b.setAttribute('aria-pressed',String(p.id===selectedPerson));
    const copy=node('span','person-copy');copy.append(node('strong','',p.name),node('small','',`${p.kind}${p.caseIds.length?' · '+p.caseIds.join(', '):''}`));
    if(query&&p.matchKind==='related')copy.append(node('small','match-context','Matches in related case'));
    b.append(node('span','person-avatar',initials(p.name)),copy);if(p.welfare==='assistance_needed')b.append(node('i','needs-indicator'));list.append(b);
  }
  const p=people.find(p=>p.id===selectedPerson),record=node('article','person-record');record.setAttribute('aria-label',`${p.name} record`);record.tabIndex=-1;
  const back=button('',()=>{personOpen=false;renderPeople();},'mobile-record-back text-button');back.append(icon('chevron'),document.createTextNode('All people'));record.append(back);
  const heading=node('div','record-profile'),copy=node('div');copy.append(node('div','view-kicker',p.kind),node('h2','',p.name));heading.append(node('div','person-avatar',initials(p.name)),copy);record.append(heading);
  const meta=node('div','person-meta');meta.append(pill(`Welfare: ${title(p.welfare)}`,welfareTone(p.welfare)),pill(title(p.location)));if(p.participantId)meta.append(pill(p.description.startsWith('Opted out')?'Outreach off':'Outreach opted in'));record.append(meta,node('p','record-description',p.description));
  const caseLinks=node('div','person-case-links');for(const id of p.caseIds){const c=familyState.cases.find(c=>c.id===id);const b=button('',()=>openConversation(id),'case-link');b.append(icon('messages'),document.createTextNode(`${id} · ${p.participantId?subjectName(c):'Open conversation'}`),icon('arrow'));caseLinks.append(b);}record.append(caseLinks);
  if(!p.participantId){
    const c=familyState.cases.find(c=>c.id===p.caseIds[0]);
    const needs=familyState.assistance.filter(a=>p.caseIds.includes(a.caseId)&&a.status!=='completed');
    if(needs.length){const callout=node('div','assistance-callout');callout.append(icon('supplies'),node('span','',`${needs.length} open assistance ${needs.length===1?'task':'tasks'}. Tracked separately from welfare.`));record.append(callout);}
    if(c.verification){const review=node('section','record-section current-review');review.append(node('h3','','Latest officer review'),recordEvent(`${c.verification.officerName} · ${title(c.welfareState)}`,c.verification.note,c.verification.verifiedAt,'Demo identity · '+c.id));record.append(review);}
  }
  const last=node('section','record-section');last.append(node('h3','',p.participantId?'Last shared location':'Family’s last contact'),recordEvent(p.participantId?'Participant report':'Initial family report',p.tile?(p.tile==='OUTSIDE'?'Outside the exercise area':`Oak District · schematic tile ${p.tile}.`):'No location has been recorded.',p.lastAt,'Reported location · not current tracking'));record.append(last);
  const evidence=node('section','record-section');evidence.append(node('h3','',p.participantId?'Reports contributed':'Reported sightings & evidence'));
  const reports=familyState.reports.filter(r=>p.participantId?r.senderId===p.participantId:p.caseIds.includes(r.caseId));
  for(const r of [...reports].sort((a,b)=>Date.parse(b.observedAt||b.receivedAt)-Date.parse(a.observedAt||a.receivedAt))){const observed=(r.observations||[]).filter(o=>['sighting','self_check_in','correction'].includes(o.type));evidence.append(recordEvent(`${r.id} · ${observed.length?observed.map(o=>title(o.type)).join(' / '):'Raw report'} · ${r.caseId||'Unassigned'}`,r.text,r.observedAt,`Received ${time(r.receivedAt)} · reported, not independently verified`));}
  if(!reports.length)evidence.append(node('p','record-empty',p.participantId?'No contributed reports are recorded.':'No sightings or reports have been recorded.'));record.append(evidence);
  const messages=node('section','record-section');messages.append(node('h3','',p.participantId?'Messages to this participant':'Related messages'));
  const events=p.caseIds.flatMap(id=>caseEvents(familyState,id)).filter(e=>e.direction==='outgoing'&&(!p.participantId||e.recipientId===p.participantId)).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  for(const e of events.slice(0,12))messages.append(recordEvent(`${title(e.kind)} · to ${e.name}`,e.text,e.at,'Simulated · no delivery'));
  if(!events.length)messages.append(node('p','record-empty','No simulated messages are recorded.'));record.append(messages,node('p','record-disclaimer','Fictional exercise. A person’s report, location, welfare, and assistance needs are separate facts.'));
  layout.append(list,record);root.append(layout);restoreList(list,memory);
}
function renderMessages(){
  if(!familyState)return;
  const root=$('#messages-workspace'),memory=rememberList(root,'.thread-list'),query=$('#message-search').value;
  const threads=messageThreads(familyState,query,messageScope);root.replaceChildren();
  root.append(scopeToolbar('Conversations',[['all','All conversations'],['follow_up','Needs follow-up']],messageScope,value=>{messageScope=value;threadOpen=false;renderMessages();},threads.length));
  if(!threads.length){root.append(emptyState('No matching conversations','Try a family name, case number, or phrase from a report.',query?button('Clear search',()=>clearSearch($('#message-search')),'control'):button('Open Casework',()=>{location.hash='casework';},'control')));return;}
  if(!threads.some(c=>c.id===selectedThread))selectedThread=threads[0].id;
  const layout=node('div','messages-layout'+(threadOpen?' is-detail':'')),list=node('div','thread-list');list.setAttribute('aria-label','Case conversations');
  for(const c of threads){
    const b=button('',()=>{selectedThread=c.id;threadOpen=true;renderMessages();if(mobile())$('#messages-workspace .conversation').focus({preventScroll:true});},'thread-row');b.dataset.recordId=c.id;b.setAttribute('aria-pressed',String(selectedThread===c.id));
    const head=node('span','thread-row-heading');head.append(node('strong','',subjectName(c)),node('span','thread-event-count',count(c.events.length)));b.append(head,node('small','',`${c.id==='unassigned'?'Human review':c.id} · ${title(c.reviewState)}`));
    b.append(node('p','thread-preview',c.events.length?c.events.at(-1).text:'No messages received. Follow-up is still needed.'));list.append(b);
  }
  const c=threads.find(c=>c.id===selectedThread),conversation=node('article','conversation');conversation.tabIndex=-1;
  const head=node('div','conversation-heading'),copy=node('div'),back=button('',()=>{threadOpen=false;renderMessages();},'mobile-record-back icon-button');back.setAttribute('aria-label','Back to conversations');back.append(icon('chevron'));copy.append(node('h2','',subjectName(c)),node('p','',`${c.id==='unassigned'?'Unassigned reports':c.id+' · Oak District'} · ${c.events.length} ${c.events.length===1?'message':'messages'}`));head.append(back,copy,pill(c.reviewState==='resolved'?'Reviewed':c.id==='unassigned'?'Needs clarification':'Follow-up',c.reviewState==='resolved'?'green':'amber'));conversation.append(head);
  const body=node('div','conversation-events');let lastDay='';
  for(const e of c.events){const eventDay=time(e.receivedAt||e.at).split(',')[0];if(eventDay!==lastDay){body.append(node('div','conversation-date',eventDay));lastDay=eventDay;}
    const bubble=node('article',`message-bubble ${e.direction}`);bubble.append(node('strong','',`${e.direction==='incoming'?'From':'To'} ${e.name}`),node('p','',e.text),node('span','message-kind',`${e.direction==='incoming'?'Reported · ': 'Simulated · '}${title(e.kind)}`),node('small','',`${e.direction==='incoming'?'Observed':'Queued'} ${time(e.at)}${e.receivedAt?' · received '+time(e.receivedAt):''}`));body.append(bubble);
  }
  if(!c.events.length)body.append(emptyState('Waiting for the first message','This case remains open. Queue an inquiry or simulate an incoming report in Casework.',button('Open Casework',()=>{location.hash='casework';},'control')));
  conversation.append(body);const foot=node('div','conversation-footer');foot.append(node('span','',c.id==='unassigned'?'These raw reports have no established case. Keep them in human review.':'Local simulation · no external messages are sent.'));
  if(c.id!=='unassigned')foot.append(button('Open message lab',()=>openMessageLab(c.id),'control'));conversation.append(foot);layout.append(list,conversation);root.append(layout);restoreList(list,memory);
}
async function loadArchive(force=false){
  const root=$('#archive-workspace');if(archiveData&&!force){renderArchive();return;}root.replaceChildren(node('p','record-empty','Loading the historical archive…'));
  try{const r=await fetch('/api/satellite');if(!r.ok)throw new Error('The historical archive could not be loaded.');archiveData=await r.json();renderArchive();}catch(e){root.replaceChildren(emptyState('Archive unavailable',e.message,button('Try again',()=>loadArchive(true),'control')));}
}
function renderArchive(){
  const root=$('#archive-workspace'),restoreFocus=document.activeElement?.getAttribute('aria-label')==='Historical image pair';root.replaceChildren();
  if(!archiveData.available||!archiveData.tiles?.length){root.append(emptyState('No archived image pairs available',archiveData.reason||'Import a verified historical model bundle to compare its image pairs.',button('Refresh archive',()=>loadArchive(true),'control')));return;}
  if(!archiveData.tiles.some(t=>t.id===archiveId))archiveId=archiveData.tiles[0].id;
  const toolbar=node('div','archive-toolbar'),label=node('label','','Historical image pair'),select=node('select');select.setAttribute('aria-label','Historical image pair');
  for(const [i,t]of archiveData.tiles.entries()){const o=node('option','',`Harvey 2017 · study area ${i+1} · ${t.id.split('_').at(-1)}`);o.value=t.id;select.append(o);}select.value=archiveId;select.addEventListener('change',()=>{archiveId=select.value;renderArchive();});label.append(select);toolbar.append(label,pill('Separate study areas · not georeferenced to Houston'));root.append(toolbar);
  const tile=archiveData.tiles.find(t=>t.id===archiveId),pair=node('div','archive-pair');
  const safe=src=>{try{const u=new URL(src,location.origin);return u.origin===location.origin&&u.pathname.startsWith('/api/satellite/images/')?u.href:null;}catch{return null;}};
  const before=node('img'),after=node('img','archive-after');before.alt=`Before Hurricane Harvey, historical study image ${tile.id}`;after.alt=`After Hurricane Harvey, historical study image ${tile.id}`;
  for(const [image,src]of [[before,tile.preImageUrl],[after,tile.postImageUrl]]){const url=safe(src);if(url){image.src=url;image.addEventListener('error',()=>pair.replaceChildren(emptyState('Image unavailable','Choose another image pair or refresh the archive.')),{once:true});}}
  const divider=node('div','archive-divider');divider.append(node('span','','↔'));pair.append(before,after,divider,node('span','archive-label before','Before · Harvey 2017'),node('span','archive-label after','After · Harvey 2017'));root.append(pair);
  const slider=node('div','archive-slider'),sl=node('label');sl.append(node('span','','Before'),node('span','','Drag to compare'),node('span','','After'));const range=node('input');range.type='range';range.min='0';range.max='100';range.setAttribute('aria-label','Before and after imagery comparison');
  const update=value=>{comparison=Number(value);after.style.clipPath=`inset(0 0 0 ${comparison}%)`;divider.style.left=`${comparison}%`;range.value=String(comparison);};update(comparison);range.addEventListener('input',()=>update(range.value));slider.append(sl,range);root.append(slider);
  let dragging=false;const compare=e=>{const b=pair.getBoundingClientRect();update(Math.round(Math.max(0,Math.min(100,(e.clientX-b.left)/b.width*100))));};pair.style.touchAction='pan-y';pair.addEventListener('pointerdown',e=>{dragging=true;pair.setPointerCapture(e.pointerId);compare(e);});pair.addEventListener('pointermove',e=>{if(dragging)compare(e);});pair.addEventListener('pointerup',()=>{dragging=false;});pair.addEventListener('pointercancel',()=>{dragging=false;});
  root.append(node('p','archive-credit','Historical xBD / xView2 · Maxar imagery · Gupta et al., DIU, CMU SEI and collaborators · CC BY-NC-SA 4.0. Individual capture dates and geographic placement on the Houston dashboard are not established.'));
  if(restoreFocus)select.focus({preventScroll:true});
}
document.addEventListener('family-state-changed',e=>{const previous=familyState;familyState=e.detail;renderPeople();renderMessages();if(previous&&((location.hash==='#family'&&familyState.cases.length>previous.cases.length)||(location.hash==='#simulator'&&familyState.reports.length>previous.reports.length))){location.hash='casework';}});
async function refreshState(){try{const r=await fetch('/api/state');if(!r.ok)throw new Error('Case records could not be loaded.');familyState=await r.json();renderPeople();renderMessages();}catch(e){for(const id of ['people-workspace','messages-workspace'])$('#'+id).replaceChildren(emptyState('Records unavailable',e.message,button('Try again',refreshState,'control')));}}
$('#person-search').addEventListener('input',()=>{personOpen=false;renderPeople();});$('#message-search').addEventListener('input',()=>{threadOpen=false;renderMessages();});window.addEventListener('hashchange',route);$('#fill-example').addEventListener('click',()=>{location.hash='family';route();$('#example').click();});for(const el of document.querySelectorAll('[data-icon]'))el.replaceChildren(icon(el.dataset.icon));searchControls();route();refreshState();
