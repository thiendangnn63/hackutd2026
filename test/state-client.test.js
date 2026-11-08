import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateClient, stateClient } from '../public/state-client.js';

const snapshot = name => ({ mode: 'simulation', cases: [{ id: name }], participants: [], reports: [], assistance: [], outbox: [], audit: [] });
const response = (state, sessionId = 'session-A', revision = 0, metadata = {}) => new Response(JSON.stringify({ ...state, ...metadata }), { headers: sessionId === null ? {} : { 'X-Beacon-Session': sessionId, 'X-Beacon-Revision': String(revision) } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function eventSources() {
  return class FakeEventSource {
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.closeCount = 0; this.constructor.instances.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    send(state, sessionId = 'session-A', revision = 0, patch = {}) { this.onmessage?.({ data: JSON.stringify({ sessionId, revision, state }), lastEventId: `${sessionId}:${revision}`, ...patch }); }
    error(readyState = 0) { this.readyState = readyState; this.onerror?.({}); }
    close() { this.closeCount++; this.readyState = 2; }
  };
}
function queue() {
  const requests = [];
  const fetchImpl = (path, options) => { const request = deferred(); requests.push({ ...request, path, options }); return request.promise; };
  return { fetchImpl, requests };
}

test('factory, singleton and subscription remain inert until an explicit request or connect', () => {
  let calls = 0; const EventSourceImpl = eventSources();
  const client = createStateClient({ fetchImpl: () => { calls++; }, EventSourceImpl });
  const unsubscribe = client.subscribe(() => { calls++; });
  assert.equal(client.getState(), null); assert.equal(stateClient.getState(), null);
  assert.equal(calls, 0); assert.equal(EventSourceImpl.instances.length, 0); unsubscribe();
});

test('delayed GET cannot replace a newer mutation, while mutation metadata is returned intact', async () => {
  const { fetchImpl, requests } = queue(), client = createStateClient({ fetchImpl }); const seen = [];
  client.subscribe((state, version) => seen.push([state.cases[0].id, version.revision]));
  const refreshing = client.refresh(), mutating = client.request('/api/cases', { subjectNames: 'Fixture' });
  assert.equal(requests[0].path, '/api/state'); assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { subjectNames: 'Fixture' });
  requests[1].resolve(response(snapshot('new mutation'), 'session-A', 2, { caseId: 'C105', duplicate: false }));
  const body = await mutating; assert.equal(body.caseId, 'C105'); assert.equal(body.duplicate, false);
  requests[0].resolve(response(snapshot('old GET'), 'session-A', 1));
  assert.equal((await refreshing).cases[0].id, 'new mutation');
  assert.deepEqual(seen, [['new mutation', 2]]);
});

test('newer SSE wins over delayed mutation HTTP without losing action metadata', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('start'), 'session-A', 1);
  const action = client.request('/api/reports', { text: 'Fictional report' });
  source.send(snapshot('stream newest'), 'session-A', 3);
  requests[0].resolve(response(snapshot('action older'), 'session-A', 2, { reportId: 'R-exact', duplicate: true }));
  const result = await action;
  assert.equal(result.reportId, 'R-exact'); assert.equal(result.duplicate, true); assert.equal(result.cases[0].id, 'action older');
  assert.equal(client.getState().cases[0].id, 'stream newest');
});

test('same version and older SSE/HTTP snapshots emit only once', async () => {
  const EventSourceImpl = eventSources(), client = createStateClient({ EventSourceImpl, fetchImpl: async () => response(snapshot('HTTP duplicate'), 'session-A', 4) });
  const seen = []; client.subscribe((state, version) => seen.push([state.cases[0].id, version.revision])); client.connect();
  const source = EventSourceImpl.instances[0]; source.open();
  source.send(snapshot('first'), 'session-A', 4); source.send(snapshot('same version'), 'session-A', 4); source.send(snapshot('older'), 'session-A', 3);
  await client.refresh();
  assert.deepEqual(seen, [['first', 4]]); assert.equal(client.getState().cases[0].id, 'first');
});

test('restart accepts revision zero, retires old session and rejects its late HTTP and SSE', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl }); const seen = [];
  client.subscribe((state, version) => seen.push([state.cases[0].id, version.sessionId, version.revision]));
  client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('before restart'), 'session-A', 5);
  const oldRequest = client.request('/api/reports', { text: 'Fixture' });
  source.error(); source.open(); source.send(snapshot('after restart'), 'session-B', 0);
  requests[0].resolve(response(snapshot('late old response'), 'session-A', 100, { reportId: 'R-old' }));
  assert.equal((await oldRequest).reportId, 'R-old'); assert.equal(client.getState().cases[0].id, 'after restart');
  source.error(); source.open(); source.send(snapshot('late old stream'), 'session-A', 101); source.send(snapshot('new update'), 'session-B', 1);
  assert.deepEqual(seen, [['before restart', 'session-A', 5], ['after restart', 'session-B', 0], ['new update', 'session-B', 1]]);
});

test('previously unseen old HTTP session cannot replace a session accepted since request launch', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  const delayed = client.request('/api/state'); client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('new stream session'), 'session-new', 0);
  requests[0].resolve(response(snapshot('never accepted old session'), 'session-old', 999)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].path, '/api/state'); requests[1].resolve(response(snapshot('confirmed stream session'), 'session-new', 0)); await delayed;
  assert.equal(client.getState().cases[0].id, 'new stream session');
});

test('a stream opened before a newer HTTP session cannot establish an unseen older session', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  client.connect(); const source = EventSourceImpl.instances[0]; source.open();
  const latest = client.refresh(); requests[0].resolve(response(snapshot('new HTTP session'), 'session-new', 0)); await latest;
  source.send(snapshot('queued old first message'), 'session-old', 999);
  assert.equal(client.getState().cases[0].id, 'new HTTP session');
  requests[1].resolve(response(snapshot('confirmed HTTP session'), 'session-new', 0)); await new Promise(resolve => setImmediate(resolve));
  source.error(); source.open(); source.send(snapshot('genuine next restart'), 'session-next', 0);
  assert.equal(client.getState().cases[0].id, 'genuine next restart');
});

test('one SSE open cannot change process session without a native reconnect open', () => {
  const EventSourceImpl = eventSources(), client = createStateClient({ EventSourceImpl });
  client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('bound A'), 'session-A', 2);
  source.send(snapshot('inconsistent B'), 'session-B', 0); assert.equal(client.getState().cases[0].id, 'bound A');
  source.error(); source.open(); source.send(snapshot('reconnected B'), 'session-B', 0); assert.equal(client.getState().cases[0].id, 'reconnected B');
});

test('same-session newer HTTP remains valid even if its launch preceded first SSE acceptance', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  const pending = client.refresh(); client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('revision one'), 'session-A', 1);
  requests[0].resolve(response(snapshot('revision two'), 'session-A', 2)); await pending;
  assert.equal(client.getState().cases[0].id, 'revision two');
});

test('new HTTP session can establish a restart, but retired sessions never return', async () => {
  const states = [response(snapshot('A'), 'session-A', 10), response(snapshot('B reset'), 'session-B', 0), response(snapshot('A late'), 'session-A', 11)];
  const client = createStateClient({ fetchImpl: async () => states.shift() });
  await client.refresh(); await client.refresh(); await client.refresh(); assert.equal(client.getState().cases[0].id, 'B reset');
});

test('headerless fallback works only before versioned state and ignores older fallback requests', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl }); const seen = [];
  client.subscribe((state, version) => seen.push([state.cases[0].id, version.sessionId]));
  const first = client.refresh(), second = client.refresh();
  requests[1].resolve(response(snapshot('newer fallback'), null)); await second;
  requests[0].resolve(response(snapshot('older fallback'), null)); await first;
  client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('versioned'), 'session-A', 0);
  const last = client.refresh(); requests[2].resolve(response(snapshot('later missing headers'), null)); await last;
  assert.deepEqual(seen, [['newer fallback', null], ['versioned', 'session-A']]);
  assert.equal(client.getState().cases[0].id, 'versioned');
});

test('errors retain the good snapshot and never expose response or transport diagnostics', async () => {
  const secret = 'provider credential and private response'; let next = response(snapshot('good'), 'session-A', 1);
  const client = createStateClient({ fetchImpl: async () => { if (next instanceof Error) throw next; return next; } });
  await client.refresh(); const before = client.getState();
  for (const bad of [new Error(secret), new Response(JSON.stringify({ error: secret }), { status: 500 }), new Response(secret), response({ cases: [] }, 'session-A', 2), new Response(JSON.stringify(snapshot('bad metadata')), { headers: { 'X-Beacon-Session': 'session-A', 'X-Beacon-Revision': 'nan' } })]) {
    next = bad; await assert.rejects(client.refresh(), error => error.name === 'StateClientError' && !String(error).includes(secret)); assert.deepEqual(client.getState(), before);
  }
});

test('bounded local domain validation errors retain useful reasons without changing good state', async () => {
  let next = response(snapshot('good'), 'session-A', 1);
  const client = createStateClient({ fetchImpl: async () => next }); await client.refresh(); const before = client.getState();
  next = new Response(JSON.stringify({ error: 'Observation time cannot be after the scenario clock.' }), { status: 400 });
  await assert.rejects(client.request('/api/reports', {}), error => error.code === 'http_error' && error.status === 400 && error.message === 'Observation time cannot be after the scenario clock.');
  for (const error of ['x'.repeat(501), 'bad\u0000diagnostic', { details: 'not plain text' }]) {
    next = new Response(JSON.stringify({ error }), { status: 400 });
    await assert.rejects(client.request('/api/reports', {}), error => error.code === 'http_error' && error.message.startsWith('The local request failed (400)'));
  }
  assert.deepEqual(client.getState(), before);
});

test('an ambiguous newer cross-session mutation confirms current state instead of staying in old HTTP session', async () => {
  const { fetchImpl, requests } = queue(), client = createStateClient({ fetchImpl });
  const old = client.refresh(), action = client.request('/api/cases', {});
  requests[0].resolve(response(snapshot('old GET'), 'session-A', 3)); await old;
  requests[1].resolve(response(snapshot('new action'), 'session-B', 1, { caseId: 'C-new' }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests[2].path, '/api/state');
  requests[2].resolve(response(snapshot('confirmed new action'), 'session-B', 1));
  assert.equal((await action).caseId, 'C-new'); assert.equal(client.getState().cases[0].id, 'confirmed new action');
  assert.equal(requests.length, 3);
});

test('first new-session SSE after a delayed old HTTP acceptance recovers with one confirmation', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  const old = client.refresh(); client.connect(); const source = EventSourceImpl.instances[0]; source.open();
  requests[0].resolve(response(snapshot('late old HTTP'), 'session-old', 3)); await old;
  source.send(snapshot('new stream'), 'session-new', 0); source.send(snapshot('new stream duplicate'), 'session-new', 0);
  assert.equal(requests.length, 2); requests[1].resolve(response(snapshot('confirmed new stream'), 'session-new', 0));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().cases[0].id, 'confirmed new stream'); source.send(snapshot('next stream'), 'session-new', 1);
  assert.equal(client.getState().cases[0].id, 'next stream');
});

test('newer stream event arriving during session confirmation is retained after the read', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  const old = client.refresh(); client.connect(); const source = EventSourceImpl.instances[0]; source.open();
  requests[0].resolve(response(snapshot('late old HTTP'), 'session-old', 3)); await old;
  source.send(snapshot('new first event'), 'session-new', 0); source.send(snapshot('newer during read'), 'session-new', 1);
  assert.equal(requests.length, 2); requests[1].resolve(response(snapshot('confirmation read before event'), 'session-new', 0));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(client.getState().cases[0].id, 'newer during read');
});

test('failed stream confirmation can recover on a later revision without retrying duplicate events', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  const old = client.refresh(); client.connect(); const source = EventSourceImpl.instances[0]; source.open();
  requests[0].resolve(response(snapshot('late old HTTP'), 'session-old', 3)); await old;
  source.send(snapshot('new first event'), 'session-new', 0); requests[1].reject(new Error('offline once'));
  await new Promise(resolve => setImmediate(resolve)); source.send(snapshot('duplicate'), 'session-new', 0); assert.equal(requests.length, 2);
  source.send(snapshot('later revision'), 'session-new', 1); assert.equal(requests.length, 3);
  requests[2].resolve(response(snapshot('recovered'), 'session-new', 1)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().cases[0].id, 'recovered');
});

test('verification from a previous native open cannot bind a later reconnect to its old session', async () => {
  const { fetchImpl, requests } = queue(), EventSourceImpl = eventSources(), client = createStateClient({ fetchImpl, EventSourceImpl });
  const initial = client.refresh(); client.connect(); const source = EventSourceImpl.instances[0]; source.open();
  requests[0].resolve(response(snapshot('initial A'), 'session-A', 3)); await initial;
  source.send(snapshot('candidate B'), 'session-B', 0); assert.equal(requests.length, 2);
  source.error(); source.open();
  requests[1].resolve(response(snapshot('delayed confirmation B'), 'session-B', 0)); await new Promise(resolve => setImmediate(resolve));
  source.send(snapshot('genuine next C'), 'session-C', 0); assert.equal(requests.length, 3);
  requests[2].resolve(response(snapshot('confirmed C'), 'session-C', 0)); await new Promise(resolve => setImmediate(resolve));
  source.send(snapshot('healthy C continues'), 'session-C', 1); assert.equal(client.getState().cases[0].id, 'healthy C continues');
});

test('failed session confirmation preserves successful action metadata and last good state without a retry loop', async () => {
  const { fetchImpl, requests } = queue(), client = createStateClient({ fetchImpl });
  const old = client.refresh(), action = client.request('/api/cases', {});
  requests[0].resolve(response(snapshot('good old'), 'session-A', 3)); await old;
  requests[1].resolve(response(snapshot('new action'), 'session-B', 0, { caseId: 'C-success' }));
  await new Promise(resolve => setImmediate(resolve)); requests[2].reject(new Error('private connection diagnostic'));
  assert.equal((await action).caseId, 'C-success'); assert.equal(client.getState().cases[0].id, 'good old'); assert.equal(requests.length, 3);
});

test('malformed stream events and mismatched event IDs do not replace or emit state', () => {
  const EventSourceImpl = eventSources(), client = createStateClient({ EventSourceImpl }); let calls = 0;
  client.subscribe(() => { calls++; }); client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('good'), 'session-A', 1);
  for (const data of ['not-json', JSON.stringify({ sessionId: 'session-A', revision: -1, state: snapshot('bad') }), JSON.stringify({ sessionId: 'session-A', revision: 2, state: { cases: [] } })]) source.onmessage({ data });
  source.send(snapshot('wrong ID'), 'session-A', 2, { lastEventId: 'other:2' });
  assert.equal(calls, 1); assert.equal(client.getState().cases[0].id, 'good');
});

test('native transient reconnect uses one source; closed/error and explicit disconnect invalidate callbacks', () => {
  const EventSourceImpl = eventSources(), client = createStateClient({ EventSourceImpl });
  assert.equal(client.connect(), true); assert.equal(client.connect(), false);
  const first = EventSourceImpl.instances[0]; assert.equal(first.url, '/api/events'); first.open(); first.send(snapshot('one'), 'session-A', 1);
  first.error(0); assert.equal(client.connect(), false); assert.equal(first.closeCount, 0); first.open(); first.send(snapshot('two'), 'session-A', 2);
  const staleMessage = first.onmessage; first.error(2); assert.equal(first.closeCount, 1); assert.equal(client.getState().cases[0].id, 'two');
  assert.equal(client.connect(), true); const second = EventSourceImpl.instances[1]; second.open(); second.send(snapshot('three'), 'session-A', 3);
  staleMessage({ data: JSON.stringify({ sessionId: 'session-A', revision: 99, state: snapshot('stale callback') }), lastEventId: 'session-A:99' });
  assert.equal(client.getState().cases[0].id, 'three');
  const secondMessage = second.onmessage; client.disconnect(); client.disconnect(); assert.equal(second.closeCount, 1);
  secondMessage({ data: JSON.stringify({ sessionId: 'session-A', revision: 100, state: snapshot('after disconnect') }), lastEventId: 'session-A:100' });
  assert.equal(client.getState().cases[0].id, 'three');
});

test('cached reads, immediate subscriptions and action body are isolated clones', async () => {
  const EventSourceImpl = eventSources(), client = createStateClient({ EventSourceImpl, fetchImpl: async () => response(snapshot('good'), 'session-A', 1) });
  const body = await client.request('/api/cases', {}); body.cases[0].id = 'mutated body';
  const copy = client.getState(); copy.cases[0].id = 'mutated getState';
  let calls = 0; const unsubscribe = client.subscribe((state, metadata) => { calls++; state.cases[0].id = 'mutated listener'; metadata.revision = 999; });
  assert.equal(calls, 1); assert.equal(client.getState().cases[0].id, 'good');
  client.subscribe(() => { throw new Error('broken renderer'); }); let other = 0; client.subscribe(() => { other++; });
  unsubscribe(); client.connect(); const source = EventSourceImpl.instances[0]; source.open(); source.send(snapshot('next'), 'session-A', 2);
  assert.equal(calls, 1); assert.equal(other, 2); assert.equal(client.getState().cases[0].id, 'next');
});

test('wrapped action state updates cache while full metadata returns to caller', async () => {
  const wrapped = { state: snapshot('wrapped'), reportId: 'R-wrapped', duplicate: false };
  const client = createStateClient({ fetchImpl: async () => new Response(JSON.stringify(wrapped), { headers: { 'X-Beacon-Session': 'session-A', 'X-Beacon-Revision': '1' } }) });
  assert.deepEqual(await client.request('/api/inbox', {}), wrapped); assert.equal(client.getState().cases[0].id, 'wrapped');
});

test('absolute, cross-origin and normalized path escapes fail before fetch; stream absence is inert', async () => {
  let calls = 0; const client = createStateClient({ fetchImpl: async () => { calls++; }, EventSourceImpl: null });
  for (const path of ['https://example.com/api/state', '//example.com/api/state', '/api/../state', '/api/%2e%2e/state', '/api/state#fragment', '/api/\\evil', ' /api/state']) await assert.rejects(client.request(path), { code: 'invalid_request' });
  assert.throws(() => client.connect(), { code: 'stream_unavailable' }); assert.equal(calls, 0); assert.equal(client.getState(), null);
});
