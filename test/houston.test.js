import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHoustonSummary, createHoustonFixtures, createHoustonFacilities } from '../src/houston.js';

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

const box = (west, south, east, north) => ({ type: 'Polygon', coordinates: [[[west,south],[east,south],[east,north],[west,north],[west,south]]] });
const explicitRegions = Array.from({ length: 89 }, (_, index) => ({ id: `r${index}`, name: `Area ${index}`, geometry: box(-95.8 + index / 100, 29.5, -95.791 + index / 100, 29.51) }));
function explicitFixture() {
  const clusters = ['supplies', 'evacuation', 'medical'].map((id, index) => ({ id, regionId: `r${index + 5}`, imageryId: `fixture-${index}`, imageryDate: '2017-08-30', requestCount: [300,100,2][index], categories: [['supplies'],['evacuation','supplies'],['medical']][index], points: Array.from({ length: [300,100,2][index] }, () => [-95.795 + (index + 5) / 100, 29.505]) }));
  const imagery = clusters.map(cluster => ({ id: cluster.imageryId, date: cluster.imageryDate, crs: 'EPSG:4326', bbox: [-96,29,-94,31] }));
  const facilities = clusters.map((cluster, index) => ({ id: `facility-${index}`, type: ['supplies','shelter','medical'][index], name: `Fictional place ${index}`, resource: 'Planning only', capacity: '20 demo places', regionId: cluster.regionId, point: [...cluster.points[0]], imageryId: cluster.imageryId, imageryDate: cluster.imageryDate }));
  return { placements: { schemaVersion: 1, fictional: true, crs: 'EPSG:4326', clusters, facilities }, imagery };
}

test('explicit placements preserve exact unique demand/category totals and source-linked request identities', () => {
  const { placements, imagery } = explicitFixture(), before = structuredClone({ explicitRegions, placements, imagery });
  const requests = createHoustonFixtures(explicitRegions, { placements, imagery }), result = buildHoustonSummary(explicitRegions, requests);
  assert.deepEqual(result.stats, { openRequests: 403, regionsWithReports: 3, coverageChecks: 86, urgentRequests: 1, unlocatedRequests: 1 });
  assert.equal(result.maxOpenCount, 300); assert.equal(result.regions.reduce((sum, region) => sum + region.requestLocations.length, 0), 402);
  const categories = Object.fromEntries(['medical','evacuation','supplies','other'].map(category => [category, result.regions.reduce((sum, region) => sum + region.categories[category], 0) + result.unlocatedRequests.filter(request => request.categories.includes(category)).length]));
  assert.deepEqual(categories, { medical: 2, evacuation: 100, supplies: 401, other: 0 });
  const unique = new Set(result.regions.flatMap(region => region.requestLocations.map(location => location.id))); assert.equal(unique.size, 402);
  for (const [index, cluster] of placements.clusters.entries()) {
    const region = result.regions.find(region => region.id === cluster.regionId); assert.equal(region.openCount, cluster.requestCount);
    const location = region.requestLocations.find(location => location.id === `houston-demo-${index}-0`);
    assert.deepEqual(location.point, cluster.points[0]); assert.equal(location.imageryId, cluster.imageryId); assert.equal(location.imageryDate, cluster.imageryDate); assert.equal(location.locationSource, 'fictional-fixture');
    assert.deepEqual(new Set(location.categories), new Set(cluster.categories));
  }
  assert.equal(result.urgentRequests[0].id, 'houston-demo-2-0'); assert.deepEqual(result.urgentRequests[0].point, placements.clusters[2].points[0]);
  assert.equal(result.unlocatedRequests[0].point, null); assert.equal(result.unlocatedRequests[0].id, 'houston-demo-unlocated');
  result.regions.find(region => region.openCount).requestLocations[0].point[0] = 0;
  assert.deepEqual({ explicitRegions, placements, imagery }, before);
});

test('explicit target region roles and request IDs remain stable when regions and manifest clusters reorder', () => {
  const { placements, imagery } = explicitFixture();
  const first = createHoustonFixtures(explicitRegions, { placements, imagery });
  const next = createHoustonFixtures([...explicitRegions].reverse(), { placements: { ...placements, clusters: [...placements.clusters].reverse() }, imagery });
  assert.deepEqual(next, first);
  const summary = buildHoustonSummary([...explicitRegions].reverse(), next);
  assert.deepEqual(summary.regions.filter(region => region.openCount).map(region => [region.id, region.openCount]).sort(), [['r5',300],['r6',100],['r7',2]]);
});

test('canonical explicit points follow latest deduped status/version, never an obsolete source location', () => {
  const { placements } = explicitFixture(), location = { point: [...placements.clusters[0].points[0]], locationSource: 'fictional-fixture', imageryId: 'fixture-0', imageryDate: '2017-08-30' };
  const old = request({ regionId: 'r5', ...location }), newer = { ...old, regionId: 'r6', point: [...placements.clusters[1].points[0]], imageryId: 'fixture-1', updatedAt: '2026-11-07T15:00:00Z' };
  for (const events of [[old,newer,newer],[newer,old,newer]]) {
    const result = buildHoustonSummary(explicitRegions, events);
    assert.equal(result.regions.find(region => region.id === 'r5').openCount, 0);
    assert.deepEqual(result.regions.find(region => region.id === 'r6').requestLocations[0].point, newer.point);
    assert.equal(result.regions.find(region => region.id === 'r6').requestLocations[0].imageryId, 'fixture-1');
  }
  assert.equal(buildHoustonSummary(explicitRegions, [old, { ...old, status: 'resolved' }]).stats.openRequests, 0);
  assert.equal(buildHoustonSummary(explicitRegions, [old, { ...newer, cityId: 'outside-houston' }]).stats.openRequests, 0);
  const invalidLatest = buildHoustonSummary(explicitRegions, [old, { ...newer, point: [-100,40] }]);
  assert.equal(invalidLatest.unlocatedRequests.length, 1); assert.equal(invalidLatest.unlocatedRequests[0].point, null); assert.equal(invalidLatest.regions.reduce((sum, region) => sum + region.openCount, 0), 0);
});

test('invalid, missing and wrong-region explicit points remain unplaced without clamping or random fallback', () => {
  const { placements } = explicitFixture(), fields = { regionId: 'r5', locationSource: 'fictional-fixture', imageryId: 'fixture-0', imageryDate: '2017-08-30' };
  for (const point of [undefined, null, [], [-95.745], [-95.745,NaN], [-181,29.505], [-95.725,29.505], [-95.745,29.52]]) {
    const result = buildHoustonSummary(explicitRegions, [request({ ...fields, point })]);
    assert.equal(result.stats.openRequests, 1); assert.equal(result.stats.unlocatedRequests, 1); assert.equal(result.maxOpenCount, 0);
    assert.equal(result.unlocatedRequests[0].point, null); assert.ok(result.unlocatedRequests[0].locationIssue); assert.ok(result.regions.every(region => region.requestLocations.length === 0));
  }
  const holed = { id: 'hole', name: 'Hole', geometry: { type: 'Polygon', coordinates: [...box(-96,29,-95,30).coordinates, ...box(-95.8,29.2,-95.2,29.8).coordinates] } };
  assert.equal(buildHoustonSummary([holed], [request({ ...fields, regionId: 'hole', point: [-95.5,29.5] })]).unlocatedRequests.length, 1);
});

test('explicit fixture provenance and registered image bounds/date are checked without changing total demand', () => {
  for (const patch of [{ points: [null] }, { imageryId: 'missing-image' }, { imageryDate: '2017-09-01' }]) {
    const { placements, imagery } = explicitFixture(); Object.assign(placements.clusters[0], patch);
    const result = buildHoustonSummary(explicitRegions, createHoustonFixtures(explicitRegions, { placements, imagery }));
    assert.equal(result.stats.openRequests, 403); assert.ok(result.stats.unlocatedRequests > 1); assert.equal(result.regions.find(region => region.id === 'r5').openCount, 0);
  }
  const { placements, imagery } = explicitFixture(); imagery[0].bbox = [-96,29,-95.75,30];
  assert.equal(buildHoustonSummary(explicitRegions, createHoustonFixtures(explicitRegions, { placements, imagery })).unlocatedRequests.length, 301);
  const missing = buildHoustonSummary(explicitRegions, createHoustonFixtures(explicitRegions, { placements: null }));
  assert.equal(missing.stats.openRequests, 403); assert.equal(missing.unlocatedRequests.length, 403); assert.ok(missing.regions.every(region => region.requestLocations.length === 0));
});

test('fictional facilities preserve stable context and mark invalid coordinates unplaced, never operational', () => {
  const { placements, imagery } = explicitFixture(), before = structuredClone(placements), facilities = createHoustonFacilities(explicitRegions, placements, { imagery });
  assert.equal(facilities.length, 3); assert.ok(facilities.every(facility => facility.point && facility.fictional && facility.operational === false && facility.status === 'not_operational'));
  facilities[0].point[0] = 0; assert.deepEqual(placements, before);
  placements.facilities[0].point = [-100,40]; const invalid = createHoustonFacilities(explicitRegions, placements, { imagery });
  assert.equal(invalid[0].point, null); assert.equal(invalid[0].locationIssue, 'outside_assigned_region'); assert.equal(invalid[0].regionId, 'r5');
  const reordered = createHoustonFacilities([...explicitRegions].reverse(), placements, { imagery }); assert.deepEqual(invalid, reordered);
  assert.deepEqual(createHoustonFixtures(explicitRegions, { mode: 'empty', placements, imagery }), []);
});
