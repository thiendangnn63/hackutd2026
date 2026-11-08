import {stateClient} from './state-client.js';
import {createProposalView,clearProposalMemory,rememberProposalState} from './proposal-view.js';
import {node,button,icon,iconButton,title,count} from './ui.js';
import {searchPeople,messageThreads,caseEvents,outgoingForParticipant,searchSegments,messageHitIds,normalize,latestReceivedReport,incomingReportKind} from './records.js';
import {recordFocusKey,rememberRecordFocus,restoreRecordFocus,viewportRecordFocus} from './record-focus.js';
import {createArchiveView} from './archive-view.js';
const $=s=>document.querySelector(s);
const archiveView=createArchiveView($('#archive-workspace'));
let revealRecordFocus=false,lastRecordFocus=null;
let searchAnnouncement;
function announceSearch(message){clearTimeout(searchAnnouncement);searchAnnouncement=setTimeout(()=>{$('#search-status').textContent=message;},180);}
const recordLayout=window.matchMedia('(max-width:760px), (max-height:520px)');
const mobile=()=>recordLayout.matches;
let familyState=null,selectedPerson=null,selectedThread=null;
let peopleScope='all',messageScope='all',personOpen=false,threadOpen=false;
let recordsLoading=true,recordsLoadError='',stateRevision=0,stateRequest=0;
const personReading=new Map(),threadReading=new Map(),listReading=new Map(),expandedHistories=new Set();
const messageMatchPositions=new Map(),messageSearchSeen=new Set(),pendingMessageJumps=new Set();
let activeMessageSearch=null;
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
function openConversation(caseId,messageId=null){
  selectedThread=caseId;messageScope='all';threadOpen=true;
  $('#message-search').value='';$('#message-search').dispatchEvent(new Event('input'));threadOpen=true;
  if(location.hash==='#messages')renderMessages();else{location.hash='messages';route();}
  requestAnimationFrame(()=>{
    if(location.hash!=='#messages'||selectedThread!==caseId)return;
    const root=$('#messages-workspace');if(mobile())revealMobileDetail(root);
    const bubble=messageId?[...root.querySelectorAll('[data-message-id]')].find(element=>element.dataset.messageId===messageId):null;
    if(bubble&&revealMessage(root,bubble)){bubble.focus({preventScroll:true});return;}
    if(!mobile())root.querySelector('[data-record-focus=heading]')?.focus({preventScroll:true});
  });
}
function openMessageLab(caseId){
  if(!caseId||caseId==='unassigned')return;
  $('#sms-case').value=caseId;$('#sms-case').dispatchEvent(new Event('change'));
  location.hash='simulator';requestAnimationFrame(()=>$('#sms-form textarea').focus({preventScroll:true}));
}
function route(){
  const hash=location.hash.slice(1)||'mayor',aliases={overview:'casework',family:'casework',simulator:'casework',assistance:'casework',satellite:'imagery'};
  const name=aliases[hash]||(['mayor','messages','people','casework','imagery'].includes(hash)?hash:'mayor');
  for(const [id,view]of [['map-view','mayor'],['messages-view','messages'],['people-view','people'],['casework-view','casework'],['imagery-view','imagery']]){
    const element=$('#'+id);
    if(!element.hidden&&name!==view){
      const root=element.querySelector('#people-workspace, #messages-workspace');
      if(root){rememberProposalState(root);rememberReading(root);rememberList(root,root.id==='people-workspace'?'.people-list':'.thread-list');for(const pane of root.querySelectorAll('[data-reading-ready]'))pane.dataset.readingReady='false';}
    }
    element.hidden=name!==view;
  }
  for(const a of document.querySelectorAll('.rail-link')){if(a.dataset.view===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
  $('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');
  if(name==='people')renderPeople();if(name==='messages')renderMessages();if(name==='imagery')archiveView.load();
  if(name==='casework'){const section=hash==='family'?'intake':hash==='simulator'?'lab':hash==='assistance'?'assistance':'review';$('#casework-view').dataset.section=section;for(const a of document.querySelectorAll('.casework-navigation a')){if(a.dataset.section===section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}}
  if(aliases[hash])requestAnimationFrame(()=>$('#'+hash)?.scrollIntoView({block:'start'}));
  document.title=`${name==='mayor'?'Houston map':title(name)} · Beacon`;
}
function highlighted(tag,className,value,query=''){
  const element=node(tag,className);
  for(const segment of searchSegments(value,query))element.append(segment.matched?node('mark','search-mark',segment.text):document.createTextNode(segment.text));
  return element;
}
function recordEvent(heading,text,at,extra='',query=''){
  const e=node('article','record-event');e.append(highlighted('strong','',heading,query),highlighted('p','',text,query),node('small','',`${time(at)}${extra?' · '+extra:''}`));return e;
}
function messageSearchState(thread,query,reset=false){
  if(!normalize(query))return null;
  const key=thread.id+'\u0000'+normalize(query),hadSearch=messageSearchSeen.has(key);
  const hits=messageHitIds(thread.events,query),ids=hits.fullIds.length?hits.fullIds:hits.relatedIds;
  const saved=reset?null:messageMatchPositions.get(key),index=Math.max(0,ids.indexOf(saved));
  messageSearchSeen.add(key);if(ids.length)messageMatchPositions.set(key,ids[index]);
  return {key,threadId:thread.id,eventCount:thread.events.length,ids,index,hadSearch,mode:hits.fullIds.length?'full':ids.length?'related':'none'};
}
function updateMessageMatches(){
  const root=$('#messages-workspace'),state=activeMessageSearch,conversation=root.querySelector('.conversation');
  if(!state||conversation?.dataset.threadId!==state.threadId)return;
  const current=state.ids[state.index],hits=new Set(state.ids);
  for(const bubble of conversation.querySelectorAll('.message-bubble')){
    const selected=bubble.dataset.messageId===current;
    bubble.classList.toggle('is-search-hit',hits.has(bubble.dataset.messageId));bubble.classList.toggle('is-search-current',selected);
    if(selected)bubble.setAttribute('aria-current','true');else bubble.removeAttribute('aria-current');
  }
  const summary=conversation.querySelector('.message-match-summary');
  if(summary)summary.textContent=state.ids.length?`${state.index+1} of ${state.ids.length} ${state.mode==='full'?'matching':'related'} ${state.ids.length===1?'message':'messages'}`:'No message-content match';
  const bar=conversation.querySelector('.message-matchbar');if(bar)bar.dataset.matchMode=state.mode;
}
function revealMessage(root,bubble){
  const {view,detail,layout}=readingParts(root);
  if(!bubble||!detail||view.hidden||(mobile()&&!layout.classList.contains('is-detail')))return false;
  const scroller=mobile()?view:detail.querySelector('.conversation-events');
  const inset=mobile()?(detail.querySelector('.conversation-context')?.getBoundingClientRect().height||0)+14:18;
  const target=bubble.getBoundingClientRect().height>scroller.clientHeight-inset?(bubble.querySelector('.search-mark')||bubble):bubble;
  scroller.scrollTop=Math.max(0,scroller.scrollTop+target.getBoundingClientRect().top-scroller.getBoundingClientRect().top-inset);
  rememberReading(root);return true;
}
function jumpToMessageMatch(){
  const root=$('#messages-workspace'),state=activeMessageSearch,{view,detail,layout}=readingParts(root);
  if(!state?.ids.length||!detail||detail.dataset.threadId!==state.threadId||view.hidden||(mobile()&&!layout.classList.contains('is-detail')))return false;
  const bubble=[...detail.querySelectorAll('.message-bubble')].find(e=>e.dataset.messageId===state.ids[state.index]);
  if(!bubble)return false;
  if(!revealMessage(root,bubble))return false;
  messageMatchPositions.set(state.key,state.ids[state.index]);updateMessageMatches();
  return true;
}
function navigateMessageMatch(direction){
  if(!activeMessageSearch)return false;
  if(mobile()&&!threadOpen){
    threadOpen=true;const jumped=renderMessages(false,true);
    if(!jumped)revealMobileDetail($('#messages-workspace'));
    if(direction<0&&activeMessageSearch?.ids.length){activeMessageSearch.index=activeMessageSearch.ids.length-1;jumpToMessageMatch();}
    return true;
  }
  if(!activeMessageSearch.ids.length)return false;
  const state=activeMessageSearch;state.index=(state.index+direction+state.ids.length)%state.ids.length;
  return jumpToMessageMatch();
}
function messageMatchbar(state){
  const bar=node('div','message-matchbar'),copy=node('div','message-match-copy');bar.setAttribute('role','group');bar.setAttribute('aria-label','Matching messages');
  const summary=node('p','message-match-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  const hint=state.mode==='full'?'All search words appear in each match.':state.mode==='related'?'Some search words match; review the surrounding context.':state.eventCount?'This result matches case or reference information, not visible message text.':'Case fields match. No messages have been recorded in this conversation.';
  copy.append(summary,node('p','message-match-hint',hint));bar.append(copy);
  if(state.ids.length){
    const controls=node('div','message-match-controls');
    const previous=iconButton('chevron','Previous matching message',()=>navigateMessageMatch(-1),'icon-button message-match-prev');
    const next=iconButton('chevron','Next matching message',()=>navigateMessageMatch(1),'icon-button message-match-next');
    recordFocusKey(previous,'match-previous');recordFocusKey(next,'match-next');previous.disabled=next.disabled=state.ids.length<2;controls.append(previous,next);bar.append(controls);
  }
  return bar;
}
function scopeToolbar(type,choices,current,change,total){
  const toolbar=node('div','records-toolbar'),group=node('div','record-filters');group.setAttribute('role','group');group.setAttribute('aria-label',type+' filters');
  for(const [value,label]of choices){
    const b=button(label,()=>{const root=toolbar.parentElement;change(value);[...root.querySelectorAll('[data-scope-value]')].find(e=>e.dataset.scopeValue===value)?.focus({preventScroll:true});announceSearch(root.querySelector('.results-count')?.textContent||'No matching records.');},'filter-chip');
    b.dataset.scopeValue=value;b.setAttribute('aria-pressed',String(current===value));group.append(b);
  }
  toolbar.append(group,node('span','results-count',`${count(total)} ${total===1?(type==='Records'?'record':'conversation'):type.toLowerCase()}`));return toolbar;
}
function readingParts(root){
  const people=root.id==='people-workspace',view=root.closest('.app-view'),detail=root.querySelector(people?'.person-record':'.conversation');
  return {people,view,detail,layout:detail?.parentElement,id:detail?.dataset[people?'personId':'threadId'],cache:people?personReading:threadReading};
}
function rememberReading(root){
  const parts=readingParts(root),{people,view,detail,layout,id,cache}=parts;
  if(!detail||!id||view.hidden||detail.dataset.readingReady!=='true'||(mobile()&&!layout.classList.contains('is-detail')))return;
  const scroller=mobile()?view:people?detail:detail.querySelector('.conversation-events');
  const maximum=Math.max(0,scroller.scrollHeight-scroller.clientHeight),mode=mobile()?'mobile':'desktop';
  cache.set(id,{...cache.get(id),[mode]:{top:scroller.scrollTop,atEnd:maximum-scroller.scrollTop<=40}});
}
function restoreReading(root){
  const {people,view,detail,layout,id,cache}=readingParts(root);
  if(!detail||view.hidden||(mobile()&&!layout.classList.contains('is-detail')))return;
  const scroller=mobile()?view:people?detail:detail.querySelector('.conversation-events');
  const saved=cache.get(id)?.[mobile()?'mobile':'desktop'],maximum=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
  scroller.scrollTop=saved?(!people&&saved.atEnd?maximum:Math.min(saved.top,maximum)):!people&&!mobile()?maximum:0;
  detail.dataset.readingReady='true';
  if(!mobile())scroller.addEventListener('scroll',()=>rememberReading(root),{passive:true});
}
function revealMobileDetail(root){
  const {view,detail}=readingParts(root);if(!detail||view.hidden)return;
  detail.focus({preventScroll:true});
  view.scrollTop=Math.max(0,view.scrollTop+detail.getBoundingClientRect().top-view.getBoundingClientRect().top-12);
  detail.dataset.readingReady='true';rememberReading(root);
}
function rememberList(root,selector){
  const old=root.querySelector(selector),view=root.closest('.app-view'),active=document.activeElement;
  const memory=listReading.get(root.id)||{scroll:0,outer:0};
  if(old&&!view.hidden&&old.dataset.readingReady==='true'&&(!mobile()||!old.parentElement.classList.contains('is-detail'))){memory.scroll=old.scrollTop;memory.outer=view.scrollTop;listReading.set(root.id,memory);}
  return {...memory,focus:old?.contains(active)?active.dataset.recordId:null};
}
function focusRecordRow(root,id){[...root.querySelectorAll('[data-record-id]')].find(e=>e.dataset.recordId===id)?.focus();}
function recordsFeedback(root){
  root.setAttribute('aria-busy',String(recordsLoading));
  if(recordsLoading){const status=recordFocusKey(node('p','record-empty','Loading case records…'),'loading');status.tabIndex=-1;status.setAttribute('role','status');root.append(status);}
  else if(recordsLoadError)root.append(emptyState('Records unavailable',recordsLoadError,recordFocusKey(button('Try again',refreshState,'control'),'retry')));
}
function restoreList(list,memory){
  const view=list.closest('.app-view');
  if(view.hidden||(mobile()&&list.parentElement.classList.contains('is-detail')))return;
  list.scrollTop=memory.scroll;view.scrollTop=memory.outer;list.dataset.readingReady='true';
  if(memory.focus){const row=[...list.querySelectorAll('[data-record-id]')].find(e=>e.dataset.recordId===memory.focus);row?.focus({preventScroll:true});}
}
function renderPeople(queryChanged=false,focusOverride=null){
  const root=$('#people-workspace'),focus=focusOverride||rememberRecordFocus(root);rememberProposalState(root);
  const restoreFocus=()=>restoreRecordFocus(root,focus,{reveal:revealRecordFocus});
  if(!familyState){root.replaceChildren();recordsFeedback(root);restoreFocus();return;}
  const memory=rememberList(root,'.people-list'),query=$('#person-search').value;rememberReading(root);
  if(queryChanged){memory.scroll=0;memory.outer=0;listReading.set(root.id,{scroll:0,outer:0});}
  const people=searchPeople(familyState,query,peopleScope);root.replaceChildren();recordsFeedback(root);
  root.append(scopeToolbar('Records',[['all','All records'],['inquiries','Family inquiries'],['community','Community']],peopleScope,value=>{peopleScope=value;personOpen=false;renderPeople();},people.length));
  if(!people.length){root.append(emptyState('No matching records','Try a name, last-known area, or phrase from a message.',query?recordFocusKey(button('Clear search',()=>clearSearch($('#person-search')),'control'),'clear-search'):null));restoreFocus();return;}
  if((queryChanged&&people[0].matchKind==='name')||!people.some(p=>p.id===selectedPerson))selectedPerson=people[0].id;
  const layout=node('div','people-layout'+(personOpen?' is-detail':'')),list=node('div','people-list');list.setAttribute('aria-label','Matching people');
  for(const p of people){
    const b=button('',()=>{selectedPerson=p.id;personOpen=true;renderPeople();if(mobile())revealMobileDetail(root);},'person-row');b.dataset.recordId=p.id;b.setAttribute('aria-pressed',String(p.id===selectedPerson));
    const copy=node('span','person-copy');copy.append(highlighted('strong','',p.name,query),highlighted('small','',`${p.kind}${p.caseIds.length?' · '+p.caseIds.join(', '):''}`,query));
    if(query&&p.matchKind==='related')copy.append(node('small','match-context','Matches in related case'));
    b.append(node('span','person-avatar',initials(p.name)),copy);if(p.welfare==='assistance_needed')b.append(node('i','needs-indicator'));list.append(b);
  }
  const p=people.find(p=>p.id===selectedPerson),record=node('article','person-record');record.setAttribute('aria-label',`${p.name} record`);record.tabIndex=-1;record.dataset.personId=p.id;record.dataset.readingReady='false';recordFocusKey(record,'detail');
  const back=button('',()=>{personOpen=false;renderPeople();focusRecordRow(root,selectedPerson);},'mobile-record-back text-button');recordFocusKey(back,'back');back.append(icon('chevron'),document.createTextNode('All people'));record.append(back);
  const heading=node('div','record-profile'),copy=node('div');copy.append(node('div','view-kicker',p.kind),highlighted('h2','',p.name,query));recordFocusKey(copy.querySelector('h2'),'heading').tabIndex=-1;heading.append(node('div','person-avatar',initials(p.name)),copy);record.append(heading);
  const meta=node('div','person-meta');meta.append(pill(`Welfare: ${title(p.welfare)}`,welfareTone(p.welfare)),pill(title(p.location)));if(p.participantId)meta.append(pill(p.description.startsWith('Opted out')?'Outreach off':'Outreach opted in'));record.append(meta);
  const reports=familyState.reports.filter(r=>p.participantId?r.senderId===p.participantId:p.caseIds.includes(r.caseId));
  const latest=latestReceivedReport(reports);
  const reportLink=(report,key,label='Open message')=>{
    const thread=familyState.cases.some(c=>c.id===report.caseId)?report.caseId:'unassigned';
    const link=recordFocusKey(button(label,()=>openConversation(thread,report.id),'text-button report-message-link'),key);
    link.setAttribute('aria-label',`${label} ${report.id}`);link.append(icon('arrow'));return link;
  };
  if(latest){
    const report=latest.report,preview=node('section','latest-report');
    preview.append(node('h3','',latest.receiptOrderKnown?'Latest received report':'Recent report · receipt order unknown'));
    const sender=familyState.participants.find(sender=>sender.id===report.senderId)?.name||'Unknown sender';
    preview.append(highlighted('p','latest-report-source',`${report.id} · ${sender}`,query),highlighted('p','latest-report-text',report.text,query));
    preview.append(node('p','workspace-note',`Received ${time(report.receivedAt)} · Observed ${time(report.observedAt)}`));
    const label=report.reviewFlags?.includes('correction_or_negation')?'Correction or negation · needs review':incomingReportKind(report);
    preview.append(pill(label,report.processingState==='needs_review'?'amber':''),node('p','workspace-note',report.processingPath==='failed'?'Raw text · interpretation unavailable. Human review is needed.':'Raw message · does not independently establish location or welfare.'),reportLink(report,'latest-report:'+report.id,'Open full message'));
    const proposal=createProposalView(report,{query});if(proposal)preview.append(proposal);
    record.append(preview);
  }
  if(p.participantId)record.append(highlighted('p','record-description',p.description,query));
  else{
    const original=node('section','original-inquiry');original.append(node('h3','','Original inquiry'),highlighted('p','record-description',p.description,query),node('p','workspace-note','Original family description · newer reports are shown separately.'));record.append(original);
  }
  const caseLinks=node('div','person-case-links');for(const id of p.caseIds){const c=familyState.cases.find(c=>c.id===id);const b=button('',()=>openConversation(id),'case-link');recordFocusKey(b,'case:'+id);b.append(icon('messages'),document.createTextNode(`${id} · ${p.participantId?subjectName(c):'Open conversation'}`),icon('arrow'));caseLinks.append(b);}record.append(caseLinks);
  if(!p.participantId){
    const c=familyState.cases.find(c=>c.id===p.caseIds[0]);
    const needs=familyState.assistance.filter(a=>p.caseIds.includes(a.caseId)&&a.status!=='completed');
    if(needs.length){const callout=node('div','assistance-callout');callout.append(icon('supplies'),node('span','',`${needs.length} open assistance ${needs.length===1?'task':'tasks'}. Tracked separately from welfare.`));record.append(callout);}
    if(c.verification){const review=node('section','record-section current-review');review.append(node('h3','','Latest officer review'),recordEvent(`${c.verification.officerName} · ${title(c.welfareState)}`,c.verification.note,c.verification.verifiedAt,'Demo identity · '+c.id,query));record.append(review);}
  }
  const last=node('section','record-section');last.append(node('h3','',p.participantId?'Last shared location':'Family’s last contact'),recordEvent(p.participantId?'Participant report':'Initial family report',p.tile?(p.tile==='OUTSIDE'?'Outside the exercise area':`Oak District · schematic tile ${p.tile}.`):'No location has been recorded.',p.lastAt,'Reported location · not current tracking',query));record.append(last);
  const evidence=node('section','record-section');evidence.append(node('h3','',p.participantId?'Reports contributed':'Reported sightings & evidence'));
  for(const r of [...reports].sort((a,b)=>Date.parse(b.observedAt||b.receivedAt)-Date.parse(a.observedAt||a.receivedAt))){const observed=(r.observations||[]).filter(o=>['sighting','self_check_in','correction'].includes(o.type));const event=recordEvent(`${r.id} · ${observed.length?observed.map(o=>title(o.type)).join(' / '):incomingReportKind(r)} · ${r.caseId||'Unassigned'}`,r.text,r.observedAt,`Received ${time(r.receivedAt)} · reported, not independently verified`,query);event.append(reportLink(r,'report:'+r.id));evidence.append(event);}
  if(!reports.length)evidence.append(node('p','record-empty',p.participantId?'No contributed reports are recorded.':'No sightings or reports have been recorded.'));record.append(evidence);
  const messages=node('section','record-section');messages.append(node('h3','',p.participantId?'Messages to this participant':'Related messages'));
  const events=(p.participantId?outgoingForParticipant(familyState,p.participantId):p.caseIds.flatMap(id=>caseEvents(familyState,id)).filter(e=>e.direction==='outgoing')).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const expanded=expandedHistories.has(p.id),shown=expanded?events.length:Math.min(12,events.length);
  if(events.length)messages.append(node('p','workspace-note',`${shown} of ${events.length} messages shown · newest first`));
  for(const e of events.slice(0,shown)){const event=recordEvent(`${title(e.kind)} · to ${e.name}`,e.text,e.at,'Simulated · no delivery',query);event.dataset.messageId=e.id;messages.append(event);}
  if(events.length>12){
    const toggle=button(expanded?'Show latest 12':`Show all ${events.length} messages`,()=>{
      const nextId=expanded?null:events[shown]?.id;
      if(expanded)expandedHistories.delete(p.id);else expandedHistories.add(p.id);
      renderPeople();
      const target=nextId?[...root.querySelectorAll('[data-message-id]')].find(e=>e.dataset.messageId===nextId):root.querySelector('[data-history-toggle]');
      if(target){if(nextId)target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});}
    },'text-button');toggle.dataset.historyToggle=p.id;recordFocusKey(toggle,'history-toggle');messages.append(toggle);
  }
  if(!events.length)messages.append(node('p','record-empty','No simulated messages are recorded.'));record.append(messages,node('p','record-disclaimer','Fictional exercise. A person’s report, location, welfare, and assistance needs are separate facts.'));
  layout.append(list,record);root.append(layout);restoreList(list,memory);restoreReading(root);restoreFocus();
}
function renderMessages(queryChanged=false,selectionChanged=false,focusOverride=null){
  const root=$('#messages-workspace'),focus=focusOverride||rememberRecordFocus(root);rememberProposalState(root);
  const restoreFocus=()=>restoreRecordFocus(root,focus,{reveal:revealRecordFocus});
  if(!familyState){root.replaceChildren();recordsFeedback(root);restoreFocus();return false;}
  const oldThreadId=root.querySelector('.conversation')?.dataset.threadId;
  const memory=rememberList(root,'.thread-list'),query=$('#message-search').value;rememberReading(root);
  if(queryChanged){memory.scroll=0;memory.outer=0;listReading.set(root.id,{scroll:0,outer:0});}
  const threads=messageThreads(familyState,query,messageScope);root.replaceChildren();recordsFeedback(root);
  root.append(scopeToolbar('Conversations',[['all','All conversations'],['follow_up','Needs follow-up']],messageScope,value=>{messageScope=value;threadOpen=false;renderMessages();},threads.length));
  if(!threads.length){activeMessageSearch=null;root.append(emptyState('No matching conversations','Try a family name, case number, or phrase from a report.',query?recordFocusKey(button('Clear search',()=>clearSearch($('#message-search')),'control'),'clear-search'):recordFocusKey(button('Open Casework',()=>{location.hash='casework';},'control'),'casework')));restoreFocus();return false;}
  if(!threads.some(c=>c.id===selectedThread))selectedThread=threads[0].id;
  const layout=node('div','messages-layout'+(threadOpen?' is-detail':'')),list=node('div','thread-list');list.setAttribute('aria-label','Case conversations');
  for(const c of threads){
    const b=button('',()=>{selectedThread=c.id;threadOpen=true;const jumped=renderMessages(false,true);if(mobile()){if(jumped)readingParts(root).detail?.focus({preventScroll:true});else revealMobileDetail(root);}},'thread-row');b.dataset.recordId=c.id;b.setAttribute('aria-pressed',String(selectedThread===c.id));
    const head=node('span','thread-row-heading');head.append(highlighted('strong','',subjectName(c),query),node('span','thread-event-count',count(c.events.length)));b.append(head,highlighted('small','',`${c.id==='unassigned'?'Human review':c.id} · ${c.pendingInboxCount?'Incoming report needs review':title(c.reviewState)}`,query));
    const hits=normalize(query)?messageHitIds(c.events,query):null,previewId=hits?.fullIds[0]||hits?.relatedIds[0];
    const preview=previewId?c.events.find(e=>e.id===previewId):c.events.at(-1);
    b.append(highlighted('p','thread-preview',preview?preview.text:'No messages received. Follow-up is still needed.',query));list.append(b);
  }
  const c=threads.find(c=>c.id===selectedThread),conversation=node('article','conversation');conversation.tabIndex=-1;conversation.dataset.threadId=c.id;conversation.dataset.readingReady='false';recordFocusKey(conversation,'detail');conversation.setAttribute('aria-label',subjectName(c)+' conversation');
  activeMessageSearch=messageSearchState(c,query,queryChanged);
  if(activeMessageSearch?.ids.length&&(queryChanged||selectionChanged||oldThreadId!==c.id||!activeMessageSearch.hadSearch))pendingMessageJumps.add(activeMessageSearch.key);
  const context=node('div','conversation-context');
  const head=node('div','conversation-heading'),copy=node('div'),back=button('',()=>{threadOpen=false;renderMessages();focusRecordRow(root,selectedThread);},'mobile-record-back icon-button');recordFocusKey(back,'back');back.setAttribute('aria-label','Back to conversations');back.append(icon('chevron'));copy.append(highlighted('h2','',subjectName(c),query),node('p','',`${c.id==='unassigned'?'Unassigned reports':c.id+' · Oak District'} · ${c.events.length} ${c.events.length===1?'message':'messages'}`));recordFocusKey(copy.querySelector('h2'),'heading').tabIndex=-1;head.append(back,copy,pill(c.pendingInboxCount?'Incoming review':c.reviewState==='resolved'?'Reviewed':c.id==='unassigned'?'Needs clarification':'Follow-up',c.reviewState==='resolved'&&!c.pendingInboxCount?'green':'amber'));context.append(head);
  if(activeMessageSearch)context.append(messageMatchbar(activeMessageSearch));conversation.append(context);
  const body=node('div','conversation-events');let lastDay='';
  for(const e of c.events){const eventDay=time(e.receivedAt||e.at).split(',')[0];if(eventDay!==lastDay){body.append(node('div','conversation-date',eventDay));lastDay=eventDay;}
    const bubble=node('article',`message-bubble ${e.direction}`);bubble.dataset.messageId=e.id;bubble.tabIndex=-1;
    bubble.append(highlighted('strong','',`${e.direction==='incoming'?'From':'To'} ${e.name}`,query),highlighted('p','',e.text,query),highlighted('span','message-kind',`${e.direction==='incoming'?'Reported · ': 'Simulated · '}${title(e.kind)}`,query),node('small','',`${e.direction==='incoming'?'Observed':'Queued'} ${time(e.at)}${e.receivedAt?' · received '+time(e.receivedAt):''}`));const proposal=e.report?createProposalView(e.report,{query}):null;if(proposal)bubble.append(proposal);body.append(bubble);
  }
  if(!c.events.length)body.append(emptyState('Waiting for the first message','This case remains open. Queue an inquiry or simulate an incoming report in Casework.',recordFocusKey(button('Open Casework',()=>{location.hash='casework';},'control'),'casework')));
  conversation.append(body);const foot=node('div','conversation-footer');foot.append(node('span','',c.id==='unassigned'?'These raw reports have no established case. Keep them in human review.':'Local simulation · no external messages are sent.'));
  if(c.id!=='unassigned')foot.append(recordFocusKey(button('Open message lab',()=>openMessageLab(c.id),'control'),'message-lab'));conversation.append(foot);layout.append(list,conversation);root.append(layout);restoreList(list,memory);restoreReading(root);updateMessageMatches();
  if(activeMessageSearch&&pendingMessageJumps.has(activeMessageSearch.key)&&jumpToMessageMatch()){pendingMessageJumps.delete(activeMessageSearch.key);restoreFocus();return true;}
  restoreFocus();return false;
}
function focusCaseReview(){
  const heading=$('#case-detail h2')||$('#casework h2');
  if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});heading.scrollIntoView({block:'nearest'});}
}
stateClient.subscribe(next=>{stateRevision++;familyState=next;recordsLoading=false;recordsLoadError='';renderPeople();renderMessages();});
document.addEventListener('family-action-complete',e=>{
  if(e.detail.path==='/api/reset'){clearProposalMemory();personReading.clear();threadReading.clear();listReading.clear();expandedHistories.clear();messageMatchPositions.clear();messageSearchSeen.clear();pendingMessageJumps.clear();activeMessageSearch=null;return;}
  if(e.detail.duplicate)return;
  if((e.detail.path==='/api/cases'&&location.hash==='#family')||(e.detail.path==='/api/reports'&&location.hash==='#simulator')){
    location.hash='casework';route();requestAnimationFrame(focusCaseReview);
  }
});
async function refreshState(){
  const requestId=++stateRequest;
  recordsLoading=true;recordsLoadError='';renderPeople();renderMessages();
  try{await stateClient.refresh();}
  catch(error){if(requestId===stateRequest&&!familyState)recordsLoadError=error.message;}
  finally{if(requestId===stateRequest){recordsLoading=false;renderPeople();renderMessages();}}
}

$('#person-search').addEventListener('input',()=>{personOpen=false;renderPeople(true);announceSearch($('#people-workspace .results-count')?.textContent||'No matching records.');});$('#message-search').addEventListener('input',()=>{threadOpen=false;renderMessages(true);announceSearch($('#messages-workspace .results-count')?.textContent||'No matching conversations.');});window.addEventListener('hashchange',route);$('#fill-example').addEventListener('click',()=>{location.hash='family';route();$('#example').click();});for(const el of document.querySelectorAll('[data-icon]'))el.replaceChildren(icon(el.dataset.icon));searchControls();route();refreshState();

for(const id of ['people','messages'])$('#'+id+'-view').addEventListener('scroll',()=>{const root=$('#'+id+'-workspace');rememberReading(root);rememberList(root,id==='people'?'.people-list':'.thread-list');},{passive:true});

document.addEventListener('focusin',event=>{
  if(event.target===document.body||event.target===document.documentElement)return;
  const root=event.target.closest('#people-workspace,#messages-workspace'),memory=root?rememberRecordFocus(root):null;
  lastRecordFocus=memory?.kind==='detail'?{rootId:root.id,route:location.hash,memory}:null;
},true);
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.person-record,.conversation'))lastRecordFocus=null;},{capture:true,passive:true});
recordLayout.addEventListener('change',()=>{
  const peopleRoot=$('#people-workspace'),messageRoot=$('#messages-workspace');
  const peopleFocus=viewportRecordFocus(peopleRoot,rememberRecordFocus(peopleRoot),lastRecordFocus,location.hash),messageFocus=viewportRecordFocus(messageRoot,rememberRecordFocus(messageRoot),lastRecordFocus,location.hash);
  if(mobile()){if(peopleFocus?.kind==='detail')personOpen=true;if(messageFocus?.kind==='detail')threadOpen=true;}
  for(const root of [peopleRoot,messageRoot])for(const pane of root.querySelectorAll('[data-reading-ready]'))pane.dataset.readingReady='false';
  revealRecordFocus=true;renderPeople(false,peopleFocus);renderMessages(false,false,messageFocus);revealRecordFocus=false;
});

$('#person-search').addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.key!=='Enter'||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||!$('#person-search').value.trim())return;
  const selected=$('#people-workspace .person-row[aria-pressed="true"]');
  if(selected){event.preventDefault();selected.click();}
});
$('#message-search').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&navigateMessageMatch(event.shiftKey?-1:1))event.preventDefault();});
