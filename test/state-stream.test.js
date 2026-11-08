import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, openStateStream } from '../src/server.js';
import { Store } from '../src/store.js';
import { setConsent } from '../src/domain.js';
import { publicState } from '../src/public-state.js';

async function server(t, store = new Store()) {
  const app = createApp(store), sockets = new Set();
  app.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); app.close(resolve); }));
  const port = app.address().port, origin = `http://127.0.0.1:${port}`;
  function call(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }));
      }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
    });
  }
  async function connect() {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/api/events' }, res => {
        const messages = [], waiters = []; let buffer = '', failure;
        res.setEncoding('utf8'); res.on('data', chunk => {
          buffer += chunk;
          for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const line = frame.split('\n').find(value => value.startsWith('data: '));
            if (!line) continue;
            messages.push({ id: frame.split('\n').find(value => value.startsWith('id: '))?.slice(4), data: JSON.parse(line.slice(6)) });
            for (const ready of [...waiters]) ready();
          }
        });
        res.on('error', error => { failure = error; for (const ready of [...waiters]) ready(); });
        const until = count => new Promise((done, failed) => {
          let timer;
          const check = () => {
            if (messages.length < count && !failure) return;
            clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1);
            failure ? failed(failure) : done(messages[count - 1]);
          };
          waiters.push(check); timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); failed(new Error('SSE message timeout')); }, 1500); check();
        });
        const close = () => { req.destroy(); res.destroy(); };
        t.after(close); resolve({ response: res, messages, until, close });
      }); req.on('error', reject); req.end();
    });
  }
  return { store, call, connect };
}

test('SSE sends current state, tracks the same Store commits, and late/reconnected subscribers get the current revision', async t => {
  const { store, call, connect } = await server(t), first = await connect();
  const initial = await first.until(1);
  assert.deepEqual(initial.data, store.readVersioned()); assert.equal(initial.id, `${store.version.sessionId}:0`);
  assert.equal(first.response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(first.response.headers['cache-control'], 'no-store');
  assert.equal(first.response.headers['x-content-type-options'], 'nosniff');
  assert.match(first.response.headers['content-security-policy'], /frame-ancestors 'none'/);
  const response = await call('/api/participants/neighbor-1/consent', { method: 'POST', body: { optedIn: false } });
  const update = await first.until(2);
  assert.equal(response.status, 200); assert.equal(response.headers['x-beacon-session'], update.data.sessionId);
  assert.equal(response.headers['x-beacon-revision'], '1'); assert.equal(update.data.revision, 1);
  assert.deepEqual(update.data.state, publicState(store.read())); assert.deepEqual(response.data.participants, update.data.state.participants);
  first.close();
  store.act(setConsent, 'neighbor-2', { optedIn: false });
  const second = await connect(), current = await second.until(1);
  assert.equal(current.data.revision, 2); assert.equal(current.data.sessionId, initial.data.sessionId);
  assert.deepEqual(current.data.state, store.read()); second.close();
});

test('GET, mutations and stream all project private job fields without changing stored raw data', async t => {
  const store = new Store();
  store.act(state => state.reports.push({ id: 'R-private', text: 'Synthetic source text.', senderId: 'neighbor-1', caseId: null, observations: [], providerIdentity: { handle: 'private-real-handle' }, modelReview: { status: 'running', source: { private: 'private-source' }, sourceHash: 'private-hash', claim: { token: 'private-claim' }, proposal: null } }));
  const { call, connect } = await server(t, store), before = store.read();
  const get = await call('/api/state');
  assert.equal(get.headers['x-beacon-session'], store.version.sessionId); assert.equal(get.headers['x-beacon-revision'], '1');
  assert.deepEqual(get.data, publicState(before)); assert.equal(get.data.participants[0].phone, '+12125550100');
  const stream = await connect(), first = await stream.until(1);
  assert.deepEqual(first.data.state, get.data);
  const post = await call('/api/participants/neighbor-1/consent', { method: 'POST', body: { optedIn: false } });
  assert.equal(post.data.participantId, 'neighbor-1'); assert.equal(post.headers['x-beacon-revision'], '2');
  assert.doesNotMatch(JSON.stringify([get.data, first.data, post.data]), /private-|providerIdentity|sourceHash/);
  assert.equal(store.read().reports[0].modelReview.claim.token, 'private-claim'); stream.close();
});

test('stream rejects cross-origin/rebinding requests before subscribing and leaves persistence untouched', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-stream-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'), store = new Store(path);
  store.act(setConsent, 'neighbor-1', { optedIn: false });
  const bytes = readFileSync(path, 'utf8'); let subscribed = 0, active = 0;
  const observe = store.onChange.bind(store);
  store.onChange = listener => { subscribed++; active++; const stop = observe(listener); let stopped = false; return () => { if (!stopped) { stopped = true; active--; stop(); } }; };
  const { call, connect } = await server(t, store);
  for (const headers of [{ host: 'evil.example' }, { host: '127.0.0.1.evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' }]) assert.equal((await call('/api/events', { headers })).status, 403);
  assert.equal((await call('/api/events?channel=private')).status, 400); assert.equal(subscribed, 0);
  const stream = await connect(); await stream.until(1); assert.equal(active, 1); stream.close();
  for (let n = 0; n < 20 && active; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(active, 0); assert.equal(readFileSync(path, 'utf8'), bytes);
});

class Response extends EventEmitter {
  constructor(writeImpl = () => true) { super(); this.frames = []; this.writeImpl = writeImpl; this.destroyed = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(frame) { this.frames.push(frame); return this.writeImpl(frame, this.frames.length); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const frames = response => response.frames.filter(frame => frame.startsWith('id: ')).map(frame => JSON.parse(frame.split('\ndata: ')[1]));

test('a blocked stream coalesces commits, sends the accepted initial frame once, and removes its observer on close', () => {
  const store = new Store(), response = new Response((frame, n) => n !== 1);
  openStateStream(response, store);
  store.act(setConsent, 'neighbor-1', { optedIn: false }); store.act(setConsent, 'neighbor-2', { optedIn: false });
  assert.deepEqual(frames(response).map(frame => frame.revision), [0]);
  response.emit('drain'); assert.deepEqual(frames(response).map(frame => frame.revision), [0, 2]);
  assert.deepEqual(frames(response)[1].state, store.read()); response.destroy();
  assert.equal(response.listenerCount('drain'), 0); assert.equal(response.listenerCount('error'), 0); assert.equal(response.listenerCount('close'), 0);
  const count = response.frames.length; store.reset(); assert.equal(response.frames.length, count);
});

test('write errors and a persistently blocked stream disconnect without failing committed saves', async () => {
  const store = new Store(), broken = new Response(() => { throw new Error('Socket failure'); });
  openStateStream(broken, store); assert.equal(broken.destroyed, true);
  assert.doesNotThrow(() => store.act(setConsent, 'neighbor-1', { optedIn: false })); assert.equal(store.version.revision, 1);
  const blocked = new Response(() => false); openStateStream(blocked, store, { backpressureMs: 10, heartbeatMs: 5 });
  store.act(setConsent, 'neighbor-2', { optedIn: false });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(blocked.destroyed, true); assert.equal(blocked.frames.length, 1); assert.equal(blocked.listenerCount('drain'), 0);
});

test('heartbeats keep an idle stream alive and stop after close', async () => {
  const store = new Store(), response = new Response();
  openStateStream(response, store, { heartbeatMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.ok(response.frames.includes(': heartbeat\n\n'));
  response.destroy(); const count = response.frames.length;
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(response.frames.length, count);
});
