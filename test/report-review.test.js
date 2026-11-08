import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { openCase, verifyCase, receiveReport } from '../src/domain.js';
import { captureRawReport, claimReportJob, completeReportJob, failReportJob, acceptReportProposal, dismissReportProposal } from '../src/report-inbox.js';

const text = 'I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.';
const proposal = { observations: [
  { type: 'sighting', sourceSpan: 'I saw Rosa and Miguel at Oak School', quantity: null, location: 'Oak School' },
  { type: 'water_need', sourceSpan: 'They need water for two people', quantity: 2, location: null },
], reviewFlags: [] };
const captureInput = (caseId, patch = {}) => ({ dataClass: 'synthetic', provider: 'photon', projectId: 'fictional-project', messageId: 'message-1', senderId: 'neighbor-1', caseId, text, ...patch });
function setup(path = null) {
  const store = new Store(path);
  const { caseId } = store.act(openCase, { subjectNames: 'Rosa and Miguel Santos', description: 'Fictional grandparents inquiry.', reporterId: 'mom', lastKnownTile: 'A1', lastContactAt: '2026-11-07T12:00:00Z', searchTiles: ['A1'], consentToOutreach: true });
  return { store, caseId };
}
function raw(store, reportId) { return store.read().reports.find(report => report.id === reportId); }
function ready(store, caseId, { input = {}, suggested = proposal } = {}) {
  const { reportId } = store.act(captureRawReport, captureInput(caseId, input));
  const claim = store.act(claimReportJob, { reportId });
  const result = store.act(completeReportJob, { ...claim, proposal: structuredClone(suggested) });
  assert.equal(result.status, 'proposal_ready');
  return reportId;
}
function reviewInput(store, reportId, patch = {}) {
  return { reportId, reviewerName: 'Reviewer Demo', note: 'The selected quotes match this fictional source report.', expectedProposalToken: raw(store, reportId).modelReview.proposalToken, ...patch };
}
function rejectedUnchanged(store, action, input, expected) {
  const before = store.read();
  assert.throws(() => store.act(action, input), expected); assert.deepEqual(store.read(), before);
}
function noAutomaticEffects(before, after, reportId, caseId = null) {
  const expectedCases = structuredClone(before.cases);
  if (caseId) {
    const item = expectedCases.find(item => item.id === caseId);
    if (!item.reportIds.includes(reportId)) item.reportIds.push(reportId);
  }
  assert.deepEqual(after.cases, expectedCases);
  for (const field of ['participants', 'assistance', 'outbox', 'integrations', 'incident']) assert.deepEqual(after[field], before[field], field);
}

test('human acceptance publishes canonical reported observations with server IDs and only one case link', () => {
  const { store, caseId } = setup(), reportId = ready(store, caseId), before = store.read(), source = raw(store, reportId);
  const input = reviewInput(store, reportId), originalInput = structuredClone(input);
  assert.match(source.modelReview.proposalToken, /^[a-f0-9]{64}$/);
  assert.equal(source.modelReview.proposalToken,createHash('sha256').update(JSON.stringify({version:1,reportId,sourceHash:source.modelReview.sourceHash,extractorSource:'nvidia_nemotron',proposal:source.modelReview.proposal})).digest('hex'));
  assert.notEqual(source.modelReview.proposalToken, source.modelReview.sourceHash);
  assert.deepEqual(source.observations, []);
  const result = store.act(acceptReportProposal, input), report = raw(store, reportId);
  assert.equal(result.status, 'accepted'); assert.equal(result.duplicate, false); assert.equal(report.processingState, 'processed');
  assert.equal(report.processingPath, 'raw_inbox'); assert.equal(report.modelReview.status, 'accepted');
  assert.equal(report.text, source.text); assert.equal(report.observedAt, source.observedAt); assert.equal(report.receivedAt, source.receivedAt);
  assert.deepEqual(report.modelReview.proposal, source.modelReview.proposal);
  assert.deepEqual(report.observations.map(({ id, ...observation }) => observation), source.modelReview.proposal.observations);
  assert.ok(report.observations.every(observation => /^O-[a-f0-9-]{36}$/.test(observation.id) && observation.verification === 'reported'));
  assert.equal(new Set(report.observations.map(observation => observation.id)).size, 2);
  assert.deepEqual(result.observationIds, report.observations.map(observation => observation.id));
  assert.equal(report.modelReview.reviewDecision.proposalToken, source.modelReview.proposalToken);
  assert.equal(report.modelReview.reviewDecision.reviewerName, input.reviewerName);
  assert.deepEqual(report.modelReview.reviewDecision.observationIndices, [0, 1]);
  assert.ok(Number.isFinite(Date.parse(report.modelReview.reviewDecision.reviewedAt)));
  assert.deepEqual(input, originalInput); noAutomaticEffects(before, store.read(), reportId, caseId);
});

test('selected acceptance is explicit, normalized and cannot create assistance or verify welfare from a water need', () => {
  const { store, caseId } = setup(), reportId = ready(store, caseId), before = store.read();
  const input = reviewInput(store, reportId, { observationIndices: Object.freeze([1, 1]) }); Object.freeze(input);
  store.act(acceptReportProposal, input); const report = raw(store, reportId);
  assert.deepEqual(report.modelReview.reviewDecision.observationIndices, [1]);
  assert.deepEqual(report.observations.map(observation => observation.type), ['water_need']); noAutomaticEffects(before, store.read(), reportId, caseId);
  const state = store.read();
  assert.throws(() => store.act(verifyCase, caseId, { officerName: 'Officer Demo', note: 'Direct fictional confirmation is still required.', welfare: 'confirmed_safe', resolve: true, evidenceIds: [reportId] }));
  assert.deepEqual(store.read(), state);
});

test('accepted sighting remains unverified until the existing separate officer action', () => {
  const { store, caseId } = setup(), reportId = ready(store, caseId);
  store.act(acceptReportProposal, reviewInput(store, reportId));
  assert.equal(store.read().cases.find(item => item.id === caseId).welfareState, 'unknown');
  assert.equal(store.read().cases.find(item => item.id === caseId).locationState, 'unknown');
  store.act(verifyCase, caseId, { officerName: 'Officer Demo', note: 'Direct fictional responder contact confirmed Rosa and Miguel at Oak School.', welfare: 'confirmed_safe', resolve: true, evidenceIds: [reportId] });
  assert.equal(store.read().cases.find(item => item.id === caseId).welfareState, 'confirmed_safe');
  assert.equal(store.read().cases.find(item => item.id === caseId).reviewState, 'resolved');
});

test('dismissal retains raw/proposed content, records review and leaves all family facts unchanged', () => {
  const { store, caseId } = setup(), reportId = ready(store, caseId), before = store.read(), original = raw(store, reportId);
  const result = store.act(dismissReportProposal, reviewInput(store, reportId));
  const report = raw(store, reportId);
  assert.equal(result.status, 'dismissed'); assert.deepEqual(result.observationIds, []);
  assert.deepEqual(report.observations, []); assert.equal(report.text, original.text);
  assert.deepEqual(report.modelReview.proposal, original.modelReview.proposal); assert.equal(report.modelReview.reviewDecision.action, 'dismissed');
  noAutomaticEffects(before, store.read(), reportId);
  rejectedUnchanged(store, acceptReportProposal, reviewInput(store, reportId), { code: 'review_conflict', status: 409 });
});

test('exact normalized decisions replay across persistence with stable IDs; conflicting decisions are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-human-review-'));
  try {
    for (const action of [acceptReportProposal, dismissReportProposal]) {
      const path = join(dir, `${action.name}.json`), { store, caseId } = setup(path), reportId = ready(store, caseId);
      const input = reviewInput(store, reportId), first = store.act(action, input), before = store.read();
      const restarted = new Store(path);
      const repeat = restarted.act(action, { ...input, reviewerName: ' Reviewer Demo ', note: ` ${input.note} `,
        ...(action === acceptReportProposal ? { observationIndices: [1, 0, 0] } : {}) });
      assert.equal(repeat.duplicate, true); assert.deepEqual(repeat.observationIds, first.observationIds);
      assert.deepEqual(restarted.read(), before); assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before);
      for (const patch of [{ reviewerName: 'Different reviewer' }, { note: 'A different decision note.' }, { expectedProposalToken: 'a'.repeat(64) },
        ...(action === acceptReportProposal ? [{ observationIndices: [1] }] : [])]) rejectedUnchanged(restarted, action, { ...input, ...patch }, { status: 409 });
      rejectedUnchanged(restarted, action === acceptReportProposal ? dismissReportProposal : acceptReportProposal, input, { code: 'review_conflict', status: 409 });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changed raw source, case subjects, sender scope or source snapshot reject review without hidden mutation', () => {
  for (const field of ['text', 'observedAt', 'caseId', 'subjectNames', 'senderId', 'providerIdentity', 'sourceSnapshot', 'caseRemoved', 'fixtureScope', 'mode']) {
    for (const action of [acceptReportProposal, dismissReportProposal]) {
      const { store, caseId } = setup(), reportId = ready(store, caseId), input = reviewInput(store, reportId);
      store.act(state => {
        const report = state.reports.find(report => report.id === reportId);
        if (field === 'subjectNames') state.cases.find(item => item.id === caseId).subjectNames = 'Elena Brooks';
        else if (field === 'caseRemoved') state.cases = state.cases.filter(item => item.id !== caseId);
        else if (field === 'fixtureScope') state.participants.find(item => item.id === 'neighbor-1').source = 'real';
        else if (field === 'mode') state.mode = 'live';
        else if (field === 'providerIdentity') report.providerIdentity.messageId = 'different-message';
        else if (field === 'sourceSnapshot') report.modelReview.source.text = 'Changed source snapshot';
        else report[field] = { text: 'Correction: I did not see Rosa and Miguel.', observedAt: '2026-11-07T12:00:00Z', caseId: 'C104', senderId: 'neighbor-2' }[field];
      });
      rejectedUnchanged(store, action, input, { code: 'source_changed', status: 409 });
    }
  }
});

test('displayed proposal content is revalidated, including canonical summaries, negation and false authority', () => {
  for (const field of ['summary', 'span', 'verification', 'quantity', 'type', 'authority']) {
    const { store, caseId } = setup(), reportId = ready(store, caseId), input = reviewInput(store, reportId);
    store.act(state => {
      const proposed = state.reports.find(report => report.id === reportId).modelReview.proposal;
      if (field === 'authority') proposed.requiresReview = false;
      else if (field === 'summary') proposed.observations[0].summary = 'Identity and safety verified.';
      else if (field === 'span') proposed.observations[0].sourceSpan = 'The subjects were not seen here.';
      else if (field === 'verification') proposed.observations[0].verification = 'verified';
      else if (field === 'quantity') proposed.observations[1].quantity = 50;
      else proposed.observations[0].type = 'confirmed_safe';
    });
    rejectedUnchanged(store, acceptReportProposal, input, { code: 'invalid_proposal', status: 409 });
  }
  const { store, caseId } = setup();
  const reportId = ready(store, caseId, { input: { text: 'Correction: I did not see Rosa and Miguel.' }, suggested: { observations: [{ type: 'correction', sourceSpan: 'Correction: I did not see Rosa and Miguel', quantity: null, location: null }], reviewFlags: ['correction_or_negation'] } });
  const before = store.read(); store.act(acceptReportProposal, reviewInput(store, reportId));
  assert.deepEqual(raw(store, reportId).observations.map(observation => observation.type), ['correction']);
  noAutomaticEffects(before, store.read(), reportId, caseId);
});

test('tokens bind the exact report/case proposal and cannot be swapped or fabricated from private job credentials', () => {
  const { store, caseId } = setup(), first = ready(store, caseId);
  const second = ready(store, 'C104', { input: { messageId: 'second', text: 'I saw Elena at Oak School.' }, suggested: { observations: [{ type: 'sighting', sourceSpan: 'I saw Elena at Oak School', quantity: null, location: 'Oak School' }], reviewFlags: [] } });
  assert.notEqual(raw(store, first).modelReview.proposalToken, raw(store, second).modelReview.proposalToken);
  rejectedUnchanged(store, acceptReportProposal, reviewInput(store, second, { expectedProposalToken: raw(store, first).modelReview.proposalToken }), { code: 'stale_proposal', status: 409 });
  rejectedUnchanged(store, acceptReportProposal, reviewInput(store, first, { expectedProposalToken: raw(store, first).modelReview.sourceHash }), { code: 'stale_proposal', status: 409 });
  rejectedUnchanged(store, acceptReportProposal, reviewInput(store, first, { caseId: 'C104' }), { code: 'invalid_review' });
  const oldInput=reviewInput(store,first);
  store.act(state=>{state.reports.find(report=>report.id===first).modelReview.proposal.observations.pop();});
  rejectedUnchanged(store,acceptReportProposal,oldInput,{code:'stale_proposal',status:409});
});

test('literal conflicting case references cannot link accepted facts to another case, while dismissal remains available',()=>{
  const {store,caseId}=setup();
  const reportId=ready(store,caseId,{input:{text:`${text} Follow up for C104.`}});
  rejectedUnchanged(store,acceptReportProposal,reviewInput(store,reportId),{code:'case_reference_conflict',status:409});
  assert.equal(store.act(dismissReportProposal,reviewInput(store,reportId)).status,'dismissed');
  const matching=ready(store,caseId,{input:{messageId:'matching-case',text:`${text} Follow up for ${caseId}.`}});
  assert.equal(store.act(acceptReportProposal,reviewInput(store,matching)).status,'accepted');
});

test('empty proposals may be dismissed but not accepted; invalid or injected selection/review fields are rejected', () => {
  const { store, caseId } = setup(), reportId = ready(store, caseId);
  for (const patch of [{ observationIndices: [] }, { observationIndices: [-1] }, { observationIndices: [2] }, { observationIndices: ['0'] }, { observationIndices: [0.5] }, { observationIndices: null },
    { reviewerName: '' }, { reviewerName: 'x'.repeat(121) }, { note: ' ' }, { note: 'x'.repeat(1501) }, { expectedProposalToken: undefined }, { observations: proposal.observations }, { claimToken: 'job-token' }]) {
    rejectedUnchanged(store, acceptReportProposal, reviewInput(store, reportId, patch));
  }
  rejectedUnchanged(store, dismissReportProposal, reviewInput(store, reportId, { observationIndices: [0] }));
  const empty = ready(store, caseId, { input: { messageId: 'empty', text: 'An unclear fictional message.' }, suggested: { observations: [], reviewFlags: ['unrecognized_text'] } });
  rejectedUnchanged(store, acceptReportProposal, reviewInput(store, empty), { code: 'empty_proposal' });
  assert.equal(store.act(dismissReportProposal, reviewInput(store, empty)).status, 'dismissed');
});

test('commands and unfinished/failed/stale jobs cannot be accepted; reset and legacy reports cannot be replayed', () => {
  const { store, caseId } = setup();
  for (const command of ['STOP', 'CHECKIN']) {
    const { reportId } = store.act(captureRawReport, captureInput(caseId, { messageId: command, text: command }));
    rejectedUnchanged(store, acceptReportProposal, reviewInput(store, reportId, { expectedProposalToken: 'a'.repeat(64) }), { code: 'review_unavailable', status: 409 });
  }
  for (const status of ['queued', 'running', 'failed', 'stale']) {
    const { reportId } = store.act(captureRawReport, captureInput(caseId, { messageId: status }));
    if (status !== 'queued') {
      const claim = store.act(claimReportJob, { reportId });
      if (status === 'failed') store.act(failReportJob, { ...claim, code: 'timeout' });
      if (status === 'stale') store.act(state => { state.reports.find(report => report.id === reportId).modelReview.status = 'stale'; });
    }
    rejectedUnchanged(store, acceptReportProposal, reviewInput(store, reportId, { expectedProposalToken: 'a'.repeat(64) }), { code: 'review_unavailable', status: 409 });
  }
  const { reportId: legacy } = store.act(receiveReport, { caseId, providerEventId: 'legacy', senderId: 'neighbor-1', text, observedAt: null });
  rejectedUnchanged(store, acceptReportProposal, { reportId: legacy, reviewerName: 'Demo', note: 'Legacy input.', expectedProposalToken: 'a'.repeat(64) }, { code: 'not_found', status: 404 });
  const readyId = ready(store, caseId, { input: { messageId: 'reset' } }), review = reviewInput(store, readyId); store.reset();
  rejectedUnchanged(store, acceptReportProposal, review, { code: 'not_found', status: 404 });
});

test('unassigned/previously linked or resolved cases keep their facts while acceptance records only the intended link', () => {
  const { store, caseId } = setup();
  const reportId = ready(store, caseId);
  store.act(state => { const item = state.cases.find(item => item.id === caseId); item.reportIds.push(reportId); item.reviewState = 'resolved'; item.welfareState = 'confirmed_safe'; item.outreachState = 'stopped'; });
  const before = store.read(); store.act(acceptReportProposal, reviewInput(store, reportId)); noAutomaticEffects(before, store.read(), reportId, caseId);
  assert.equal(store.read().cases.find(item => item.id === caseId).reportIds.filter(id => id === reportId).length, 1);
  const unassigned = ready(store, null, { input: { messageId: 'unassigned', text: 'They need water for two people.' }, suggested: { observations: [proposal.observations[1]], reviewFlags: ['case_needs_clarification'] } });
  const unassignedBefore = store.read(); store.act(acceptReportProposal, reviewInput(store, unassigned));
  assert.equal(raw(store, unassigned).caseId, null); noAutomaticEffects(unassignedBefore, store.read(), unassigned);
});

test('a failed acceptance save leaves original observations, decisions, links and notifications unchanged', () => {
  const { store, caseId } = setup(), reportId = ready(store, caseId), input = reviewInput(store, reportId), before = store.read();
  let events = 0; store.onChange(() => events++); const revision = store.version.revision;
  store.save = () => { throw new Error('Synthetic persistence failure'); };
  rejectedUnchanged(store, acceptReportProposal, input, /Synthetic persistence failure/);
  assert.equal(events, 0); assert.equal(store.version.revision, revision); assert.deepEqual(store.read(), before);
});
