// Inactive synthetic intake/proposal preparation. No transport, credentials,
// environment reads, startup work or automatic domain transitions live here.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateExtraction } from './nemotron-client.js';

const VERSION = 1;
const EXTRACTOR_SOURCES = new Set(['nvidia_nemotron', 'local_demo_rules']);
const proposalPath = source => source === 'local_demo_rules' ? 'local_demo_rules' : 'nemotron';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const failureCodes = new Set(['timeout', 'cancelled', 'invalid_output', 'invalid_response', 'oversized_output', 'provider_unavailable', 'rate_limited', 'connection_failed', 'disabled', 'data_scope', 'extractor_failed']);

export class InboxError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'InboxError'; this.code = code; this.status = status; }
}
function requireValue(ok, code, message, status) { if (!ok) throw new InboxError(code, message, status); }
function identifier(value, label, max = 160) {
  requireValue(typeof value === 'string' && value.trim().length <= max && /^[!-~]+$/.test(value.trim()), 'invalid_identity', `Use a bounded ${label} identifier.`);
  return value.trim();
}
export function canonicalProviderIdentity({ provider, projectId, messageId } = {}) {
  provider = identifier(provider, 'provider', 32).toLowerCase();
  requireValue(/^[a-z][a-z0-9._-]*$/.test(provider), 'invalid_identity', 'Use a canonical provider identifier.');
  return { provider, projectId: identifier(projectId, 'project'), messageId: identifier(messageId, 'message') };
}
function observationTime(value, now) {
  if (value === null || value === undefined || value === '') return null;
  const parts = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/);
  requireValue(parts && Number.isFinite(Date.parse(value)), 'invalid_time', 'Observation time needs a valid absolute timestamp.');
  const [, year, month, day, hour, minute, second = '0', , , offsetHour = '0', offsetMinute = '0'] = parts;
  requireValue(+year >= 1000 && +month >= 1 && +month <= 12 && +day >= 1 && +day <= new Date(Date.UTC(+year, +month, 0)).getUTCDate() && +hour <= 23 && +minute <= 59 && +second <= 59 && +offsetHour <= 23 && +offsetMinute <= 59 && Date.parse(value) <= Date.parse(now), 'invalid_time', 'Observation time must be real and no later than the scenario clock.');
  return new Date(value).toISOString();
}
function subjects(item) {
  if (!item) return [];
  const names = Array.isArray(item.subjectNames) ? item.subjectNames : [item.subjectNames];
  requireValue(names.length > 0 && names.length <= 8 && names.every(name => typeof name === 'string' && name.trim() && name.length <= 160), 'invalid_case', 'The linked case needs bounded fictional subject names.');
  return structuredClone(names);
}
function sourceSnapshot(state, report) {
  const item = report.caseId === null ? null : state.cases.find(item => item.id === report.caseId);
  if (report.caseId !== null && !item) return null;
  const sender = state.participants.find(item => item.id === report.senderId && item.source === 'fixture');
  if (state.mode !== 'simulation' || !sender) return null;
  return { version: VERSION, dataClass: 'synthetic', providerIdentity: structuredClone(report.providerIdentity), senderId: report.senderId, caseId: report.caseId, text: report.text, observedAt: report.observedAt, subjectNames: subjects(item) };
}
function audit(state, action, reportId, detail = 'proposal review only; no family or assistance state applied.') {
  state.audit.unshift({ id: `A-${randomUUID()}`, at: stamp(), action, detail: `${reportId}: ${detail}` });
}
function getReport(state, reportId) {
  const report = state.reports.find(report => report.id === reportId && report.modelReview?.version === VERSION);
  requireValue(report, 'not_found', 'Inbox report not found.', 404);
  return report;
}
function currentSourceMatches(state, report) {
  try { const current = sourceSnapshot(state, report); return current !== null && hash(current) === report.modelReview.sourceHash && hash(report.modelReview.source) === report.modelReview.sourceHash; }
  catch { return false; }
}
function markStale(state, report) {
  Object.assign(report.modelReview, { status: 'stale', claim: null, proposal: null, proposalToken: null, reviewDecision: null, errorCode: 'source_changed', updatedAt: stamp() });
  audit(state, 'inbox.source_changed', report.id);
  return { reportId: report.id, status: 'stale', completed: false, reason: 'source_changed' };
}

// Synchronous Store.act action. Raw content is durable before any async work.
// The tuple hash namespaces provider IDs independently of the existing simulator.
export function captureRawReport(state, input = {}) {
  requireValue(state.mode === 'simulation' && input.dataClass === 'synthetic', 'data_scope', 'Declare synthetic exercise data explicitly.');
  const providerIdentity = canonicalProviderIdentity(input);
  const providerEventId = `inbox:${hash([providerIdentity.provider, providerIdentity.projectId, providerIdentity.messageId])}`;
  const sender = state.participants.find(item => item.id === input.senderId && item.source === 'fixture');
  requireValue(sender, 'invalid_sender', 'Choose a known fictional sender alias.');
  requireValue(typeof input.text === 'string' && input.text.trim() && input.text.length <= 3000, 'invalid_text', 'Use a nonempty fictional report of at most 3000 characters.');
  const caseId = input.caseId === undefined || input.caseId === null || input.caseId === '' ? null : input.caseId;
  requireValue(caseId === null || typeof caseId === 'string' && state.cases.some(item => item.id === caseId), 'invalid_case', 'Use an explicit known case link or leave the report unassigned.');
  const observedAt = observationTime(input.observedAt, state.scenarioTime);
  const payloadHash = hash({ senderId: sender.id, caseId, text: input.text, observedAt });
  const duplicate = state.reports.find(report => report.providerEventId === providerEventId);
  if (duplicate) {
    requireValue(duplicate.modelReview?.payloadHash === payloadHash, 'duplicate_conflict', 'This provider identity was already captured with different content.', 409);
    return { reportId: duplicate.id, caseId: duplicate.caseId, duplicate: true, status: duplicate.modelReview.status };
  }
  const command = input.text.trim().toUpperCase(), deterministic = ['STOP', 'CHECKIN'].includes(command);
  const report = { id: `R-${randomUUID()}`, providerEventId, providerIdentity, senderId: sender.id, caseId, text: input.text, observedAt, receivedAt: stamp(), processingState: command === 'STOP' ? 'processed' : 'needs_review', processingPath: deterministic ? 'deterministic' : 'raw_inbox', observations: [], reviewFlags: [deterministic ? command === 'STOP' ? 'consent_revoked' : 'enrollment_needs_confirmation' : 'model_review_pending', ...(!observedAt ? ['observation_time_missing'] : []), ...(caseId === null ? ['case_needs_clarification'] : [])] };
  const source = sourceSnapshot(state, report);
  report.modelReview = { version: VERSION, status: deterministic ? command === 'STOP' ? 'command_processed' : 'command_review' : 'queued', source, sourceHash: hash(source), payloadHash, attempts: 0, claim: null, proposal: null, proposalToken: null, reviewDecision: null, errorCode: null, updatedAt: report.receivedAt };
  if (command === 'STOP') sender.optedIn = false;
  state.reports.push(report);
  audit(state, 'inbox.raw_captured', report.id);
  return { reportId: report.id, caseId, duplicate: false, status: report.modelReview.status };
}

// Synchronous action. A persisted lease makes abandoned work reclaimable after
// restart; only the new opaque token may complete a reclaimed job.
export function claimReportJob(state, { reportId, leaseMs = 30000, extractorSource = 'nvidia_nemotron' } = {}) {
  requireValue(EXTRACTOR_SOURCES.has(extractorSource), 'invalid_configuration', 'Choose an explicitly supported extractor source.');
  requireValue(Number.isInteger(leaseMs) && leaseMs >= 50 && leaseMs <= 120000, 'invalid_lease', 'Use a bounded job lease.');
  requireValue(reportId === undefined || typeof reportId === 'string' && reportId.trim(), 'invalid_report', 'Choose a report ID or omit it.');
  const now = Date.now();
  const claimable = report => report.modelReview?.version === VERSION && (report.modelReview.status === 'queued' || report.modelReview.status === 'running' && Date.parse(report.modelReview.claim?.expiresAt) <= now);
  const report = reportId ? getReport(state, reportId) : state.reports.find(claimable);
  if (!report || !claimable(report)) return { claimed: false, reportId: report?.id, status: report ? report.modelReview.status : null, reason: report ? report.modelReview.status : 'empty' };
  if (!currentSourceMatches(state, report)) return { claimed: false, ...markStale(state, report) };
  const claimToken = randomUUID(), sourceHash = report.modelReview.sourceHash;
  Object.assign(report.modelReview, { status: 'running', attempts: report.modelReview.attempts + 1, proposal: null, proposalToken: null, reviewDecision: null, errorCode: null, updatedAt: new Date(now).toISOString(), extractorSource, claim: { token: claimToken, sourceHash, extractorSource, claimedAt: new Date(now).toISOString(), expiresAt: new Date(now + leaseMs).toISOString() } });
  audit(state, 'inbox.job_claimed', report.id);
  return { claimed: true, reportId: report.id, claimToken, sourceHash, extractorSource, attempt: report.modelReview.attempts, input: { dataClass: 'synthetic', text: report.modelReview.source.text, subjectNames: structuredClone(report.modelReview.source.subjectNames) } };
}
function matchingClaim(state, input) {
  const report = getReport(state, input.reportId), review = report.modelReview;
  const expiry = Date.parse(review.claim?.expiresAt);
  // The trusted caller chooses provenance before invocation. Extractor output
  // cannot relabel a local rule result as a remote model response (or vice versa).
  const source = input.extractorSource ?? 'nvidia_nemotron';
  if (!EXTRACTOR_SOURCES.has(source) || (review.extractorSource ?? 'nvidia_nemotron') !== source || (review.claim?.extractorSource ?? 'nvidia_nemotron') !== source) return { rejected: { reportId: report.id, status: review.status, completed: false, reason: 'stale_claim' } };
  if (review.status !== 'running' || typeof input.claimToken !== 'string' || review.claim?.token !== input.claimToken || review.claim.sourceHash !== input.sourceHash || review.sourceHash !== input.sourceHash || !Number.isFinite(expiry) || expiry <= Date.now()) return { rejected: { reportId: report.id, status: review.status, completed: false, reason: 'stale_claim' } };
  if (!currentSourceMatches(state, report)) return { rejected: markStale(state, report) };
  return { report };
}
function validatedProposal(value, report) {
  // Both extractors return a review envelope. Revalidate the persisted source
  // and require the path chosen by the trusted claim, never by returned output.
  requireValue(report.modelReview.extractorSource === undefined || EXTRACTOR_SOURCES.has(report.modelReview.extractorSource), 'invalid_output', 'The proposal source is invalid.');
  const path = proposalPath(report.modelReview.extractorSource);
  if (object(value) && (own(value, 'requiresReview') || own(value, 'processingPath'))) {
    requireValue(Object.keys(value).every(key => ['observations', 'reviewFlags', 'requiresReview', 'processingPath'].includes(key)) && value.requiresReview === true && value.processingPath === path && Array.isArray(value.reviewFlags) && value.reviewFlags.length <= 13 && value.reviewFlags.includes('model_output_needs_review'), 'invalid_output', 'The proposal envelope is invalid.');
    value = { observations: value.observations, reviewFlags: value.reviewFlags.filter(flag => flag !== 'model_output_needs_review') };
  }
  return { ...validateExtraction(value, report.modelReview.source.text, { subjectNames: report.modelReview.source.subjectNames }), processingPath: path };
}
function proposalFingerprint(report, proposal) {
  // Reports created before explicit provenance retain their existing review token.
  return hash({ version: VERSION, reportId: report.id, sourceHash: report.modelReview.sourceHash, ...(report.modelReview.extractorSource !== undefined ? { extractorSource: report.modelReview.extractorSource } : {}), proposal });
}
export function completeReportJob(state, input = {}) {
  const { report, rejected } = matchingClaim(state, input);
  if (rejected) return rejected;
  let proposal;
  try { proposal = validatedProposal(input.proposal, report); }
  catch { return failReportJob(state, { ...input, code: 'invalid_output' }); }
  Object.assign(report.modelReview, { status: 'proposal_ready', proposal, proposalToken: proposalFingerprint(report, proposal), reviewDecision: null, errorCode: null, claim: null, updatedAt: stamp() });
  report.reviewFlags = report.reviewFlags.filter(flag => flag !== 'model_review_pending');
  report.reviewFlags.push('model_proposal_needs_review');
  audit(state, 'inbox.proposal_ready', report.id);
  return { reportId: report.id, status: 'proposal_ready', completed: true };
}
export function failReportJob(state, input = {}) {
  const { report, rejected } = matchingClaim(state, input);
  if (rejected) return rejected;
  const errorCode = failureCodes.has(input.code) ? input.code : 'extractor_failed';
  Object.assign(report.modelReview, { status: 'failed', proposal: null, proposalToken: null, reviewDecision: null, errorCode, claim: null, updatedAt: stamp() });
  report.reviewFlags = report.reviewFlags.filter(flag => flag !== 'model_review_pending');
  report.reviewFlags.push('model_extraction_failed');
  audit(state, 'inbox.job_failed', report.id);
  return { reportId: report.id, status: 'failed', completed: false, errorCode };
}

function reviewText(value, label, maximum) {
  requireValue(typeof value === 'string' && value.trim() && value.trim().length <= maximum,
    'invalid_review', `Use a nonempty ${label} of at most ${maximum} characters.`);
  return value.trim();
}
function selectedIndices(input, count) {
  if (input === undefined) return Array.from({ length: count }, (_, index) => index);
  requireValue(Array.isArray(input) && input.length > 0 && input.length <= 12 && input.every(index => Number.isInteger(index) && index >= 0 && index < count),
    'invalid_selection', 'Select supported observation indices from the displayed proposal.');
  return [...new Set(input)].sort((a, b) => a - b);
}
function currentProposal(state, report, expectedToken) {
  const review = report.modelReview;
  requireValue(currentSourceMatches(state, report), 'source_changed', 'The report or linked case changed. Refresh before reviewing.', 409);
  let proposal;
  try { proposal = validatedProposal(review.proposal, report); }
  catch { throw new InboxError('invalid_proposal', 'This proposal is no longer valid. Refresh before reviewing.', 409); }
  requireValue(isDeepStrictEqual(proposal, review.proposal), 'invalid_proposal', 'The displayed proposal is no longer canonical. Refresh before reviewing.', 409);
  const proposalToken = proposalFingerprint(report, proposal);
  requireValue(review.proposalToken === proposalToken && expectedToken === proposalToken,
    'stale_proposal', 'The displayed proposal changed. Refresh before reviewing.', 409);
  return proposal;
}
function reviewProposal(state, input, action) {
  const allowed = ['reportId', 'reviewerName', 'note', 'expectedProposalToken', ...(action === 'accepted' ? ['observationIndices'] : [])];
  requireValue(object(input) && Object.keys(input).every(key => allowed.includes(key)), 'invalid_review', 'Use only the displayed report review fields.');
  const reportId = reviewText(input.reportId, 'report ID', 160);
  const reviewerName = reviewText(input.reviewerName, 'reviewer name', 120);
  const note = reviewText(input.note, 'review note', 1500);
  requireValue(typeof input.expectedProposalToken === 'string' && /^[a-f0-9]{64}$/.test(input.expectedProposalToken),
    'invalid_review', 'Use the displayed proposal fingerprint.');
  const report = getReport(state, reportId), review = report.modelReview;
  requireValue(['proposal_ready', 'accepted', 'dismissed'].includes(review.status) && object(review.proposal),
    'review_unavailable', 'This report has no completed proposal available for review.', 409);
  const proposal = currentProposal(state, report, input.expectedProposalToken);
  const proposalToken = review.proposalToken;
  if (action === 'accepted' && report.caseId !== null) {
    const references = [...new Set(report.text.toUpperCase().match(/\bC\d+\b/g) || [])];
    requireValue(references.every(reference => reference === report.caseId), 'case_reference_conflict',
      'The original message references a different case. Clarify the case before accepting observations.', 409);
  }
  if (review.reviewDecision) requireValue(review.status === action && review.reviewDecision.action === action,
    'review_conflict', 'A different review decision has already been recorded.', 409);
  const observationIndices = action === 'accepted' ? selectedIndices(input.observationIndices, proposal.observations.length) : [];
  if (action === 'accepted') requireValue(observationIndices.length > 0, 'empty_proposal', 'There are no supported observations to accept. Dismiss or review the original message.');
  const decision = { action, reviewerName, note, observationIndices, proposalToken };
  if (review.reviewDecision) {
    const { reviewedAt, ...previous } = review.reviewDecision;
    requireValue(review.status === action && isDeepStrictEqual(previous, decision), 'review_conflict', 'A different review decision has already been recorded.', 409);
    return { reportId: report.id, caseId: report.caseId, status: action, duplicate: true, observationIds: report.observations.map(observation => observation.id) };
  }
  requireValue(review.status === 'proposal_ready' && Array.isArray(report.observations) && report.observations.length === 0,
    'review_conflict', 'The report already has a recorded review or observations.', 409);
  const item = report.caseId === null ? null : state.cases.find(item => item.id === report.caseId);
  if (action === 'accepted' && item) requireValue(Array.isArray(item.reportIds), 'invalid_case', 'The linked case has invalid report references.', 409);

  // Human acceptance publishes reported source observations only. It performs
  // none of receiveReport's location, assistance, family update or reply effects.
  report.observations = observationIndices.map(index => ({ id: `O-${randomUUID()}`, ...structuredClone(proposal.observations[index]), verification: 'reported' }));
  report.processingState = 'processed';
  report.reviewFlags = report.reviewFlags.filter(flag => flag !== 'model_proposal_needs_review');
  report.reviewFlags.push(action === 'accepted' ? 'model_proposal_accepted' : 'model_proposal_dismissed');
  Object.assign(review, { status: action, reviewDecision: { ...decision, reviewedAt: stamp() }, updatedAt: stamp() });
  if (action === 'accepted' && item && !item.reportIds.includes(report.id)) item.reportIds.push(report.id);
  audit(state, `inbox.proposal_${action}`, report.id,
    `${action === 'accepted' ? `${report.observations.length} reported observations accepted` : 'suggestions dismissed'} by human review; welfare, assistance and outgoing messages unchanged.`);
  return { reportId: report.id, caseId: report.caseId, status: action, duplicate: false, observationIds: report.observations.map(observation => observation.id) };
}

export function acceptReportProposal(state, input = {}) { return reviewProposal(state, input, 'accepted'); }
export function dismissReportProposal(state, input = {}) { return reviewProposal(state, input, 'dismissed'); }

// Only a separate officer action turns an accepted, source-linked water need
// into an assistance task. The case can already be resolved for welfare.
export function trackReportedAssistance(state, input = {}) {
  const allowed = ['reportId', 'observationId', 'reviewerName', 'note'];
  requireValue(object(input) && Object.keys(input).every(key => allowed.includes(key)),
    'invalid_review', 'Use only the displayed assistance tracking fields.');
  const reportId = reviewText(input.reportId, 'report ID', 160);
  const observationId = reviewText(input.observationId, 'observation ID', 160);
  const reviewerName = reviewText(input.reviewerName, 'reviewer name', 120);
  const note = reviewText(input.note, 'tracking note', 1500);
  const report = getReport(state, reportId), review = report.modelReview, decision = review.reviewDecision;
  requireValue(review.status === 'accepted' && decision?.action === 'accepted',
    'review_unavailable', 'Accept the reported water need before tracking assistance.', 409);
  const proposal = currentProposal(state, report, decision.proposalToken);
  const item = state.cases.find(item => item.id === report.caseId);
  requireValue(item && item.reportIds?.includes(reportId), 'invalid_case', 'A linked case is required.', 409);
  const indices = decision.observationIndices;
  requireValue(Array.isArray(indices) && isDeepStrictEqual(indices, selectedIndices(indices, proposal.observations.length)) &&
    Array.isArray(report.observations) && report.observations.length === indices.length,
    'invalid_selection', 'The accepted observation selection has changed.', 409);
  const matches = report.observations.filter(observation => observation.id === observationId);
  requireValue(matches.length === 1, 'invalid_selection', 'Select an accepted water need.');
  const observation = matches[0], position = report.observations.indexOf(observation);
  const expected = proposal.observations[indices[position]];
  requireValue(observation.type === 'water_need' && observation.verification === 'reported' &&
    isDeepStrictEqual(observation, {id: observationId, ...expected, verification: 'reported'}),
    'invalid_selection', 'Only a canonical accepted water need can be tracked.', 409);
  const existing = state.assistance.find(task => task.reportId === reportId && task.caseId === item.id &&
    task.type === 'water_need' && (task.observationId === observationId ||
      (task.observationId == null && task.summary === observation.summary)));
  const result = {reportId, caseId: item.id, observationId};
  if (existing) return {...result, taskId: existing.id, status: existing.status, duplicate: true};

  const task = {id: `T-${randomUUID()}`, caseId: item.id, reportId, observationId, type: 'water_need',
    summary: observation.summary, status: 'unassigned', reviewerName, note, createdAt: stamp()};
  state.assistance.push(task);
  audit(state, 'assistance.tracked', reportId, `${reviewerName} tracked ${observationId} as task ${task.id}.`);
  return {...result, taskId: task.id, status: task.status, duplicate: false};
}

// The caller still owns consent/case/budget authorization. This function has no
// configured/default client and cannot perform work unless explicitly enabled.
// Capture must be called separately first. Every await occurs outside Store.act.
export async function runReportJob(store, { enabled = false, extractor, extractorSource = 'nvidia_nemotron', reportId, timeoutMs = 15000, signal } = {}) {
  requireValue(typeof enabled === 'boolean', 'invalid_configuration', 'Enable job processing explicitly.');
  if (!enabled) return { ran: false, reason: 'disabled' };
  requireValue(typeof store?.act === 'function' && typeof extractor === 'function' && EXTRACTOR_SOURCES.has(extractorSource) && Number.isInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 30000 && (signal === undefined || signal instanceof AbortSignal), 'invalid_configuration', 'Use an injected extractor and bounded timeout.');
  if (signal?.aborted) return { ran: false, reason: 'cancelled' };
  const claim = store.act(claimReportJob, { reportId, leaseMs: timeoutMs + 1000, extractorSource });
  if (!claim.claimed) return { ran: false, status: claim.status, reason: claim.reason, reportId: claim.reportId };
  const controller = new AbortController(); let timer, abort;
  const stopped = new Promise((resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new InboxError('timeout', 'Extraction timed out.')); }, timeoutMs);
    abort = () => { controller.abort(); reject(new InboxError('cancelled', 'Extraction was cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  let proposal, failure;
  try {
    proposal = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new InboxError('cancelled', 'Extraction was cancelled.');
      return extractor(structuredClone(claim.input), { signal: controller.signal });
    }), stopped]);
  } catch (error) { failure = failureCodes.has(error?.code) ? error.code : 'extractor_failed'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  const result = failure ? store.act(failReportJob, { ...claim, code: failure }) : store.act(completeReportJob, { ...claim, proposal });
  return { ran: true, reportId: claim.reportId, status: result.status, completed: result.completed, ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.reason ? { reason: result.reason } : {}) };
}
