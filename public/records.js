// Search existing fictional records without inventing sightings or identity matches.
export const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/\s+/g,' ').trim();
export const matches=(value,query)=>normalize(query).split(' ').filter(Boolean).every(term=>normalize(value).includes(term));
export function caseEvents(state,caseId) {
  const person=id=>state.participants.find(p=>p.id===id)?.name||id||'Unknown';
  return [...state.reports.filter(r=>r.caseId===caseId).map(r=>({id:r.id,direction:'incoming',kind:r.processingState==='needs_review'?'Needs review':'Reported observation',name:person(r.senderId),text:r.text,at:r.observedAt,receivedAt:r.receivedAt,report:r})),
    ...state.outbox.filter(m=>m.caseId===caseId).map(m=>({id:m.id,direction:'outgoing',kind:m.kind.replaceAll('_',' '),name:person(m.recipientId),text:m.text,at:m.createdAt,status:m.status}))]
    .sort((a,b)=>(Date.parse(a.receivedAt||a.at)||0)-(Date.parse(b.receivedAt||b.at)||0)||a.id.localeCompare(b.id));
}
export function caseSearchText(state,c) {
  return [Array.isArray(c.subjectNames)?c.subjectNames.join(' '):c.subjectNames,c.id,c.description,c.lastKnownTile,...caseEvents(state,c.id).flatMap(e=>[e.name,e.text,e.kind])].join(' ');
}
export function peopleIndex(state) {
  const subjects=state.cases.map(c=>({id:`subject:${c.id}`,name:Array.isArray(c.subjectNames)?c.subjectNames.join(' and '):c.subjectNames,kind:'Family inquiry',caseIds:[c.id],tile:c.lastKnownTile,lastAt:c.lastContactAt,description:c.description,welfare:c.welfareState,location:c.locationState}));
  const participants=state.participants.map(p=>{
    const caseIds=state.cases.filter(c=>c.reporterId===p.id||state.reports.some(r=>r.caseId===c.id&&r.senderId===p.id)||state.outbox.some(m=>m.caseId===c.id&&m.recipientId===p.id)).map(c=>c.id);
    return {id:`participant:${p.id}`,participantId:p.id,name:p.name,kind:p.id==='mom'?'Family reporter':'Community participant',caseIds,tile:p.currentTile,lastAt:p.locationReportedAt,description:p.optedIn?'Opted in to the fictional exercise.':'Opted out of future outreach.',welfare:'unknown',location:p.currentTile?'reported_location':'unknown'};
  });
  return [...subjects,...participants].map(p=>({...p,searchText:[p.name,p.kind,p.tile,p.description,...p.caseIds.map(id=>caseSearchText(state,state.cases.find(c=>c.id===id)))].join(' ')}));
}
