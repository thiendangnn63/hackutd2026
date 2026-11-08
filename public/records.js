// Search existing fictional records without inventing sightings or identity matches.
export const normalize = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
export const matches = (value, query) => normalize(query).split(' ').filter(Boolean)
  .every(term => normalize(value).includes(term));

// A receipt is known only when the API timestamp identifies a valid absolute date.
function receiptTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const time = Date.parse(value), day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(time) && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) ? time : NaN;
}

// Receipt order includes corrections, failures and commands. Unknown receipts
// preserve the last recorded entry without claiming it arrived most recently.
export function latestReceivedReport(reports) {
  if (!reports.length) return null;
  const times = reports.map(report => receiptTime(report.receivedAt));
  if (times.some(time => !Number.isFinite(time))) return { report: reports.at(-1), receiptOrderKnown: false };
  let latest = 0;
  for (let index = 1; index < reports.length; index++) if (times[index] >= times[latest]) latest = index;
  return { report: reports[latest], receiptOrderKnown: true };
}

export function incomingReportKind(report) {
  const command = typeof report.text === 'string' ? report.text.trim().toUpperCase() : '';
  if (report.processingPath === 'deterministic' && command === 'STOP') return 'Opt-out command';
  if (report.processingPath === 'deterministic' && command === 'CHECKIN') return 'Enrollment request';
  return report.processingPath === 'failed' || report.processingState === 'needs_review' ? 'Needs review' : 'Reported observation';
}

function eventsFor(state, belongs) {
  const person = id => state.participants.find(p => p.id === id)?.name || id || 'Unknown';
  return [
    ...state.reports.filter(belongs).map(r => ({
      id: r.id, caseId: r.caseId ?? null, senderId: r.senderId,
      direction: 'incoming', kind: incomingReportKind(r),
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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const queryTokens = query => [...new Set(normalize(query).split(' ').filter(Boolean))];

// Keep a source range for each normalized UTF-16 unit, expanding visible marks to
// complete graphemes so an accent or emoji sequence is never split by a segment.
function normalizedOffsets(source) {
  let decomposed = '';
  const origins = [];
  for (const { segment, index } of graphemes.segment(source)) {
    const part = segment.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    decomposed += part;
    for (let i = 0; i < part.length; i++) origins.push({ start: index, end: index + segment.length });
  }
  // Lowercase the complete string to preserve contextual forms such as Greek sigma.
  const lowered = decomposed.toLocaleLowerCase(), lowerOrigins = [];
  let offset = 0;
  for (const character of decomposed) {
    for (let i = 0; i < character.toLocaleLowerCase().length; i++) lowerOrigins.push(origins[offset]);
    offset += character.length;
  }
  // This is only needed for a locale whose contextual casing changes output length.
  if (lowerOrigins.length !== lowered.length) {
    lowerOrigins.length = 0;
    offset = 0;
    for (const character of decomposed) {
      const end = offset + character.length;
      const length = decomposed.slice(0, end).toLocaleLowerCase().length;
      while (lowerOrigins.length < length) lowerOrigins.push(origins[offset]);
      offset = end;
    }
  }
  let normalized = '', whitespace = null;
  const ranges = [];
  for (let i = 0; i < lowered.length;) {
    const character = String.fromCodePoint(lowered.codePointAt(i)), range = lowerOrigins[i];
    if (/\s/u.test(character)) {
      whitespace = { start: whitespace?.start ?? range.start, end: range.end };
    } else {
      if (normalized && whitespace) { normalized += ' '; ranges.push(whitespace); }
      whitespace = null;
      normalized += character;
      for (let j = 0; j < character.length; j++) ranges.push(range);
    }
    i += character.length;
  }
  return { normalized, ranges };
}

export function searchSegments(value, query) {
  const source = String(value ?? ''), tokens = queryTokens(query);
  if (!source || !tokens.length) return [{ text: source, matched: false }];
  const { normalized, ranges } = normalizedOffsets(source), hits = [];
  for (const token of tokens) {
    for (let start = normalized.indexOf(token); start !== -1; start = normalized.indexOf(token, start + 1)) {
      hits.push({ start: ranges[start].start, end: ranges[start + token.length - 1].end });
    }
  }
  if (!hits.length) return [{ text: source, matched: false }];
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const hit of hits) {
    const previous = merged.at(-1);
    if (previous && hit.start <= previous.end) previous.end = Math.max(previous.end, hit.end);
    else merged.push({ ...hit });
  }
  const segments = [];
  let cursor = 0;
  for (const hit of merged) {
    if (hit.start > cursor) segments.push({ text: source.slice(cursor, hit.start), matched: false });
    segments.push({ text: source.slice(hit.start, hit.end), matched: true });
    cursor = hit.end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), matched: false });
  return segments;
}

export function messageHitIds(events, query) {
  const tokens = queryTokens(query), fullIds = [], relatedIds = [];
  if (!tokens.length) return { fullIds, relatedIds };
  for (const event of events) {
    // IDs and other metadata may filter a thread, but must not imply a visible text hit.
    const visible = normalize([event.name, event.kind, event.text].join(' '));
    const hits = tokens.map(token => visible.includes(token));
    if (hits.every(Boolean)) fullIds.push(event.id);
    if (hits.some(Boolean)) relatedIds.push(event.id);
  }
  return { fullIds, relatedIds };
}
