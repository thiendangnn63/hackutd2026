import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHoustonSummary, createHoustonFixtures } from '../src/houston.js';

const regions = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, name: `Area ${i}` }));
const request = (changes = {}) => ({ id: 'one', regionId: 'r0', cityId: 'houston', status: 'open',
  categories: ['supplies'], summary: 'Fictional request', updatedAt: '2026-11-07T14:00:00Z', urgent: false, ...changes });

test('stable fixture counts are unique open demand with exact relative intensity', () => {
  const fixtures = createHoustonFixtures(regions);
  assert.deepEqual(fixtures, createHoustonFixtures(regions));
  const result = buildHoustonSummary(regions, fixtures);
  assert.equal(result.maxOpenCount, 300);
  assert.equal(result.regions[0].openCount, 300);
  assert.equal(result.regions[1].openCount, 100);
  assert.equal(result.regions[1].intensity, 1 / 3);
  assert.equal(result.regions[2].openCount, 2);
  assert.equal(result.stats.openRequests, 403); // 402 located, one unknown Houston location.
});

test('empty fixture has finite zero intensities and every area needs coverage review', () => {
  const result = buildHoustonSummary(regions, createHoustonFixtures(regions, { mode: 'empty' }));
  assert.equal(result.maxOpenCount, 0);
  assert.ok(result.regions.every((region) => region.intensity === 0 && region.coverageStatus === 'unknown'));
  assert.equal(result.queue.length, regions.length);
  assert.ok(result.queue.every((entry) => entry.priority === 'coverage_check' && entry.reason === 'coverage_check'));
  assert.deepEqual(buildHoustonSummary([], []).regions, []);
});

test('latest status wins irrespective of order, duplicate events and equal-time conflicts', () => {
  const events = [request(), request(), request({ status: 'resolved', updatedAt: '2026-11-07T15:00:00Z' })];
  assert.equal(buildHoustonSummary(regions, events).stats.openRequests, 0);
  assert.deepEqual(buildHoustonSummary(regions, events), buildHoustonSummary(regions, [...events].reverse()));
  assert.equal(buildHoustonSummary(regions, [request(), request({ status: 'resolved' })]).stats.openRequests, 0);
  assert.equal(buildHoustonSummary(regions, [...events, request({ updatedAt: '2026-11-07T16:00:00Z' })]).stats.openRequests, 1);
});

test('multi-category demand overlaps categories but never total or within-category counts', () => {
  const result = buildHoustonSummary(regions, [request({ categories: ['medical', 'supplies', 'medical'] })]);
  assert.equal(result.stats.openRequests, 1);
  assert.deepEqual(result.regions[0].categories, { medical: 1, evacuation: 0, supplies: 1, other: 0 });
});

test('review priority is medical then evacuation then supplies then other, urgent low demand survives', () => {
  const events = ['other', 'supplies', 'evacuation', 'medical'].map((category, i) =>
    request({ id: String(i), regionId: `r${i}`, categories: [category], urgent: category === 'medical' }));
  const result = buildHoustonSummary(regions, events);
  assert.deepEqual(result.queue.filter((entry) => entry.openCount).map((entry) => entry.priority),
    ['medical', 'evacuation', 'supplies', 'other']);
  assert.equal(result.urgentRequests[0].regionId, 'r3');
  assert.equal(result.queue[3].priority, 'coverage_check');
  assert.equal(new Set(result.queue.map((entry) => entry.regionId)).size, regions.length);
});

test('only explicit Houston requests count and unmatched locations stay separate', () => {
  const result = buildHoustonSummary(regions, [request({ cityId: 'sugar-land' }),
    request({ id: 'missing', regionId: null, urgent: true }), request({ id: 'unknown', regionId: 'not-a-region' }),
    request({ id: 'no-city', cityId: undefined })]);
  assert.equal(result.stats.openRequests, 2);
  assert.equal(result.unlocatedRequests.length, 2);
  assert.equal(result.stats.urgentRequests, 1);
  assert.equal(result.maxOpenCount, 0);
});

test('malformed categories and status fail explicitly rather than misclassify', () => {
  for (const changes of [{ status: 'pending' }, { categories: ['clinical-triage'] }, { categories: [] },
    { updatedAt: 'not-a-date' }, { urgent: 'yes' }]) {
    assert.throws(() => buildHoustonSummary(regions, [request(changes)]), TypeError);
  }
  assert.throws(() => buildHoustonSummary([regions[0], regions[0]], []), TypeError);
  assert.throws(() => createHoustonFixtures(regions, { mode: 'live' }), TypeError);
});

test('input and nested geometry are not mutated or aliased', () => {
  const areas = [{ ...regions[0], geometry: { type: 'Point', coordinates: [0, 0] } }];
  const events = [request()];
  const before = structuredClone({ areas, events });
  const result = buildHoustonSummary(areas, events);
  assert.deepEqual({ areas, events }, before);
  result.regions[0].geometry.coordinates[0] = 5;
  assert.deepEqual({ areas, events }, before);
});

test('latest valid city membership removes moved-away demand and admits moves into Houston', () => {
  const older = request({ urgent: true, categories: ['medical'] });
  const movedAway = request({ cityId: 'sugar-land', urgent: true, updatedAt: '2026-11-07T15:00:00Z' });
  for (const events of [[older, movedAway], [movedAway, older]]) {
    const result = buildHoustonSummary(regions, events);
    assert.equal(result.stats.openRequests, 0);
    assert.equal(result.stats.urgentRequests, 0);
    assert.equal(result.maxOpenCount, 0);
    assert.deepEqual(result.unlocatedRequests, []);
    assert.deepEqual(result.urgentRequests, []);
  }
  const movedBack = request({ urgent: true, updatedAt: '2026-11-07T16:00:00Z' });
  const result = buildHoustonSummary(regions, [movedBack, movedAway, older]);
  assert.equal(result.stats.openRequests, 1);
  assert.equal(result.regions[0].openCount, 1);
  assert.equal(result.urgentRequests[0].cityId, 'houston');
  assert.deepEqual(result, buildHoustonSummary(regions, [older, movedAway, movedBack]));
});

test('malformed outside-city versions cannot supersede valid demand or break Houston validation', () => {
  const invalidOutside = request({ cityId: 'sugar-land', status: 'bad', updatedAt: '2026-11-07T15:00:00Z' });
  assert.equal(buildHoustonSummary(regions, [request(), invalidOutside]).stats.openRequests, 1);
  assert.throws(() => buildHoustonSummary(regions, [request({ status: 'bad' }),
    request({ cityId: 'sugar-land', updatedAt: '2026-11-07T15:00:00Z' })]), TypeError);
});
