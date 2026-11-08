import { randomUUID } from 'node:crypto';

export const SCENARIO_TIME = '2026-11-07T14:30:00.000Z';
export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const copy = (value) => structuredClone(value);
function requireText(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(`${label} must be 1–${max} characters.`);
  return value.trim();
}
function timestamp(value, label, now) {
  const parts = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts || !Number.isFinite(Date.parse(value))) throw new InputError(`${label} needs a valid date and time with timezone.`);
  const [, year, month, day, hour, minute, second = '0'] = parts;
  if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate() || +hour > 23 || +minute > 59 || +second > 59) throw new InputError(`${label} needs a real calendar date and time.`);
  if (Date.parse(value) > Date.parse(now)) throw new InputError(`${label} cannot be after the scenario clock.`);
  return new Date(value).toISOString();
}
function getCase(state, caseId) {
  const item = state.cases.find((c) => c.id === caseId);
  if (!item) throw new InputError('Case not found.', 404);
  return item;
}
function getParticipant(state, participantId) {
  const participant = state.participants.find((p) => p.id === participantId);
  if (!participant) throw new InputError('Fictional participant not found.', 404);
  return participant;
}
function log(state, action, detail) { state.audit.unshift({ id: id('A'), at: new Date().toISOString(), action, detail }); }
function queue(state, { caseId, recipientId, kind, text }) {
  const recipient = getParticipant(state, recipientId);
  if (!recipient.optedIn) return;
  state.outbox.push({ id: id('M'), caseId, recipientId, kind, text, status: 'simulated', createdAt: new Date().toISOString() });
}

export function createSeed() {
  const fixture = (id, name, n, currentTile, locationReportedAt, optedIn = true) => ({ id, name, phone: `+121255501${n}`, currentTile, locationReportedAt, optedIn, source: 'fixture' });
  return {
    mode: 'simulation', scenarioTime: SCENARIO_TIME,
    incident: { id: 'DEMO-EQ-01', name: 'Oak District earthquake exercise', active: true, tiles: ['A1', 'A2', 'B1', 'B2'], policy: { maxTiles: 2, locationMaxAgeMinutes: 120, maxRecipients: 20 } },
    participants: [
      fixture('mom', 'Maya Santos · family', '00', 'OUTSIDE', '2026-11-07T14:10:00.000Z'),
      fixture('neighbor-1', 'Jordan Lee · neighbor', '01', 'A1', '2026-11-07T14:15:00.000Z'),
      fixture('neighbor-2', 'Sam Patel · neighbor', '02', 'A2', '2026-11-07T14:05:00.000Z'),
      fixture('stale-neighbor', 'Avery Kim · stale location', '03', 'A1', '2026-11-07T09:00:00.000Z'),
      fixture('opted-out', 'Taylor Morgan · opted out', '04', 'A1', '2026-11-07T14:00:00.000Z', false),
      fixture('outside-area', 'Alex Chen · different tile', '05', 'B2', '2026-11-07T14:10:00.000Z'),
      fixture('unknown-location', 'Casey Park · no area', '06', null, null),
    ],
    cases: [{ id: 'C104', subjectNames: 'Elena Brooks', description: 'Fictional family member has not replied since the exercise began. No sightings received.', reporterId: 'mom', lastKnownTile: 'B1', lastContactAt: '2026-11-07T12:15:00.000Z', searchTiles: ['B1'], consentToOutreach: true, reviewState: 'follow_up_requested', locationState: 'unknown', welfareState: 'unknown', outreachState: 'ready', createdAt: SCENARIO_TIME, reportIds: [], verification: null, policyReasons: [], nextStep: 'Request a recent observation from an enrolled participant in B1. No reply is not proof of harm.' }],
    nextCaseNumber: 105, reports: [], assistance: [], outbox: [], audit: [],
    integrations: { photon: 'not_connected', nemotron: 'simulated', broadcast: 'simulated' },
  };
}

export function eligibleRecipients(state, item) {
  const cutoff = Date.parse(state.scenarioTime) - state.incident.policy.locationMaxAgeMinutes * 60_000;
  return state.participants.filter((p) => p.optedIn && p.id !== item.reporterId && item.searchTiles.includes(p.currentTile) && Date.parse(p.locationReportedAt) >= cutoff && Date.parse(p.locationReportedAt) <= Date.parse(state.scenarioTime));
}

export function openCase(state, input) {
  const subjectNames = requireText(input.subjectNames, 'Subject names', 160);
  const description = requireText(input.description, 'Description', 1500);
  getParticipant(state, input.reporterId);
  if (!state.incident.tiles.includes(input.lastKnownTile)) throw new InputError('Choose a last-known tile in the exercise area.');
  if (!Array.isArray(input.searchTiles) || input.searchTiles.length === 0 || input.searchTiles.some((tile) => !state.incident.tiles.includes(tile))) throw new InputError('Choose valid search tiles.');
  const searchTiles = [...new Set(input.searchTiles)];
  const lastContactAt = timestamp(input.lastContactAt, 'Last contact', state.scenarioTime);
  const policyReasons = [];
  if (!state.incident.active) policyReasons.push('No active incident.');
  if (input.consentToOutreach !== true) policyReasons.push('Permission to share this fictional description has not been given.');
  if (searchTiles.length > state.incident.policy.maxTiles) policyReasons.push(`Search exceeds the ${state.incident.policy.maxTiles}-tile demo policy.`);
  const item = { id: `C${state.nextCaseNumber++}`, subjectNames, description, reporterId: input.reporterId, lastKnownTile: input.lastKnownTile, lastContactAt, searchTiles, consentToOutreach: input.consentToOutreach === true, reviewState: policyReasons.length ? 'awaiting_review' : 'open', locationState: 'unknown', welfareState: 'unknown', outreachState: policyReasons.length ? 'needs_review' : 'ready', createdAt: new Date().toISOString(), reportIds: [], verification: null, policyReasons, nextStep: policyReasons.length ? 'Officer must review the outreach policy gap.' : 'Send a scoped, simulated inquiry to eligible participants.' };
  state.cases.unshift(item);
  log(state, 'case.opened', `${item.id}: family reports loss of contact, not confirmed missing.`);
  return { caseId: item.id };
}

export function sendOutreach(state, caseId) {
  const item = getCase(state, caseId);
  if (!state.incident.active || !item.consentToOutreach || item.outreachState === 'needs_review') throw new InputError('Outreach requires incident policy review.', 409);
  if (item.reviewState === 'resolved' || item.outreachState === 'stopped') throw new InputError('Outreach has stopped for this case.', 409);
  const recipients = eligibleRecipients(state, item);
  if (recipients.length > state.incident.policy.maxRecipients) throw new InputError('Recipient limit exceeded. Officer review required.', 409);
  let queued = 0;
  for (const p of recipients) {
    if (state.outbox.some((m) => m.caseId === caseId && m.recipientId === p.id && m.kind === 'inquiry')) continue;
    queue(state, { caseId, recipientId: p.id, kind: 'inquiry', text: `SIMULATION ${caseId}: Family seeks contact with ${item.subjectNames}. ${item.description} Last-known area: ${item.lastKnownTile}. If you have an observation, reply with ${caseId}, where and when. Do not enter unsafe areas. Reply STOP to opt out.` });
    queued++;
  }
  item.outreachState = queued || state.outbox.some((m) => m.caseId === caseId && m.kind === 'inquiry') ? 'queued' : 'ready';
  item.nextStep = recipients.length ? 'Await observations. Simulated delivery does not establish safety.' : 'No fresh opted-in participants match. Coverage remains unknown.';
  log(state, 'outreach.simulated', `${caseId}: ${queued} new inquiries; stale, opted-out and outside-area participants excluded.`);
  return { caseId, queued };
}

// Explicit fixture-only extractor. This is NOT a Nemotron implementation.
export function extractSimulated(text, subjectNames = null) {
  const observations = [];
  const reviewFlags = [];
  const add = (type, summary, span, quantity = null, location = null) => observations.push({ id: id('O'), type, summary, sourceSpan: span, quantity, location, verification: 'reported' });
  if (/\b(trapped|injured|bleeding|urgent|help|breathing)\b/i.test(text)) reviewFlags.push('urgent_human_review');
  if (/\b(not|no|never|nothing|neither|nobody|without|correction|yesterday|wrong|(?:did|does|do|was|were|is|are|has|have|had|can|could|would|should|won|must)n?[’']t)\b/i.test(text)) {
    add('correction', 'Correction, negation or older observation requires review. No positive condition inferred.', text);
    reviewFlags.push('correction_or_negation');
    return { observations, reviewFlags };
  }
  const location = text.match(/\b(?:at|near)\s+(Oak School|Oak Street|Maple Clinic|River Park)\b/i)?.[1] || null;
  const sighting = text.match(/\b(?:I saw|I can see|they are here|they're here)\b[^.!?]*/i);
  if (sighting) {
    const subjectWords = (subjectNames || '').toLowerCase().match(/[a-z]{3,}/g)?.filter((word) => !['and', 'the'].includes(word)) || [];
    const mentionedWords = sighting[0].toLowerCase().match(/[a-z]+/g) || [];
    if (subjectWords.some((word) => mentionedWords.includes(word))) add('sighting', 'Community member reports a sighting; identity and welfare unverified.', sighting[0], null, location);
    else reviewFlags.push('sighting_subject_needs_clarification');
  }
  const safe = text.match(/\bI am safe\b/i);
  if (safe) add('self_check_in', 'Sender reports their own safety; does not establish anyone else’s status.', safe[0], 1, location);
  const water = text.match(/\b(?:[^.!?]*\b(?:need|needs)\s+water[^.!?]*)/i);
  if (water) {
    const quantity = /\btwo\b|\b2\b/i.test(water[0]) ? 2 : null;
    add('water_need', `${quantity ?? 'Unknown number of'} people reportedly need water.`, water[0].trim(), quantity, location);
  }
  const road = text.match(/\b(?:the\s+)?road\s+is\s+blocked\b/i);
  if (road) add('road_blockage', 'Road blockage reported; access has not been verified.', road[0], null, location);
  if (!observations.length) {
    add('unknown', 'Free-form message retained for officer review; outside the scripted extractor.', text);
    reviewFlags.push('unrecognized_text');
  }
  if (!location) reviewFlags.push('location_needs_clarification');
  return { observations, reviewFlags };
}

export function receiveReport(state, input) {
  const providerEventId = requireText(input.providerEventId, 'Provider event ID', 120);
  const existing = state.reports.find((r) => r.providerEventId === providerEventId);
  if (existing) return { duplicate: true, reportId: existing.id, caseId: existing.caseId };
  const sender = getParticipant(state, input.senderId);
  const text = requireText(input.text, 'Message', 3000);
  const command = text.trim().toUpperCase();
  const item = input.caseId ? getCase(state, input.caseId) : null;
  const observedAt = input.observedAt ? timestamp(input.observedAt, 'Observation time', state.scenarioTime) : null;
  const report = { id: id('R'), providerEventId, senderId: sender.id, caseId: item?.id ?? null, text, observedAt, receivedAt: new Date().toISOString(), processingState: 'processed', processingPath: 'simulated_extraction', observations: [], reviewFlags: [] };
  // Persist raw event in the state before extraction. Failures remain reviewable.
  state.reports.push(report);
  if (item) item.reportIds.push(report.id);
  if (command === 'STOP') {
    sender.optedIn = false;
    report.processingPath = 'deterministic';
    log(state, 'consent.revoked', `${sender.id}: STOP processed; no further outreach or automatic replies.`);
    return { reportId: report.id, caseId: item?.id ?? null, duplicate: false };
  }
  const caseReferences = [...new Set(text.toUpperCase().match(/\bC\d+\b/g) || [])];
  const conflictingCaseReference = caseReferences.length > 0 && (!item || caseReferences.some((reference) => reference !== item.id));
  if (conflictingCaseReference) {
    report.processingPath = 'deterministic';
    report.processingState = 'needs_review';
    report.reviewFlags.push('case_reference_conflict');
  } else if (command === 'CHECKIN') {
    report.processingPath = 'deterministic';
    report.reviewFlags.push('enrollment_needs_confirmation');
    queue(state, { caseId: item?.id ?? null, recipientId: sender.id, kind: 'acknowledgment', text: 'SIMULATION: Share your current area and confirm permission for follow-up messages. CHECKIN alone does not confirm safety or enroll you.' });
  } else if (input.simulateFailure === true) {
    report.processingState = 'needs_review'; report.processingPath = 'failed';
    report.reviewFlags.push('simulated_model_failure');
  } else {
    Object.assign(report, extractSimulated(text, item?.subjectNames));
    if (!observedAt) report.reviewFlags.push('observation_time_missing');
    else if (Date.parse(state.scenarioTime) - Date.parse(observedAt) > 120 * 60_000) report.reviewFlags.push('stale_observation');
    if (!item) report.reviewFlags.push('case_needs_clarification');
    if (report.reviewFlags.length) report.processingState = 'needs_review';
  }
  if (item && command !== 'CHECKIN') {
    const hasSighting = report.observations.some((o) => o.type === 'sighting');
    if (item.reviewState !== 'resolved') {
      item.reviewState = 'awaiting_review';
      item.nextStep = 'Review source, observation time, location, and any contradictions. Obtain direct confirmation.';
      if (hasSighting && item.locationState !== 'verified_location') item.locationState = 'unverified_sighting';
    }
    if (hasSighting) queue(state, { caseId: item.id, recipientId: item.reporterId, kind: 'family_update', text: `SIMULATION ${item.id}: An unverified community sighting was reported${observedAt ? ` at scenario time ${observedAt}` : '; observation time unknown'}. This does not confirm identity or safety. Officer review is pending.` });
    for (const observation of report.observations.filter((o) => o.type === 'water_need')) {
      state.assistance.push({ id: id('T'), caseId: item.id, reportId: report.id, type: observation.type, summary: observation.summary, status: 'unassigned' });
    }
    queue(state, { caseId: item.id, recipientId: sender.id, kind: 'acknowledgment', text: `SIMULATION ${item.id}: Report received${report.processingState === 'needs_review' ? ' and awaiting review' : ''}. Receipt is not a promise that help has been assigned.${report.reviewFlags.includes('location_needs_clarification') ? ' Where did you observe this?' : ''}` });
  }
  log(state, 'report.received', `${report.id}: ${report.processingPath}; ${report.observations.length} observations, ${report.reviewFlags.length} review flags.`);
  return { reportId: report.id, caseId: item?.id ?? null, duplicate: false };
}

export function verifyCase(state, caseId, input) {
  const item = getCase(state, caseId);
  if (item.reviewState === 'resolved') throw new InputError('Case is already resolved.', 409);
  const officerName = requireText(input.officerName, 'Demo officer name', 120);
  const note = requireText(input.note, 'Verification basis', 1500);
  if (note.length < 20) throw new InputError('Describe the direct confirmation and the people confirmed (at least 20 characters).');
  if (!['confirmed_safe', 'assistance_needed'].includes(input.welfare)) throw new InputError('Choose a welfare outcome.');
  if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length) throw new InputError('Select at least one case evidence record.');
  const evidenceIds = [...new Set(input.evidenceIds)];
  const reports = evidenceIds.map((reportId) => {
    const report = state.reports.find((r) => r.id === reportId && r.caseId === caseId);
    if (!report) throw new InputError('Every evidence record must belong to this case.');
    return report;
  });
  if (!reports.some((r) => r.observations.some((o) => o.type === 'sighting'))) throw new InputError('A sighting record and a direct confirmation note are required for this demo. Failed or unrelated reports alone cannot verify location.');
  item.locationState = 'verified_location';
  item.welfareState = input.welfare;
  item.reviewState = input.resolve === true ? 'resolved' : 'follow_up_requested';
  item.outreachState = 'stopped';
  item.verification = { officerName, note, evidenceIds, verifiedAt: new Date().toISOString() };
  item.nextStep = state.assistance.some((a) => a.caseId === caseId && a.status !== 'completed') ? 'Search stopped. A separate assistance task remains open.' : 'Search stopped after the demo officer recorded direct confirmation.';
  queue(state, { caseId, recipientId: item.reporterId, kind: 'family_update', text: `SIMULATION ${caseId}: ${officerName} recorded a verified location and ${input.welfare.replaceAll('_', ' ')}. ${item.nextStep}` });
  log(state, 'case.verified_by_demo_officer', `${caseId}: ${input.welfare}; ${evidenceIds.length} evidence records. Assistance tasks are not auto-completed.`);
  return { caseId };
}

export function setConsent(state, participantId, input) {
  if (typeof input.optedIn !== 'boolean') throw new InputError('optedIn must be true or false.');
  const participant = getParticipant(state, participantId);
  participant.optedIn = input.optedIn;
  log(state, 'consent.changed', `${participantId}: ${input.optedIn ? 'opted in for exercise' : 'opted out'}.`);
  return { participantId };
}

// Transactional update: validation failures never partially mutate stored state.
export function applyAction(state, action, ...args) {
  const next = copy(state);
  const result = action(next, ...args);
  return { state: next, result };
}
