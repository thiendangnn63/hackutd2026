import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { ProviderLedger } from '../src/provider-ledger.js';
import { createDemoExtractor } from '../src/demo-extractor.js';
import { createRehearsalRuntime, REHEARSAL_TEXT, REHEARSAL_REPLY } from '../src/rehearsal.js';
import { prepareRehearsalServer } from '../src/rehearsal-server.js';
import { acceptReportProposal } from '../src/report-inbox.js';
import { publicState } from '../src/public-state.js';
import { createApp } from '../src/server.js';

const report = (store, id) => store.read().reports.find(item => item.id === id);
const domain = state => ({ cases: state.cases, participants: state.participants, assistance: state.assistance, outbox: state.outbox, integrations: state.integrations, incident: state.incident });
const acceptedInput = (store, id) => ({ reportId: id, reviewerName: 'Fictional reviewer', note: 'Checked the quoted clauses in this fictional report.', expectedProposalToken: report(store, id).modelReview.proposalToken });
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-rehearsal-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json'), ledgerPath = join(dir, 'transport.json');
  const store = new Store(statePath), ledger = new ProviderLedger(ledgerPath);
  const runtime = createRehearsalRuntime({ store, ledger, ...options });
  t.after(() => runtime.shutdown());
  return { dir, statePath, ledgerPath, store, ledger, runtime };
}

test('raw report is saved before local extraction, then human acceptance and simulated reply stay separate', async t => {
  let system;
  let network = 0;
  t.mock.method(globalThis, 'fetch', () => { network++; throw new Error('No remote calls are allowed.'); });
  system = setup(t, { extractor: { async extract(input, options) {
    const saved = new Store(system.statePath).read().reports[0];
    assert.equal(saved.text, REHEARSAL_TEXT); assert.equal(saved.modelReview.status, 'running');
    assert.equal(saved.modelReview.extractorSource, 'local_demo_rules'); assert.deepEqual(saved.observations, []);
    assert.equal(new ProviderLedger(system.ledgerPath).read().rehearsal.interpretations, 1);
    return createDemoExtractor().extract(input, options);
  } } });
  const { runtime, store } = system, before = domain(store.read());
  const result = await runtime.simulate({ text: REHEARSAL_TEXT });
  assert.equal(result.simulated, true); assert.equal(result.duplicate, false); assert.equal(result.status, 'proposal_ready');
  assert.deepEqual(domain(store.read()), before); assert.deepEqual(report(store, result.reportId).observations, []);
  const view = publicState(store.read()).reports[0];
  assert.equal(view.modelReview.extractorSource, 'local_demo_rules'); assert.equal(view.modelReview.proposal.processingPath, 'local_demo_rules');
  assert.equal(view.providerIdentity, undefined); assert.equal(view.modelReview.claim, undefined);
  store.act(acceptReportProposal, acceptedInput(store, result.reportId));
  const expected = structuredClone(before); expected.cases[0].reportIds.push(result.reportId);
  assert.deepEqual(domain(store.read()), expected); assert.equal(report(store, result.reportId).observations.length, 3);
  assert.ok(report(store, result.reportId).observations.every(item => item.verification === 'reported'));
  const prepared = runtime.prepareReply(result.reportId);
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.delivered, false); assert.deepEqual(store.read().outbox, []);
  assert.deepEqual(runtime.prepareReply(result.reportId), prepared);
  const sent = await runtime.sendReply(result.reportId);
  assert.equal(sent.status, 'accepted'); assert.equal(sent.delivered, false); assert.equal(sent.attempts, 1); assert.equal(sent.deliveryChecks, 0);
  assert.deepEqual(await runtime.sendReply(result.reportId, { manualRetry: true }), sent);
  const outgoing = store.read().outbox;
  assert.equal(outgoing.length, 1); assert.equal(outgoing[0].text, REHEARSAL_REPLY); assert.equal(outgoing[0].recipientId, 'neighbor-1'); assert.equal(outgoing[0].caseId, 'C104'); assert.equal(outgoing[0].status, 'simulated');
  const delivered = await runtime.checkDelivery(result.reportId);
  assert.equal(delivered.status, 'delivered'); assert.equal(delivered.delivered, true); assert.equal(delivered.deliveryChecks, 1);
  assert.deepEqual(await runtime.checkDelivery(result.reportId), delivered); assert.equal(store.read().outbox.length, 1);
  assert.equal(store.read().cases[0].welfareState, 'unknown'); assert.equal(store.read().cases[0].locationState, 'unknown'); assert.deepEqual(store.read().assistance, []); assert.equal(network, 0);
});

test('duplicate input reuses the durable raw identity without repeated interpretation or side effects', async t => {
  const { runtime, store, ledger } = setup(t);
  await assert.rejects(runtime.simulate({ scenario: 'duplicate' }), /before replaying/);
  const first = await runtime.simulate({ text: REHEARSAL_TEXT }), before = store.read();
  const duplicate = await runtime.simulate({ scenario: 'duplicate' });
  assert.equal(duplicate.reportId, first.reportId); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.interpretation, null);
  assert.deepEqual(store.read(), before); assert.equal(ledger.read().rehearsal.interpretations, 1); assert.equal(runtime.status().counts.captured, 1);
});

test('later correction and unsupported text remain distinct raw review reports without changing welfare or assistance', async t => {
  const { runtime, store } = setup(t), before = domain(store.read());
  const first = await runtime.simulate({ text: REHEARSAL_TEXT });
  const correction = 'Correction: I saw the wrong person. I did not see Elena.';
  const second = await runtime.simulate({ scenario: 'correction', text: correction });
  const third = await runtime.simulate({ text: 'Please decide what happened; there may be someone nearby.' });
  assert.notEqual(first.reportId, second.reportId); assert.notEqual(second.reportId, third.reportId);
  const corrected = report(store, second.reportId), unknown = report(store, third.reportId);
  assert.equal(corrected.text, correction); assert.deepEqual(corrected.modelReview.proposal.observations.map(item => item.type), ['correction']);
  assert.deepEqual(unknown.modelReview.proposal.observations.map(item => item.type), ['unknown']);
  assert.deepEqual(corrected.observations, []); assert.deepEqual(unknown.observations, []); assert.deepEqual(domain(store.read()), before);
});

test('STOP revokes the fictional sender immediately and blocks prepared replies and interpretation until reset', async t => {
  const { runtime, store, ledger } = setup(t), first = await runtime.simulate({ text: REHEARSAL_TEXT });
  runtime.prepareReply(first.reportId);
  const before = domain(store.read()), stopped = await runtime.simulate({ scenario: 'stop', text: 'STOP' });
  const expected = structuredClone(before); expected.participants.find(item => item.id === 'neighbor-1').optedIn = false;
  assert.deepEqual(domain(store.read()), expected); assert.equal(stopped.status, 'command_processed'); assert.equal(stopped.interpretation, null);
  assert.equal(report(store, stopped.reportId).caseId, null); assert.equal(report(store, stopped.reportId).observedAt, null);
  assert.equal(runtime.status().canSimulate, false); assert.equal(runtime.status().sendingEnabled, false);
  assert.throws(() => runtime.prepareReply(first.reportId), /opted out/);
  await assert.rejects(runtime.sendReply(first.reportId), /opted out/); await assert.rejects(runtime.interpretOne(first.reportId), /opted out/);
  await assert.rejects(runtime.simulate({ text: REHEARSAL_TEXT }), /opted out/);
  const checkin = await runtime.simulate({ text: 'CHECKIN' });
  assert.equal(checkin.status, 'command_review'); assert.equal(checkin.interpretation, null); assert.equal(runtime.status().sendingEnabled, false);
  assert.equal(ledger.read().rehearsal.interpretations, 1); assert.equal(store.read().outbox.length, 0);
  await runtime.reset();
  assert.equal(runtime.status().canSimulate, true); assert.equal(runtime.status().modelUsed, 0); assert.deepEqual(runtime.status().replyStates, []);
  assert.deepEqual(store.read().reports, []); assert.deepEqual(store.read().outbox, []); assert.deepEqual(store.read().assistance, []);
  assert.deepEqual(ledger.read().rehearsal, { version: 1, interpretations: 0, lastInput: null, replyJobs: {} });
  assert.notEqual((await runtime.simulate({ text: REHEARSAL_TEXT })).reportId, first.reportId);
});

test('rehearsal restart retains duplicate identity, interpretation usage and reply state without touching live journal namespaces', async t => {
  const { runtime, store, statePath, ledgerPath } = setup(t), first = await runtime.simulate({ text: REHEARSAL_TEXT });
  runtime.prepareReply(first.reportId); const sent = await runtime.sendReply(first.reportId); await runtime.shutdown();
  const restartedStore = new Store(statePath), restartedLedger = new ProviderLedger(ledgerPath);
  const restarted = createRehearsalRuntime({ store: restartedStore, ledger: restartedLedger }); t.after(() => restarted.shutdown());
  assert.equal(restarted.status().modelUsed, 1); assert.equal((await restarted.simulate({ scenario: 'duplicate' })).reportId, first.reportId);
  assert.deepEqual(await restarted.sendReply(first.reportId), sent); assert.equal(restartedStore.read().outbox.length, 1);
  assert.equal((await restarted.checkDelivery(first.reportId)).delivered, true);
  assert.equal(restartedLedger.read().rehearsal.interpretations, 1);
  const privateState = restartedLedger.read(); assert.deepEqual(privateState.identities, []);
  for (const key of ['receipts', 'polls', 'modelJobs', 'replyJobs', 'budgets']) assert.deepEqual(privateState[key], {});
  assert.equal(store.read().outbox.length, 1);
});

test('a send journal failure followed by restart and explicit retry cannot duplicate the simulated outgoing message', async t => {
  const { runtime, store, ledger, statePath, ledgerPath } = setup(t), first = await runtime.simulate({ text: REHEARSAL_TEXT });
  runtime.prepareReply(first.reportId);
  const act = ledger.act.bind(ledger); let failAccepted = true;
  ledger.act = (action, ...args) => {
    const probe = ledger.read(); action(probe, ...args);
    if (failAccepted && probe.rehearsal.replyJobs[first.reportId]?.status === 'accepted') { failAccepted = false; throw new Error('Synthetic reply-journal failure.'); }
    return act(action, ...args);
  };
  await assert.rejects(runtime.sendReply(first.reportId), /Synthetic reply-journal failure/);
  assert.equal(store.read().outbox.length, 1); assert.equal(runtime.status().replyStates[0].status, 'unknown'); await runtime.shutdown();
  const restartedStore = new Store(statePath), restarted = createRehearsalRuntime({ store: restartedStore, ledger: new ProviderLedger(ledgerPath) }); t.after(() => restarted.shutdown());
  await assert.rejects(restarted.sendReply(first.reportId), /explicit retry/);
  const retried = await restarted.sendReply(first.reportId, { manualRetry: true });
  assert.equal(retried.status, 'accepted'); assert.equal(retried.attempts, 2); assert.equal(restartedStore.read().outbox.length, 1);
});

test('reset during delayed extraction drains cancellation before replacing the local round; late output is inert', async t => {
  let entered, finish, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const { runtime, store, ledger } = setup(t, { extractor: { extract(input, options) { signal = options.signal; entered(); return new Promise(resolve => { finish = () => createDemoExtractor().extract(input).then(resolve); }); } } });
  const pending = runtime.simulate({ text: REHEARSAL_TEXT }); await started;
  assert.equal(store.read().reports[0].modelReview.status, 'running');
  const reset = runtime.reset(); assert.equal(signal.aborted, true);
  await assert.rejects(runtime.simulate({ text: REHEARSAL_TEXT }), /resetting or closed/);
  await reset; await pending;
  assert.deepEqual(store.read().reports, []); assert.equal(ledger.read().rehearsal.interpretations, 0);
  const before = store.read(); await finish(); await tick(); assert.deepEqual(store.read(), before);
});

test('a failed Store reset retains the durable reply journal and renews cancellation for the next fictional report', async t => {
  const { runtime, store, ledger, ledgerPath } = setup(t), first = await runtime.simulate({ text: REHEARSAL_TEXT });
  runtime.prepareReply(first.reportId); await runtime.sendReply(first.reportId);
  const before = store.read(), privateBefore = ledger.read(), bytesBefore = readFileSync(ledgerPath, 'utf8');
  const reset = store.reset.bind(store);
  store.reset = () => { throw new Error('Synthetic state-reset persistence failure.'); };
  await assert.rejects(runtime.reset(), /Synthetic state-reset persistence failure/);
  store.reset = reset;
  assert.deepEqual(store.read(), before); assert.deepEqual(ledger.read(), privateBefore); assert.equal(readFileSync(ledgerPath, 'utf8'), bytesBefore);
  assert.equal(runtime.status().canSimulate, true); assert.equal(runtime.status().modelUsed, 1);
  const next = await runtime.simulate({ text: 'They need water for three people.' });
  assert.equal(next.status, 'proposal_ready'); assert.equal(next.interpretation.completed, true); assert.equal(runtime.status().modelUsed, 2);
  assert.equal(store.read().outbox.length, 1); assert.equal(runtime.status().replyStates.find(item => item.reportId === first.reportId).status, 'accepted');
});

test('a journal-reset failure after state reset is visible and blocks work until explicit reset retry succeeds', async t => {
  const { runtime, store, ledger } = setup(t), first = await runtime.simulate({ text: REHEARSAL_TEXT });
  runtime.prepareReply(first.reportId);
  const before = ledger.read(), act = ledger.act.bind(ledger);
  ledger.act = (action, ...args) => {
    const probe = ledger.read(); action(probe, ...args);
    if (probe.rehearsal.interpretations === 0 && probe.rehearsal.lastInput === null && !Object.keys(probe.rehearsal.replyJobs).length) throw new Error('Synthetic journal-reset persistence failure.');
    return act(action, ...args);
  };
  await assert.rejects(runtime.reset(), /Synthetic journal-reset persistence failure/);
  assert.deepEqual(store.read().reports, []); assert.deepEqual(store.read().outbox, []); assert.deepEqual(ledger.read(), before);
  assert.equal(runtime.status().canSimulate, false); assert.equal(runtime.status().sendingEnabled, false); assert.equal(runtime.status().canReset, true);
  assert.match(runtime.status().lastError, /reset is incomplete.*Retry Reset exercise/);
  await assert.rejects(runtime.simulate({ text: REHEARSAL_TEXT }), /reset is incomplete/);
  assert.throws(() => runtime.prepareReply(first.reportId), /reset is incomplete/);
  ledger.act = act;
  assert.deepEqual(await runtime.reset(), { reset: true });
  assert.equal(runtime.status().canSimulate, true); assert.equal(runtime.status().lastError, null); assert.equal(runtime.status().modelUsed, 0); assert.deepEqual(runtime.status().replyStates, []);
  assert.equal((await runtime.simulate({ text: REHEARSAL_TEXT })).status, 'proposal_ready');
});

test('shutdown cancels delayed extraction, persists raw failure and prevents later actions or late proposal application', async t => {
  let entered, finish, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const { runtime, store } = setup(t, { extractor: { extract(input, options) { signal = options.signal; entered(); return new Promise(resolve => { finish = () => createDemoExtractor().extract(input).then(resolve); }); } } });
  const pending = runtime.simulate({ text: REHEARSAL_TEXT }); await started;
  const stopping = runtime.shutdown(); assert.equal(runtime.shutdown(), stopping); await stopping; await pending;
  assert.equal(signal.aborted, true); assert.equal(runtime.status().enabled, false); assert.equal(runtime.status().sendingEnabled, false);
  assert.equal(store.read().reports[0].text, REHEARSAL_TEXT); assert.equal(store.read().reports[0].modelReview.status, 'failed'); assert.deepEqual(store.read().reports[0].observations, []);
  const before = store.read(); await finish(); await tick(); assert.deepEqual(store.read(), before);
  await assert.rejects(runtime.simulate({ text: REHEARSAL_TEXT }), /closed/); await assert.rejects(runtime.reset(), /closed/); assert.deepEqual(store.read().outbox, []);
});

test('a failed local extractor preserves raw report and finite local budget without domain outcomes', async t => {
  const { runtime, store } = setup(t, { maxInterpretations: 1, extractor: { extract() { throw new Error('private synthetic failure detail'); } } }), before = domain(store.read());
  const first = await runtime.simulate({ text: REHEARSAL_TEXT });
  assert.equal(first.status, 'failed'); assert.equal(report(store, first.reportId).text, REHEARSAL_TEXT);
  assert.equal(report(store, first.reportId).modelReview.extractorSource, 'local_demo_rules'); assert.equal(runtime.status().modelUsed, 1);
  const next = await runtime.simulate({ text: 'They need water for three people.' });
  assert.equal(next.status, 'queued'); assert.equal(next.interpretation.reason, 'budget_exhausted');
  assert.deepEqual(domain(store.read()), before); assert.doesNotMatch(JSON.stringify(publicState(store.read())), /private synthetic failure detail/);
});

test('nonempty live journal namespaces are rejected before any rehearsal or Store write', async t => {
  for (const key of ['identities', 'receipts', 'polls', 'modelJobs', 'replyJobs', 'budgets']) {
    const dir = mkdtempSync(join(tmpdir(), 'beacon-rehearsal-live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(null), path = join(dir, 'ledger.json'), ledger = new ProviderLedger(path);
    ledger.act(next => { next[key] = key === 'identities' ? [{ private: 'fixture sentinel' }] : { sentinel: { private: 'fixture sentinel' } }; });
    const before = readFileSync(path, 'utf8');
    assert.throws(() => createRehearsalRuntime({ store, ledger }), /separate local rehearsal journal/);
    assert.equal(readFileSync(path, 'utf8'), before); assert.equal(store.version.revision, 0); assert.equal(ledger.read().rehearsal, undefined);
  }
});

test('offline launcher uses isolated persisted paths and holds one local lock without constructing provider clients', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-rehearsal-launch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let appCalls = 0;
  const appFactory = (store, satellite, houston, options) => { appCalls++; assert.equal(options.phone.status().mode, 'rehearsal'); assert.equal(satellite, undefined); assert.equal(houston, undefined); return new EventEmitter(); };
  const session = prepareRehearsalServer({ rootDir: dir, appFactory }); t.after(() => session.release());
  assert.equal(session.port, 4173); assert.equal(appCalls, 1); assert.match(session.store.path, /\.data\/rehearsal\/state\.json$/);
  assert.equal(existsSync(join(dir, '.data', 'state.json')), false); assert.equal(existsSync(join(dir, '.data', 'phone-provider-ledger.json')), false);
  assert.throws(() => prepareRehearsalServer({ rootDir: dir, appFactory }), /holds its data lock/); assert.equal(appCalls, 1);
  const first = await session.phone.simulate({ text: REHEARSAL_TEXT }); await session.release();
  assert.equal(existsSync(join(dir, '.data', 'rehearsal', 'server.lock')), false);
  const restarted = prepareRehearsalServer({ rootDir: dir, appFactory }); t.after(() => restarted.release());
  assert.equal((await restarted.phone.simulate({ scenario: 'duplicate' })).reportId, first.reportId); assert.equal(restarted.phone.status().modelUsed, 1);
  assert.equal(existsSync(join(dir, '.data', 'state.json')), false); assert.equal(existsSync(join(dir, '.data', 'phone-provider-ledger.json')), false);
});

async function httpFixture(t) {
  const system = setup(t), app = createApp(system.store, undefined, undefined, { phone: system.runtime }), sockets = new Set();
  app.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await system.runtime.shutdown(); await new Promise(resolve => { for (const socket of sockets) socket.destroy(); app.close(resolve); }); });
  const port = app.address().port, origin = `http://127.0.0.1:${port}`;
  const call = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }); });
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  const post = (path, body = {}) => call(path, { method: 'POST', body });
  return { ...system, call, post };
}

test('HTTP rehearsal exposes honest health and separate simulate, review, prepare, send, delivery and reset actions', async t => {
  const { call, post, store, runtime } = await httpFixture(t);
  assert.equal((await call('/api/health')).data.liveSendingEnabled, false);
  const simulated = await post('/api/phone/simulate', { text: REHEARSAL_TEXT, scenario: 'message' });
  assert.equal(simulated.status, 200); const id = simulated.data.phoneAction.reportId;
  assert.equal(simulated.data.phone.mode, 'rehearsal'); assert.equal(simulated.data.phone.extractorSource, 'local_demo_rules');
  assert.equal(simulated.data.reports[0].modelReview.extractorSource, 'local_demo_rules'); assert.deepEqual(simulated.data.reports[0].observations, []); assert.deepEqual(simulated.data.outbox, []);
  const review = await post(`/api/reports/${id}/review`, { action: 'accept', ...acceptedInput(store, id), reportId: undefined });
  assert.equal(review.status, 200);
  assert.equal((await post(`/api/reports/${id}/reply/prepare`)).data.phoneAction.status, 'prepared'); assert.deepEqual(store.read().outbox, []);
  const sent = await post(`/api/reports/${id}/reply/send`);
  assert.equal(sent.data.phoneAction.status, 'accepted'); assert.equal(sent.data.phoneAction.delivered, false); assert.equal(sent.data.outbox[0].status, 'simulated');
  assert.equal((await post(`/api/reports/${id}/reply/delivery`)).data.phoneAction.delivered, true);
  const reset = await post('/api/reset'); assert.equal(reset.status, 200); assert.deepEqual(reset.data.reports, []); assert.deepEqual(reset.data.outbox, []); assert.equal(runtime.status().modelUsed, 0);
  assert.equal((await call('/api/health')).data.liveSendingEnabled, false);
});

test('HTTP rehearsal rejects cross-origin and injected actions without changing captured state', async t => {
  const { call, post, store } = await httpFixture(t), before = store.read();
  for (const body of [{ text: REHEARSAL_TEXT, senderId: 'neighbor-2' }, { text: REHEARSAL_TEXT, provider: 'photon' }, { text: REHEARSAL_TEXT, scenario: 'live' }]) assert.equal((await post('/api/phone/simulate', body)).status, 400);
  assert.equal((await call('/api/phone/simulate', { method: 'POST', body: { text: REHEARSAL_TEXT }, headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await post('/api/phone/simulate?live=true', { text: REHEARSAL_TEXT })).status, 400);
  assert.equal((await post('/api/reset', { scope: 'live' })).status, 400); assert.deepEqual(store.read(), before);
});
