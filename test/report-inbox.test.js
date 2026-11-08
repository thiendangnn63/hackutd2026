import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { openCase, verifyCase } from '../src/domain.js';
import { validateExtraction } from '../src/nemotron-client.js';
import { caseEvents, peopleIndex, incomingReportKind } from '../public/records.js';
import { canonicalProviderIdentity, captureRawReport, claimReportJob, completeReportJob, failReportJob, runReportJob } from '../src/report-inbox.js';

const text = 'I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.';
const proposal = { observations: [{ type: 'sighting', sourceSpan: 'I saw Rosa and Miguel at Oak School', quantity: null, location: 'Oak School' }, { type: 'water_need', sourceSpan: 'They need water for two people', quantity: 2, location: null }], reviewFlags: [] };
const input = (patch = {}) => ({ dataClass: 'synthetic', provider: 'photon', projectId: 'fictional-project', messageId: 'message-1', senderId: 'neighbor-1', text, ...patch });
function setup(path = null) {
  const store = new Store(path);
  const { caseId } = store.act(openCase, { subjectNames: 'Rosa and Miguel Santos', description: 'Fictional grandparents inquiry.', reporterId: 'mom', lastKnownTile: 'A1', lastContactAt: '2026-11-07T12:00:00Z', searchTiles: ['A1'], consentToOutreach: true });
  return { store, caseId };
}
const domain = state => ({ cases: state.cases, participants: state.participants, assistance: state.assistance, outbox: state.outbox, integrations: state.integrations, incident: state.incident });
const raw = (store, reportId) => store.read().reports.find(report => report.id === reportId);
function unchanged(store, action) { const before = store.read(); assert.throws(action); assert.deepEqual(store.read(), before); }
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('provider tuple canonicalization is bounded and separator-safe', () => {
  assert.deepEqual(canonicalProviderIdentity({ provider: ' PHOTON ', projectId: ' project-A ', messageId: ' message-A ' }), { provider: 'photon', projectId: 'project-A', messageId: 'message-A' });
  const { store } = setup();
  const first = store.act(captureRawReport, input({ projectId: 'a:b', messageId: 'c' }));
  const second = store.act(captureRawReport, input({ projectId: 'a', messageId: 'b:c' }));
  const third = store.act(captureRawReport, input({ provider: 'other' }));
  assert.notEqual(first.reportId, second.reportId); assert.notEqual(first.reportId, third.reportId);
  for (const patch of [{ provider: 'https://provider' }, { projectId: '' }, { messageId: 'bad\nidentity' }, { messageId: 'x'.repeat(161) }]) unchanged(store, () => store.act(captureRawReport, input(patch)));
});

test('capture requires synthetic declaration, known fictional alias and explicit known case only', () => {
  const { store } = setup();
  for (const patch of [{ dataClass: undefined }, { dataClass: 'real' }, { senderId: '+12125550101' }, { senderId: 'missing' }, { caseId: 'C999' }, { text: '' }, { text: ' '.repeat(3) }, { text: 'x'.repeat(3001) }, { observedAt: '2026-02-30T12:00:00Z' }, { observedAt: '2026-11-07T12:00' }, { observedAt: '2026-11-08T12:00:00Z' }]) unchanged(store, () => store.act(captureRawReport, input(patch)));
  const before = domain(store.read());
  const { reportId } = store.act(captureRawReport, input({ text: 'C104: I saw Elena at the gate.', observedAt: '' }));
  const report = raw(store, reportId);
  assert.equal(report.caseId, null); assert.equal(report.observedAt, null); assert.equal(report.modelReview.source.subjectNames.length, 0);
  assert.deepEqual(domain(store.read()), before);
  assert.equal(caseEvents(store.read(), 'unassigned')[0].id, reportId);
  assert.ok(peopleIndex(store.read()).find(person => person.participantId === 'neighbor-1'));
});

test('raw text, explicit case and receipt persist before work without modifying family state', () => {
  const { store, caseId } = setup(), before = domain(store.read()), source = `  ${text}\n`;
  const result = store.act(captureRawReport, input({ caseId, text: source, observedAt: '2026-11-07T06:00:00-06:00' }));
  const report = raw(store, result.reportId);
  assert.equal(result.status, 'queued'); assert.equal(result.duplicate, false);
  assert.equal(report.text, source); assert.equal(report.observedAt, '2026-11-07T12:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(report.receivedAt))); assert.equal(report.processingState, 'needs_review');
  assert.deepEqual(report.observations, []); assert.equal(report.modelReview.sourceHash.length, 64);
  assert.deepEqual(domain(store.read()), before);
  assert.equal(caseEvents(store.read(), caseId)[0].id, result.reportId);
});

test('same canonical provider identity deduplicates across restart and changed payload conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-inbox-'));
  try {
    const path = join(dir, 'state.json'), { store, caseId } = setup(path);
    const captured = store.act(captureRawReport, input({ caseId }));
    const restarted = new Store(path), before = restarted.read();
    const duplicate = restarted.act(captureRawReport, input({ provider: ' PHOTON ', caseId }));
    assert.equal(duplicate.reportId, captured.reportId); assert.equal(duplicate.duplicate, true);
    assert.deepEqual(restarted.read(), before);
    for (const patch of [{ text: 'Different retry text' }, { senderId: 'neighbor-2' }, { caseId: undefined }, { observedAt: '2026-11-07T12:00:00Z' }]) unchanged(restarted, () => restarted.act(captureRawReport, input({ caseId, ...patch })));
    const differentProject = restarted.act(captureRawReport, input({ caseId, projectId: 'another-project' }));
    assert.notEqual(differentProject.reportId, captured.reportId);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reports.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('STOP deterministically revokes alias consent once without reply, extraction or case effects', async () => {
  const { store, caseId } = setup(), before = domain(store.read());
  const captured = store.act(captureRawReport, input({ caseId, text: ' STOP ' }));
  const state = store.read(), report = raw(store, captured.reportId);
  const expected = structuredClone(before); expected.participants.find(person => person.id === 'neighbor-1').optedIn = false;
  assert.deepEqual(domain(state), expected); assert.equal(captured.status, 'command_processed');
  assert.equal(report.processingPath, 'deterministic'); assert.equal(incomingReportKind(report), 'Opt-out command');
  let calls = 0;
  const result = await runReportJob(store, { enabled: true, reportId: report.id, extractor: () => { calls++; } });
  assert.deepEqual(result, { ran: false, status: 'command_processed', reason: 'command_processed', reportId: report.id });
  assert.equal(calls, 0);
  const after = store.read(); store.act(captureRawReport, input({ caseId, text: ' STOP ' })); assert.deepEqual(store.read(), after);
});

test('CHECKIN never reenrolls, verifies, replies or invokes a model', async () => {
  const { store } = setup(); store.act(state => { state.participants.find(person => person.id === 'neighbor-1').optedIn = false; });
  const before = domain(store.read()), captured = store.act(captureRawReport, input({ text: 'checkin' }));
  const report = raw(store, captured.reportId); assert.equal(captured.status, 'command_review');
  assert.equal(report.processingPath, 'deterministic'); assert.equal(incomingReportKind(report), 'Enrollment request');
  let calls = 0; const result = await runReportJob(store, { enabled: true, reportId: report.id, extractor: () => { calls++; } });
  assert.equal(result.ran, false); assert.equal(result.reason, 'command_review'); assert.equal(calls, 0);
  assert.deepEqual(domain(store.read()), before);
});

test('inactive/default and invalid runners make no calls and claim no work', async () => {
  const { store } = setup(); store.act(captureRawReport, input()); const before = store.read(); let calls = 0;
  const extractor = () => { calls++; throw new Error('never'); };
  assert.deepEqual(await runReportJob(store, { extractor }), { ran: false, reason: 'disabled' });
  for (const options of [{ enabled: 'true', extractor }, { enabled: true }, { enabled: true, extractor, timeoutMs: 0 }, { enabled: true, extractor, signal: {} }]) await assert.rejects(runReportJob(store, options), { code: 'invalid_configuration' });
  const controller = new AbortController(); controller.abort();
  assert.equal((await runReportJob(store, { enabled: true, extractor, signal: controller.signal })).reason, 'cancelled');
  assert.equal(calls, 0); assert.deepEqual(store.read(), before);
});

test('extractor is awaited outside act only after claim/raw save, and proposal never becomes evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-inbox-durable-'));
  try {
    const path = join(dir, 'state.json'), { store, caseId } = setup(path), before = domain(store.read());
    const { reportId } = store.act(captureRawReport, input({ caseId }));
    const act = store.act.bind(store); let insideAct = false, calls = 0;
    store.act = (...args) => { insideAct = true; try { return act(...args); } finally { insideAct = false; } };
    const result = await runReportJob(store, { enabled: true, reportId, extractor: async (value, { signal }) => {
      calls++; assert.equal(insideAct, false); assert.equal(signal.aborted, false);
      const persisted = new Store(path).read().reports.find(report => report.id === reportId);
      assert.equal(persisted.text, text); assert.equal(persisted.modelReview.status, 'running'); assert.ok(persisted.modelReview.claim.token);
      assert.deepEqual(value, { dataClass: 'synthetic', text, subjectNames: ['Rosa and Miguel Santos'] });
      value.text = 'mutating the injected input cannot edit the stored source';
      return structuredClone(proposal);
    } });
    assert.equal(calls, 1); assert.deepEqual(result, { ran: true, reportId, status: 'proposal_ready', completed: true });
    const report = raw(store, reportId);
    assert.equal(report.modelReview.proposal.requiresReview, true); assert.equal(report.modelReview.proposal.observations[0].verification, 'reported');
    assert.deepEqual(report.observations, []); assert.equal(report.text, text); assert.equal(report.processingState, 'needs_review');
    assert.deepEqual(domain(store.read()), before);
    unchanged(store, () => store.act(verifyCase, caseId, { officerName: 'Officer Demo', note: 'Direct fictional confirmation attempted from proposal alone.', evidenceIds: [reportId], welfare: 'confirmed_safe', resolve: true }));
    assert.deepEqual(new Store(path).read(), store.read());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical client envelope is strictly revalidated and cannot carry state or false authority', () => {
  const { store, caseId } = setup(), { reportId } = store.act(captureRawReport, input({ caseId }));
  const claim = store.act(claimReportJob, { reportId });
  const canonical = validateExtraction(proposal, text, { subjectNames: ['Rosa and Miguel Santos'] });
  assert.equal(store.act(completeReportJob, { ...claim, proposal: canonical }).status, 'proposal_ready');
  for (const proposed of [{ ...canonical, welfareState: 'confirmed_safe' }, { ...canonical, requiresReview: false }, { ...canonical, processingPath: 'trusted' }, { ...canonical, observations: [{ ...proposal.observations[0], sourceSpan: 'I saw Elena' }] }]) {
    const captured = store.act(captureRawReport, input({ caseId, messageId: `invalid-${store.read().reports.length}` }));
    const next = store.act(claimReportJob, { reportId: captured.reportId });
    const result = store.act(completeReportJob, { ...next, proposal: proposed });
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'invalid_output');
    assert.equal(raw(store, next.reportId).modelReview.proposal, null); assert.deepEqual(raw(store, next.reportId).observations, []);
  }
});

test('unsupported positive proposal stays raw and failed; no case inference from text', async () => {
  const { store } = setup(), before = domain(store.read());
  const { reportId } = store.act(captureRawReport, input({ text: 'C104: I saw Elena at the gate.' }));
  const result = await runReportJob(store, { enabled: true, reportId, extractor: async () => ({ observations: [{ type: 'sighting', sourceSpan: 'I saw Elena at the gate', quantity: null, location: 'the gate' }], reviewFlags: [] }) });
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'invalid_output');
  assert.equal(raw(store, reportId).caseId, null); assert.deepEqual(domain(store.read()), before);
});

test('raw source or case subject changes invalidate work before claim and after async claim', () => {
  for (const beforeClaim of [true, false]) for (const field of ['text', 'senderId', 'caseId', 'subjectNames']) {
    const { store, caseId } = setup(), { reportId } = store.act(captureRawReport, input({ caseId }));
    const claim = beforeClaim ? null : store.act(claimReportJob, { reportId });
    store.act(state => {
      const report = state.reports.find(report => report.id === reportId);
      if (field === 'subjectNames') state.cases.find(item => item.id === caseId).subjectNames = 'Elena Brooks';
      else report[field] = field === 'text' ? 'Changed raw text' : field === 'senderId' ? 'neighbor-2' : null;
    });
    const before = domain(store.read());
    const result = beforeClaim ? store.act(claimReportJob, { reportId }) : store.act(completeReportJob, { ...claim, proposal });
    assert.equal(result.status, 'stale', `${field}, before claim ${beforeClaim}`); assert.equal(result.reason, 'source_changed');
    assert.equal(raw(store, reportId).modelReview.proposal, null); assert.deepEqual(raw(store, reportId).observations, []);
    assert.deepEqual(domain(store.read()), before);
  }
});

test('persisted lease survives restart and a reclaimed token rejects the old completion/failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-inbox-lease-'));
  try {
    const path = join(dir, 'state.json'), { store, caseId } = setup(path), { reportId } = store.act(captureRawReport, input({ caseId }));
    const first = store.act(claimReportJob, { reportId });
    const restarted = new Store(path);
    assert.equal(restarted.act(claimReportJob, { reportId }).claimed, false);
    restarted.act(state => { state.reports.find(report => report.id === reportId).modelReview.claim.expiresAt = '2000-01-01T00:00:00.000Z'; });
    const next = new Store(path), second = next.act(claimReportJob, { reportId });
    assert.equal(second.claimed, true); assert.equal(second.attempt, 2); assert.notEqual(second.claimToken, first.claimToken);
    const before = next.read();
    for (const action of [completeReportJob, failReportJob]) {
      const result = next.act(action, { ...first, proposal, code: 'timeout' });
      assert.equal(result.reason, 'stale_claim'); assert.deepEqual(next.read(), before);
    }
    assert.equal(next.act(completeReportJob, { ...second, proposal }).status, 'proposal_ready');
    const done = next.read(); assert.equal(next.act(completeReportJob, { ...second, proposal }).reason, 'stale_claim'); assert.deepEqual(next.read(), done);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wrong hash, expired lease and malformed lease cannot attach a proposal', () => {
  for (const expiry of ['2000-01-01T00:00:00Z', 'bad', null]) {
    const { store, caseId } = setup(), { reportId } = store.act(captureRawReport, input({ caseId })), claim = store.act(claimReportJob, { reportId });
    const before = store.read(); assert.equal(store.act(completeReportJob, { ...claim, sourceHash: 'wrong', proposal }).reason, 'stale_claim'); assert.deepEqual(store.read(), before);
    store.act(state => { state.reports.find(report => report.id === reportId).modelReview.claim.expiresAt = expiry; });
    assert.equal(store.act(completeReportJob, { ...claim, proposal }).reason, 'stale_claim'); assert.equal(raw(store, reportId).modelReview.proposal, null);
  }
});

test('timeout remains bounded if extractor ignores abort, raw survives, and late result is inert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-inbox-timeout-'));
  try {
    const path = join(dir, 'state.json'), { store, caseId } = setup(path), before = domain(store.read());
    const { reportId } = store.act(captureRawReport, input({ caseId })); let finish, signal;
    const result = await runReportJob(store, { enabled: true, reportId, timeoutMs: 50, extractor: (value, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
    assert.deepEqual(result, { ran: true, reportId, status: 'failed', completed: false, errorCode: 'timeout' });
    assert.equal(signal.aborted, true); assert.equal(raw(store, reportId).text, text);
    const failed = store.read(); finish(proposal); await settle(0); assert.deepEqual(store.read(), failed);
    assert.deepEqual(new Store(path).read(), failed); assert.deepEqual(domain(store.read()), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit abort or extractor failure persists only safe error code and raw review state', async () => {
  for (const mode of ['abort', 'throw']) {
    const { store, caseId } = setup(), before = domain(store.read()), { reportId } = store.act(captureRawReport, input({ caseId }));
    const controller = new AbortController();
    const running = runReportJob(store, { enabled: true, reportId, signal: controller.signal, extractor: async () => {
      if (mode === 'throw') throw new Error('private provider response, fixture-key, user details');
      return new Promise(() => {});
    } });
    if (mode === 'abort') controller.abort();
    const result = await running;
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, mode === 'abort' ? 'cancelled' : 'extractor_failed');
    assert.doesNotMatch(JSON.stringify(store.read()), /private provider response|fixture-key|user details/);
    assert.equal(raw(store, reportId).text, text); assert.deepEqual(raw(store, reportId).observations, []); assert.deepEqual(domain(store.read()), before);
  }
});

test('claim persistence failure prevents extractor invocation and preserves captured raw report', async () => {
  const { store, caseId } = setup(), { reportId } = store.act(captureRawReport, input({ caseId })); const before = store.read(); let calls = 0;
  store.save = () => { throw new Error('Synthetic disk failure'); };
  await assert.rejects(runReportJob(store, { enabled: true, reportId, extractor: async () => { calls++; return proposal; } }), /Synthetic disk failure/);
  assert.equal(calls, 0); assert.deepEqual(store.read(), before); assert.equal(raw(store, reportId).modelReview.status, 'queued');
});
