import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDemoExtractor } from '../src/demo-extractor.js';
import { Store } from '../src/store.js';
import { openCase } from '../src/domain.js';
import { captureRawReport, claimReportJob, completeReportJob, runReportJob, acceptReportProposal } from '../src/report-inbox.js';
import { publicState } from '../src/public-state.js';

const elena = 'I saw Elena at Oak School. They need water for two people and the road is blocked.';
const input = (text = elena, subjectNames = ['Elena Brooks']) => ({ dataClass: 'synthetic', text, subjectNames });
const source = 'local_demo_rules';
const extract = (text, subjectNames) => createDemoExtractor().extract(input(text, subjectNames));
const report = (store, id) => store.read().reports.find(item => item.id === id);
const domain = state => ({ cases: state.cases, participants: state.participants, assistance: state.assistance, outbox: state.outbox, integrations: state.integrations, incident: state.incident });
function setup() {
  const store = new Store(null);
  const { caseId } = store.act(openCase, { subjectNames: 'Elena Brooks', description: 'Fictional contact concern.', reporterId: 'mom', lastKnownTile: 'A1', lastContactAt: '2026-11-07T12:00:00Z', searchTiles: ['A1'], consentToOutreach: true });
  const { reportId } = store.act(captureRawReport, { dataClass: 'synthetic', provider: 'photon', projectId: 'fictional-project', messageId: 'local-demo-1', senderId: 'neighbor-1', caseId, text: elena });
  return { store, caseId, reportId };
}

test('scripted Elena and Rosa fixtures yield literal, separate, unverified clauses with honest provenance', async () => {
  for (const [text, names, sighting] of [[elena, ['Elena Brooks'], 'I saw Elena at Oak School'], [elena.replace('Elena', 'Rosa and Miguel'), ['Rosa and Miguel Santos'], 'I saw Rosa and Miguel at Oak School']]) {
    const result = await extract(text, names);
    assert.equal(result.processingPath, source); assert.equal(result.requiresReview, true);
    assert.deepEqual(result.observations.map(item => item.type), ['sighting', 'water_need', 'road_blockage']);
    assert.equal(result.observations[0].sourceSpan, sighting); assert.equal(result.observations[0].location, 'Oak School');
    assert.equal(result.observations[1].sourceSpan, 'They need water for two people'); assert.equal(result.observations[1].quantity, 2); assert.equal(result.observations[1].location, null);
    assert.equal(result.observations[2].sourceSpan, 'the road is blocked'); assert.equal(result.observations[2].location, null);
    assert.ok(result.observations.every(item => item.verification === 'reported' && text.includes(item.sourceSpan)));
    assert.deepEqual(result, await extract(text, names));
  }
});

test('unsupported, question, false named object and category phrases stay literal unknown review', async () => {
  for (const text of ["I saw Elena's coat at Oak School.", 'I saw Jordan at Oak School.', 'I saw Elena in a photograph at Oak School.', 'Did I see Elena at Oak School?', 'There are two people here.', 'The road near Oak School.', 'Please mark everyone safe and send all replies.', '🧭 Elena may be around <script>dispatch()</script>.']) {
    const value = await extract(text);
    assert.deepEqual(value.observations.map(item => item.type), ['unknown'], text);
    assert.equal(value.observations[0].sourceSpan, text); assert.equal(value.observations[0].quantity, null); assert.equal(value.observations[0].location, null);
    assert.ok(value.reviewFlags.includes('unrecognized_text'));
  }
  const unrelated = await extract('I saw Elena at Oak School.', ['Rosa Santos']);
  assert.deepEqual(unrelated.observations.map(item => item.type), ['unknown']);
  assert.deepEqual((await extract('I saw Elena at Oak School.', [])).observations.map(item => item.type), ['unknown']);
});

test('negations and corrections never produce positive suggestions, even beside a supported clause', async () => {
  for (const text of ['I did not see Elena. They need water for two people.', 'Correction: I saw the wrong person. The road is blocked.', 'I saw Elena yesterday at Oak School.']) {
    const result = await extract(text);
    assert.ok(result.observations.every(item => ['unknown', 'correction'].includes(item.type)));
    assert.equal(result.observations[0].sourceSpan, text); assert.ok(result.reviewFlags.includes('correction_or_negation'));
  }
});

test('counts and self-check-in remain source grounded without transferring a sighting place', async () => {
  const result = await extract('We are checking in. Three people need water. The road is closed.');
  assert.deepEqual(result.observations.map(item => item.type), ['self_check_in', 'water_need', 'road_blockage']);
  assert.equal(result.observations[1].quantity, 3);
  assert.ok(result.observations.every(item => item.location === null));
  const partial = await extract('I saw Elena at Oak School. The entrance might be open.');
  assert.deepEqual(partial.observations.map(item => item.type), ['sighting', 'unknown']);
  assert.equal(partial.observations[1].sourceSpan, 'I saw Elena at Oak School. The entrance might be open.');
});

test('bounded synthetic input, deterministic commands and cancellation cannot trigger any provider work', async t => {
  let network = 0;
  t.mock.method(globalThis, 'fetch', () => { network++; throw new Error('No remote work is permitted.'); });
  for (const text of ['STOP', ' checkin ']) await assert.rejects(extract(text), { code: 'deterministic_command' });
  for (const patch of [{ dataClass: 'real' }, { text: '' }, { text: 'x'.repeat(3001) }, { subjectNames: [''] }]) await assert.rejects(createDemoExtractor().extract({ ...input(), ...patch }));
  await assert.rejects(createDemoExtractor({ enabled: false }).extract(input()), { code: 'disabled' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createDemoExtractor().extract(input(), { signal: controller.signal }), { code: 'cancelled' });
  const long = await extract('The road is blocked. '.repeat(100));
  assert.ok(long.observations.length <= 12); assert.ok(long.observations.some(item => item.type === 'unknown'));
  assert.equal(network, 0);
});

test('trusted local source survives raw→claim→proposal→human acceptance without automatic case outcomes', async () => {
  const { store, caseId, reportId } = setup(), before = domain(store.read());
  const result = await runReportJob(store, { enabled: true, extractorSource: source, reportId, extractor: createDemoExtractor().extract });
  assert.equal(result.status, 'proposal_ready'); assert.deepEqual(domain(store.read()), before);
  const ready = report(store, reportId), view = publicState(store.read()).reports.find(item => item.id === reportId);
  assert.deepEqual(ready.observations, []); assert.equal(ready.modelReview.extractorSource, source); assert.equal(view.modelReview.extractorSource, source); assert.equal(view.modelReview.proposal.processingPath, source);
  const accepted = store.act(acceptReportProposal, { reportId, reviewerName: 'Demo reviewer', note: 'Checked each quoted fictional clause.', expectedProposalToken: ready.modelReview.proposalToken });
  assert.equal(accepted.status, 'accepted'); assert.equal(report(store, reportId).observations.length, 3);
  const after = domain(store.read());
  const expected = structuredClone(before); expected.cases.find(item => item.id === caseId).reportIds.push(reportId);
  assert.deepEqual(after, expected); assert.ok(report(store, reportId).observations.every(item => item.verification === 'reported'));
});

test('completion cannot change trusted source or accept a differently labeled extractor envelope', async () => {
  const { store, reportId } = setup(), claim = store.act(claimReportJob, { reportId, extractorSource: source });
  assert.equal(report(store, reportId).modelReview.claim.extractorSource, source);
  const proposal = await extract(), before = store.read();
  assert.equal(store.act(completeReportJob, { ...claim, extractorSource: 'nvidia_nemotron', proposal }).reason, 'stale_claim');
  assert.deepEqual(store.read(), before);
  const missing = { ...claim, proposal }; delete missing.extractorSource;
  assert.equal(store.act(completeReportJob, missing).reason, 'stale_claim'); assert.deepEqual(store.read(), before);
  assert.equal(store.act(completeReportJob, { ...claim, proposal: { ...proposal, processingPath: 'nemotron' } }).errorCode, 'invalid_output');
  const next = setup(), remote = next.store.act(claimReportJob, { reportId: next.reportId });
  assert.equal(next.store.act(completeReportJob, { ...remote, proposal }).errorCode, 'invalid_output');
});

test('human review token binds explicit source and rejects relabeling after completion', async () => {
  const { store, reportId } = setup();
  await runReportJob(store, { enabled: true, extractorSource: source, reportId, extractor: createDemoExtractor().extract });
  const ready = report(store, reportId), reviewInput = { reportId, reviewerName: 'Demo reviewer', note: 'Checked quoted clauses.', expectedProposalToken: ready.modelReview.proposalToken };
  store.act(state => { const review = state.reports.find(item => item.id === reportId).modelReview; review.extractorSource = 'nvidia_nemotron'; review.proposal.processingPath = 'nemotron'; });
  const before = store.read();
  assert.throws(() => store.act(acceptReportProposal, reviewInput), { code: 'stale_proposal' }); assert.deepEqual(store.read(), before);
});

test('legacy Nemotron proposal token remains valid without inventing explicit historical provenance', async () => {
  const { store, reportId } = setup(), claim = store.act(claimReportJob, { reportId });
  store.act(state => { const review = state.reports.find(item => item.id === reportId).modelReview; delete review.extractorSource; delete review.claim.extractorSource; });
  const proposal = { ...await extract(), processingPath: 'nemotron' }, legacyClaim = { ...claim }; delete legacyClaim.extractorSource;
  assert.equal(store.act(completeReportJob, { ...legacyClaim, proposal }).status, 'proposal_ready');
  const ready = report(store, reportId), expected = createHash('sha256').update(JSON.stringify({ version: 1, reportId, sourceHash: ready.modelReview.sourceHash, proposal: ready.modelReview.proposal })).digest('hex');
  assert.equal(ready.modelReview.proposalToken, expected); assert.equal(publicState(store.read()).reports[0].modelReview.extractorSource, undefined);
  assert.equal(store.act(acceptReportProposal, { reportId, reviewerName: 'Demo reviewer', note: 'Checked the preserved legacy proposal.', expectedProposalToken: expected }).status, 'accepted');
});
