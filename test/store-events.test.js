import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { setConsent } from '../src/domain.js';

test('Store versions are process-local and subscribing/reading does not migrate or rewrite persisted state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-version-'));
  try {
    const path = join(dir, 'state.json'), first = new Store(path);
    first.act(setConsent, 'neighbor-1', { optedIn: false });
    const bytes = readFileSync(path, 'utf8'), second = new Store(path), events = [];
    const unsubscribe = second.onChange(event => events.push(event));
    assert.notEqual(second.version.sessionId, first.version.sessionId);
    assert.equal(second.version.revision, 0); assert.equal(first.version.revision, 1);
    assert.deepEqual(second.readVersioned(), { ...second.version, state: first.read() });
    unsubscribe(); assert.equal(events.length, 0);
    assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.doesNotMatch(bytes, /sessionId|revision/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('committed saves notify isolated observers, unsubscribe is idempotent and reset increments revision', async () => {
  const store = new Store(), snapshots = [], other = [];
  const unsubscribe = store.onChange(event => { snapshots.push(event); event.state.participants[0].name = 'Observer-only mutation'; });
  store.onChange(() => { throw new Error('Observer failure'); });
  store.onChange(async () => { throw new Error('Async observer failure'); });
  store.onChange(event => other.push(event));
  store.act(setConsent, 'neighbor-1', { optedIn: false });
  assert.equal(store.version.revision, 1); assert.equal(snapshots.length, 1); assert.equal(other.length, 1);
  assert.equal(other[0].revision, 1); assert.equal(other[0].state.participants.find(p => p.id === 'neighbor-1').optedIn, false);
  assert.equal(other[0].state.participants[0].name, store.read().participants[0].name);
  unsubscribe(); unsubscribe(); store.reset();
  assert.equal(store.version.revision, 2); assert.equal(snapshots.length, 1); assert.equal(other.length, 2);
  await Promise.resolve(); // Rejected asynchronous listeners are consumed.
});

test('validation and persistence failures leave revision and observers unchanged', () => {
  const store = new Store(), events = [], before = store.read();
  store.onChange(event => events.push(event));
  assert.throws(() => store.act(setConsent, 'missing', { optedIn: false }));
  assert.throws(() => store.act(state => { state.reports = []; throw new Error('Rollback'); }));
  const save = store.save.bind(store); store.save = () => { throw new Error('Disk failure'); };
  assert.throws(() => store.act(setConsent, 'neighbor-1', { optedIn: false }), /Disk failure/);
  assert.deepEqual(store.read(), before); assert.equal(store.version.revision, 0); assert.equal(events.length, 0);
  store.save = save; store.act(setConsent, 'neighbor-1', { optedIn: false }); assert.equal(events.length, 1);
});

test('reentrant observers preserve notification order for other subscribers', () => {
  const store = new Store(), revisions = [];
  store.onChange(event => { if (event.revision === 1) store.act(setConsent, 'neighbor-2', { optedIn: false }); });
  store.onChange(event => revisions.push(event.revision));
  store.act(setConsent, 'neighbor-1', { optedIn: false });
  assert.deepEqual(revisions, [1, 2]); assert.equal(store.version.revision, 2);
});
