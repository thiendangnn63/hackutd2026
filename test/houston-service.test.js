import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HoustonService } from '../src/houston-service.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'houston-service-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'public/data'); mkdirSync(directory, { recursive: true });
  const put = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  const geometry = { type: 'Polygon', coordinates: [[[-95.8,29.6],[-95.2,29.6],[-95.2,30],[-95.8,30],[-95.8,29.6]]] };
  put('houston-city.json', { type: 'Feature', properties: { name: 'Houston' }, geometry });
  put('houston-neighborhoods.json', { type: 'FeatureCollection', features: ['A','B','C','D'].map(id => ({ type: 'Feature', properties: { id, name: `Test region ${id}` }, geometry })) });
  put('houston-geography-meta.json', { bbox: [-95.8,29.6,-95.2,30], sourceUrls: ['https://example.invalid/test-only'], attribution: 'Test fixture, not geography', basemap: { available: true, file: 'houston-imagery.jpg', bbox: [-95.8,29.6,-95.2,30], date: 'Historical test fixture' } });
  return { root, directory, put, service: new HoustonService(root) };
}

test('Houston summary uses verified region files and separates image absence from map availability', t => {
  const f = fixture(t); const result = f.service.view();
  assert.equal(result.available, true); assert.equal(result.mode, 'simulation'); assert.equal(result.city.id, 'houston');
  assert.equal(result.regions.length, 4); assert.equal(result.maxOpenCount, 300);
  assert.equal(result.basemap.available, false); assert.equal(result.basemap.url, null);
  writeFileSync(join(f.directory, 'houston-imagery.jpg'), 'fixture image bytes, never decoded');
  assert.equal(f.service.view().basemap.url, '/data/houston-imagery.jpg');
  assert.equal(f.service.view().basemap.available, true);
});

test('empty scenario preserves every coverage area with finite zero intensity', t => {
  const f = fixture(t); const result = f.service.view({ scenario: 'empty' });
  assert.equal(result.maxOpenCount, 0); assert.equal(result.stats.openRequests, 0);
  assert.equal(result.queue.length, 4);
  assert.ok(result.regions.every(region => region.intensity === 0 && region.coverageStatus === 'unknown'));
});

test('other cities and unsupported scenarios are rejected instead of substituted', t => {
  const { service } = fixture(t);
  for (const input of [{ city: 'pasadena' }, { city: '../houston' }, { scenario: 'live' }]) assert.throws(() => service.view(input), error => error.status === 400);
});

test('missing or invalid official geometry never produces pretend boundaries or counts', t => {
  const f = fixture(t); f.put('houston-city.json', { type: 'Feature', geometry: null });
  assert.equal(f.service.view().available, false); assert.equal(f.service.view().regions, undefined);
  rmSync(join(f.directory, 'houston-city.json'));
  assert.equal(f.service.view().available, false);
});

test('Houston API rejects foreign cities and origins and does not mutate family state', async t => {
  const f = fixture(t); const store = new Store(); const before = store.read();
  const app = createApp(store, undefined, f.service);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const normal = await fetch(base + '/api/houston'); assert.equal(normal.status, 200);
  assert.equal((await normal.json()).maxOpenCount, 300);
  const empty = await fetch(base + '/api/houston?scenario=empty'); assert.equal((await empty.json()).stats.openRequests, 0);
  for (const query of ['?city=pasadena', '?scenario=live', '?path=../secrets']) assert.equal((await fetch(base + '/api/houston' + query)).status, 400);
  assert.equal((await fetch(base + '/api/houston', { headers: { origin: 'https://unrelated.invalid' } })).status, 403);
  assert.deepEqual(store.read(), before);
});
