import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/domain.js';
import { publicState } from '../src/public-state.js';

test('public projection preserves the existing fixture API and returns independent objects', () => {
  const state = createSeed(), view = publicState(state);
  assert.deepEqual(view, state);
  assert.equal(view.participants[0].phone, '+12125550100');
  view.participants[0].name = 'Changed only in caller';
  assert.notEqual(state.participants[0].name, view.participants[0].name);
});

test('public proposals allow only review status and canonical proposal fields, never job/identity metadata', () => {
  const state = createSeed();
  const proposal = {
    observations: [{ type: 'sighting', summary: 'Reported observation.', sourceSpan: 'I saw Elena at the gate.', quantity: null, location: 'the gate', verification: 'reported', providerIdentity: { handle: 'private-observation-handle' }, claimToken: 'private-observation-token' }],
    reviewFlags: ['model_output_needs_review'], processingPath: 'nemotron', requiresReview: true,
    debug: 'private-proposal-debug', sourceHash: 'private-proposal-hash',
  };
  state.reports.push({ id: 'R-raw', senderId: 'neighbor-1', text: 'I saw Elena at the gate.', observations: [], providerEventId: 'inbox:opaque-hash', providerIdentity: { handle: 'private-real-handle', projectId: 'private-project' }, modelReview: {
    status: 'proposal_ready', proposal, claim: { token: 'private-lease' }, claimToken: 'private-token', sourceHash: 'private-source-hash', payloadHash: 'private-payload',
    source: { text: 'private-duplicate-source', providerIdentity: { handle: 'private-nested-handle' } }, sourceSnapshot: { token: 'private-snapshot' }, errorCode: 'private-error', attempts: 2,
  } });
  state.claimToken = 'private-top-token'; state.sourceSnapshot = { handle: 'private-top-handle' };
  const before = structuredClone(state), view = publicState({ ...state, reportId: 'R-raw', duplicate: false });
  assert.deepEqual(Object.keys(view.reports[0].modelReview), ['status', 'proposal']);
  assert.deepEqual(Object.keys(view.reports[0].modelReview.proposal), ['observations', 'reviewFlags', 'processingPath', 'requiresReview']);
  assert.equal(view.reports[0].modelReview.proposal.requiresReview, true);
  assert.equal(view.reports[0].modelReview.proposal.observations[0].sourceSpan, state.reports[0].text);
  assert.deepEqual(view.reports[0].observations, []); assert.equal(view.reportId, 'R-raw'); assert.equal(view.duplicate, false);
  assert.doesNotMatch(JSON.stringify(view), /private-|providerIdentity|claimToken|sourceHash|sourceSnapshot/);
  assert.deepEqual(state, before);
  view.reports[0].modelReview.proposal.observations[0].summary = 'Caller mutation';
  assert.equal(state.reports[0].modelReview.proposal.observations[0].summary, 'Reported observation.');
});

test('missing/unvalidated proposal envelopes remain unavailable rather than asserting authority', () => {
  for (const proposal of [null, {}, { observations: [], reviewFlags: [], processingPath: 'nemotron', requiresReview: false }, { observations: [], reviewFlags: [], processingPath: 'trusted', requiresReview: true }]) {
    const result = publicState({ reports: [{ modelReview: { status: 'running', proposal, claim: { token: 'secret' } } }] });
    assert.deepEqual(result.reports[0].modelReview, { status: 'running', proposal: null });
  }
});
