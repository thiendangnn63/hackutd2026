// Search existing fictional records without inventing sightings or identity matches.
export const normalize = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
export const matches = (value, query) => normalize(query).split(' ').filter(Boolean)
  .every(term => normalize(value).includes(term));

function eventsFor(state, belongs) {
  const person = id => state.participants.find(p => p.id === id)?.name || id || 'Unknown';
  return [
    ...state.reports.filter(belongs).map(r => ({
      id: r.id, caseId: r.caseId ?? null, senderId: r.senderId,
      direction: 'incoming', kind: r.processingState === 'needs_review' ? 'Needs review' : 'Reported observation',
      name: person(r.senderId), text: r.text, at: r.observedAt, receivedAt: r.receivedAt, report: r,
    })),
    ...state.outbox.filter(belongs).map(m => ({
      id: m.id, caseId: m.caseId ?? null, recipientId: m.recipientId,
      direction: 'outgoing', kind: m.kind.replaceAll('_', ' '),
      name: person(m.recipientId), text: m.text, at: m.createdAt, status: m.status,
    })),
  ].sort((a, b) => (Date.parse(a.receivedAt || a.at) || 0) - (Date.parse(b.receivedAt || b.at) || 0)
    || a.id.localeCompare(b.id));
}

export function caseEvents(state, caseId) {
  if (caseId === 'unassigned') {
    const known = new Set(state.cases.map(c => c.id));
    return eventsFor(state, event => !known.has(event.caseId));
  }
  return eventsFor(state, event => event.caseId === caseId);
}

// Recipient identity is independent of whether a case has been assigned.
export function outgoingForParticipant(state, participantId) {
  if (!participantId) return [];
  return eventsFor(state, event => event.recipientId === participantId)
    .filter(event => event.direction === 'outgoing');
}

function eventSearchText(events) {
  return events.flatMap(e => [e.id, e.caseId, e.name, e.text, e.kind]).join(' ');
}

export function caseSearchText(state, c) {
  return [Array.isArray(c.subjectNames) ? c.subjectNames.join(' ') : c.subjectNames,
    c.id, c.description, c.lastKnownTile, eventSearchText(c.events || caseEvents(state, c.id))].join(' ');
}

export function peopleIndex(state) {
  const subjects = state.cases.map(c => ({
    id: `subject:${c.id}`, name: Array.isArray(c.subjectNames) ? c.subjectNames.join(' and ') : c.subjectNames,
    kind: 'Family inquiry', caseIds: [c.id], tile: c.lastKnownTile, lastAt: c.lastContactAt,
    description: c.description, welfare: c.welfareState, location: c.locationState,
  }));
  const participants = state.participants.map(p => {
    const caseIds = state.cases.filter(c => c.reporterId === p.id
      || state.reports.some(r => r.caseId === c.id && r.senderId === p.id)
      || state.outbox.some(m => m.caseId === c.id && m.recipientId === p.id)).map(c => c.id);
    return {
      id: `participant:${p.id}`, participantId: p.id, name: p.name,
      kind: p.id === 'mom' ? 'Family reporter' : 'Community participant', caseIds,
      tile: p.currentTile, lastAt: p.locationReportedAt,
      description: p.optedIn ? 'Opted in to the fictional exercise.' : 'Opted out of future outreach.',
      welfare: 'unknown', location: p.currentTile ? 'reported_location' : 'unknown',
    };
  });
  return [...subjects, ...participants].map(p => {
    const relatedCases = p.caseIds.map(id => caseSearchText(state, state.cases.find(c => c.id === id)));
    // A person's own unassigned messages stay searchable, without creating a case association.
    const directMessages = p.participantId ? [
      ...state.reports.filter(r => r.senderId === p.participantId).map(r => r.text),
      ...state.outbox.filter(m => m.recipientId === p.participantId).map(m => m.text),
    ] : [];
    return { ...p, searchText: [p.name, p.kind, p.tile, p.description, ...relatedCases, ...directMessages].join(' ') };
  });
}

export function searchPeople(state, query = '', scope = 'all') {
  const term = normalize(query);
  return peopleIndex(state)
    .filter(p => scope === 'inquiries' ? !p.participantId : scope === 'community' ? Boolean(p.participantId) : true)
    .filter(p => matches(p.searchText, term))
    .map((p, order) => {
      const ownInfo = [p.name, p.kind, p.tile, p.description].join(' ');
      const primaryName = p.name.split(' · ')[0];
      const matchKind = !term ? 'record' : matches(primaryName, term) ? 'name'
        : matches(ownInfo, term) ? 'record' : 'related';
      const nameOrder = normalize(primaryName) === term ? 0 : normalize(primaryName).startsWith(term) ? 1 : 2;
      return { person: { ...p, matchKind }, rank: { name: 0, record: 1, related: 2 }[matchKind], nameOrder, order };
    })
    .sort((a, b) => a.rank - b.rank || (a.rank === 0 ? a.nameOrder - b.nameOrder : 0) || a.order - b.order)
    .map(result => result.person);
}

export function messageThreads(state, query = '', scope = 'all') {
  const threads = state.cases.map(c => ({ ...c, events: caseEvents(state, c.id) }));
  const unassigned = caseEvents(state, 'unassigned');
  if (unassigned.length) threads.push({
    id: 'unassigned', subjectNames: 'Unassigned reports', reviewState: 'needs_clarification',
    description: 'Reports without an existing case association. Review the original case references before assigning them.',
    events: unassigned,
  });
  return threads.filter(c => scope !== 'follow_up' || c.reviewState !== 'resolved')
    .filter(c => matches(caseSearchText(state, c), query));
}
