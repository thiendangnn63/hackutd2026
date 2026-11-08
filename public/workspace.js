import {node,button,icon,title} from './ui.js';
import {matches,caseEvents,caseSearchText,peopleIndex} from './records.js';
const $=s=>document.querySelector(s);
let familyState=null,selectedPerson=null,selectedThread=null,archiveData=null,archiveId=null;
const time=value=>{const d=new Date(value);return !value||Number.isNaN(d.valueOf())?'Time not recorded':new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d)+' CT';};
const initials=name=>name.split(' ').slice(0,2).map(s=>s[0]).join('').toUpperCase();
const pill=(text,tone='')=>node('span',`pill ${tone}`,text);
function emptyState(heading,description,action){const e=node('div','empty-state');e.append(icon('search'),node('h3','',heading),node('p','',description));if(action)e.append(action);return e;}
function route(){
  const hash=location.hash.slice(1)||'mayor',aliases={overview:'casework',family:'casework',simulator:'casework',assistance:'casework',satellite:'imagery'};
  const name=aliases[hash]||(['mayor','messages','people','casework','imagery'].includes(hash)?hash:'mayor');
  for(const [id,view]of [['map-view','mayor'],['messages-view','messages'],['people-view','people'],['casework-view','casework'],['imagery-view','imagery']])$('#'+id).hidden=name!==view;
  for(const a of document.querySelectorAll('.rail-link')){if(a.dataset.view===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
  $('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');
  if(name==='people')renderPeople();if(name==='messages')renderMessages();if(name==='imagery')loadArchive();
  if(aliases[hash])requestAnimationFrame(()=>$('#'+hash)?.scrollIntoView({block:'start'}));
  document.title=`${name==='mayor'?'Houston map':title(name)} · Family Response`;
}
function recordEvent(heading,text,at,extra=''){
  const e=node('article','record-event');e.append(node('strong','',heading),node('p','',text),node('small','',`${time(at)}${extra?' · '+extra:''}`));return e;
}
function renderPeople(){
  if(!familyState)return;const root=$('#people-workspace'),all=peopleIndex(familyState),query=$('#person-search').value;
  const people=all.filter(p=>matches(p.searchText,query));root.replaceChildren();
  if(!people.length){root.append(emptyState('No matching records','Try a name, case number, last-known area, or a phrase from a message. Only records in this fictional exercise are searched.'));return;}
  if(!people.some(p=>p.id===selectedPerson))selectedPerson=people[0].id;
  const layout=node('div','people-layout'),list=node('div','people-list');list.setAttribute('aria-label','Matching people');
  for(const p of people){const b=button('',()=>{selectedPerson=p.id;renderPeople();},'person-row');b.setAttribute('aria-pressed',String(p.id===selectedPerson));const copy=node('span','person-copy');copy.append(node('strong','',p.name),node('small','',`${p.kind}${p.caseIds.length?' · '+p.caseIds.join(', '):''}`));b.append(node('span','person-avatar',initials(p.name)),copy);list.append(b);}
  const p=people.find(p=>p.id===selectedPerson),record=node('article','person-record');record.setAttribute('aria-label',`${p.name} record`);
  record.append(node('div','person-avatar',initials(p.name)),node('div','view-kicker',p.kind),node('h2','',p.name),node('p','workspace-note',p.description));
  const meta=node('div','person-meta');meta.append(pill('Fictional person'),pill(`Welfare: ${title(p.welfare)}`,p.welfare==='unknown'?'':'green'),pill(title(p.location)));record.append(meta);
  const last=node('section','record-section');last.append(node('h3','','Last-known information'),recordEvent('Reported location',p.tile?(p.tile==='OUTSIDE'?'Outside the exercise area':`Oak District · schematic tile ${p.tile}. This is a report, not a verified current location.`):'No location has been recorded.',p.lastAt),node('p','workspace-note','Observation time and message receipt time are kept separately. No reply does not establish safety or harm.'));record.append(last);
  const evidence=node('section','record-section');evidence.append(node('h3','','Sightings & case evidence'));
  const reports=familyState.reports.filter(r=>p.caseIds.includes(r.caseId)&&(p.participantId?r.senderId===p.participantId:true));
  for(const report of reports){const observed=(report.observations||[]).filter(o=>['sighting','self_check_in','correction'].includes(o.type));evidence.append(recordEvent(`${report.id} · ${observed.length?observed.map(o=>title(o.type)).join(' / '):'Raw report'} · ${report.caseId}`,report.text,report.observedAt,`Received ${time(report.receivedAt)} · reported, not verified`));}
  if(!reports.length)evidence.append(node('p','record-empty','No sightings or reports are recorded for this person. Welfare remains unknown.'));record.append(evidence);
  const messages=node('section','record-section');messages.append(node('h3','','Related messages'));
  const events=p.caseIds.flatMap(id=>caseEvents(familyState,id)).filter(e=>e.direction==='outgoing').sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  for(const event of events.slice(0,12))messages.append(recordEvent(`${title(event.kind)} · to ${event.name}`,event.text,event.at,'Simulated · no delivery'));
  if(!events.length)messages.append(node('p','record-empty','No simulated messages are recorded yet.'));record.append(messages);
  for(const id of p.caseIds){const c=familyState.cases.find(c=>c.id===id);if(c.verification){const v=node('section','record-section');v.append(node('h3','','Officer review'),recordEvent(`${c.verification.officerName} · ${title(c.welfareState)}`,c.verification.note,c.verification.verifiedAt,'Demo officer identity'));record.append(v);}}
  const action=button('Open related conversation',()=>{selectedThread=p.caseIds[0];location.hash='messages';},'control');action.disabled=!p.caseIds.length;record.append(action);layout.append(list,record);root.append(layout);
}
function renderMessages(){
  if(!familyState)return;const root=$('#messages-workspace'),query=$('#message-search').value;
  const cases=familyState.cases.filter(c=>matches(caseSearchText(familyState,c),query));root.replaceChildren();
  if(!cases.length){root.append(emptyState('No matching conversations','Search for a family name, case number, or text from a report. Create a family case in Casework to start a conversation.'));return;}
  if(!cases.some(c=>c.id===selectedThread))selectedThread=cases[0].id;
  const layout=node('div','messages-layout'),list=node('div','thread-list');list.setAttribute('aria-label','Case conversations');
  for(const c of cases){const b=button('',()=>{selectedThread=c.id;renderMessages();},'thread-row');b.setAttribute('aria-pressed',String(selectedThread===c.id));const events=caseEvents(familyState,c.id);b.append(node('strong','',Array.isArray(c.subjectNames)?c.subjectNames.join(' and '):c.subjectNames),node('small','',`${c.id} · ${events.length} messages · ${title(c.reviewState)}`));if(events.length)b.append(node('small','',events.at(-1).text.slice(0,90)+(events.at(-1).text.length>90?'…':'')));list.append(b);}
  const c=cases.find(c=>c.id===selectedThread),conversation=node('article','conversation'),head=node('div','conversation-heading'),copy=node('div');copy.append(node('h2','',Array.isArray(c.subjectNames)?c.subjectNames.join(' and '):c.subjectNames),node('p','',`${c.id} · Oak District exercise`));head.append(copy,pill('Simulated','green'));conversation.append(head);
  const events=caseEvents(familyState,c.id),body=node('div','conversation-events');
  for(const event of events){const bubble=node('article',`message-bubble ${event.direction}`);bubble.append(node('strong','',`${event.direction==='incoming'?'From':'To'} ${event.name} · ${title(event.kind)}`),node('p','',event.text),node('small','',`${event.direction==='incoming'?'Observed':'Queued'} ${time(event.at)}${event.receivedAt?' · received '+time(event.receivedAt):''}`));body.append(bubble);}
  if(!events.length)body.append(emptyState('Waiting for the first message','No reports or outreach messages have been recorded. The case stays open. Use Casework to queue an inquiry or simulate a reply.',button('Open Casework',()=>{location.hash='casework';},'control')));
  conversation.append(body);const foot=node('div','conversation-footer');foot.append(node('span','','No real messages are sent from this workspace.'),button('Open message lab',()=>{location.hash='simulator';},'control'));conversation.append(foot);layout.append(list,conversation);root.append(layout);
}
async function loadArchive(){
  const root=$('#archive-workspace');if(archiveData){renderArchive();return;}root.replaceChildren(node('p','record-empty','Loading the historical archive…'));
  try{const r=await fetch('/api/satellite');if(!r.ok)throw new Error('The historical archive could not be loaded.');archiveData=await r.json();renderArchive();}catch(e){root.replaceChildren(emptyState('Archive unavailable',e.message,button('Try again',loadArchive,'control')));}
}
function renderArchive(){
  const root=$('#archive-workspace');root.replaceChildren();if(!archiveData.available||!archiveData.tiles?.length){root.append(emptyState('No archived image pairs available',archiveData.reason||'Import a verified historical model bundle to compare its image pairs. The Houston aerial mosaic remains available on the map.'));return;}
  if(!archiveData.tiles.some(t=>t.id===archiveId))archiveId=archiveData.tiles[0].id;
  const toolbar=node('div','archive-toolbar'),label=node('label','','Historical image pair'),select=node('select');select.setAttribute('aria-label','Historical image pair');
  for(const [i,t]of archiveData.tiles.entries()){const o=node('option','',`Harvey 2017 · study area ${i+1} · ${t.id.split('_').at(-1)}`);o.value=t.id;select.append(o);}select.value=archiveId;select.addEventListener('change',()=>{archiveId=select.value;renderArchive();});label.append(select);toolbar.append(label,pill('Separate study areas · not georeferenced to Houston'));root.append(toolbar);
  const tile=archiveData.tiles.find(t=>t.id===archiveId),pair=node('div','archive-pair');
  const safe=src=>{try{const u=new URL(src,location.origin);return u.origin===location.origin&&u.pathname.startsWith('/api/satellite/images/')?u.href:null;}catch{return null;}};
  const before=node('img'),after=node('img','archive-after');before.alt=`Before Hurricane Harvey, historical study image ${tile.id}`;after.alt=`After Hurricane Harvey, historical study image ${tile.id}`;
  for(const [image,src]of [[before,tile.preImageUrl],[after,tile.postImageUrl]]){const url=safe(src);if(url){image.src=url;image.addEventListener('error',()=>pair.replaceChildren(emptyState('Image unavailable','This archived image could not be loaded. Choose another image pair.')),{once:true});}}
  const divider=node('div','archive-divider');divider.append(node('span','','↔'));pair.append(before,after,divider,node('span','archive-label before','Before · Harvey 2017'),node('span','archive-label after','After · Harvey 2017'));root.append(pair);
  const slider=node('div','archive-slider'),sl=node('label');sl.append(node('span','','Before'),node('span','','Drag to compare'),node('span','','After'));const range=node('input');range.type='range';range.min='0';range.max='100';range.value='50';range.setAttribute('aria-label','Before and after imagery comparison');const update=value=>{after.style.clipPath=`inset(0 0 0 ${value}%)`;divider.style.left=`${value}%`;range.value=value;};range.addEventListener('input',()=>update(range.value));slider.append(sl,range);root.append(slider);
  let dragging=false;const compare=e=>{const b=pair.getBoundingClientRect();update(Math.round(Math.max(0,Math.min(100,(e.clientX-b.left)/b.width*100))));};pair.style.touchAction='pan-y';pair.addEventListener('pointerdown',e=>{dragging=true;pair.setPointerCapture(e.pointerId);compare(e);});pair.addEventListener('pointermove',e=>{if(dragging)compare(e);});pair.addEventListener('pointerup',()=>{dragging=false;});pair.addEventListener('pointercancel',()=>{dragging=false;});
  root.append(node('p','archive-credit','Historical xBD / xView2 · Maxar imagery · Gupta et al., DIU, CMU SEI and collaborators · CC BY-NC-SA 4.0. Capture dates for individual image pairs are not supplied. These images have no verified placement on the Houston map. Damage estimates do not establish personal safety or shelter suitability.'));
}
document.addEventListener('family-state-changed',e=>{familyState=e.detail;renderPeople();renderMessages();});
async function refreshState(){try{const r=await fetch('/api/state');if(!r.ok)throw new Error('Case records could not be loaded.');familyState=await r.json();renderPeople();renderMessages();}catch(e){for(const id of ['people-workspace','messages-workspace'])$('#'+id).replaceChildren(emptyState('Records unavailable',e.message,button('Try again',refreshState,'control')));}}
$('#person-search').addEventListener('input',renderPeople);$('#message-search').addEventListener('input',renderMessages);window.addEventListener('hashchange',route);$('#fill-example').addEventListener('click',()=>$('#example').click());for(const el of document.querySelectorAll('[data-icon]'))el.replaceChildren(icon(el.dataset.icon));route();refreshState();
