/** Fictional Houston demand review only. Never dispatches or establishes safety. */
export const HOUSTON_CATEGORIES = Object.freeze(['medical', 'evacuation', 'supplies', 'other']);
const rank = (priority) => HOUSTON_CATEGORIES.indexOf(priority);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validImageId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
const FIXTURE_LAYOUT = [
  { id: 'supplies', count: 300, categories: ['supplies'] },
  { id: 'evacuation', count: 100, categories: ['evacuation', 'supplies'] },
  { id: 'medical', count: 2, categories: ['medical'] },
];
function fixtureClusters(placements) {
  if (placements === undefined || placements === null) return null;
  const invalid = () => { throw new TypeError('Invalid explicit Houston fixture placement manifest'); };
  if (placements.schemaVersion !== 1 || placements.fictional !== true || placements.crs !== 'EPSG:4326' || !Array.isArray(placements.clusters) || placements.clusters.length !== FIXTURE_LAYOUT.length) invalid();
  return FIXTURE_LAYOUT.map(role => {
    const matches = placements.clusters.filter(cluster => cluster?.id === role.id), cluster = matches[0];
    if (matches.length !== 1 || cluster.requestCount !== role.count || !Array.isArray(cluster.categories) || JSON.stringify([...new Set(cluster.categories)].sort()) !== JSON.stringify([...role.categories].sort())) invalid();
    return cluster;
  });
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function insideRegion(point, region) {
  const geometry = region?.geometry, polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return validPoint(point) && polygons.some(polygon => inRing(point, polygon[0]) && !polygon.slice(1).some(ring => inRing(point, ring)));
}
function placementIssue(point, region, imageryId, imageryDate, imagery) {
  if (!validPoint(point)) return 'invalid_fixture_point';
  if (!region || !insideRegion(point, region)) return 'outside_assigned_region';
  if (!validImageId(imageryId) || !validDate(imageryDate)) return 'invalid_imagery_reference';
  if (imagery !== undefined) {
    const image = imagery.find(image => image.id === imageryId && image.date === imageryDate && image.crs === 'EPSG:4326');
    const b = image?.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[0] >= b[2] || b[1] >= b[3]) return 'unknown_imagery_reference';
    if (point[0] < b[0] || point[0] > b[2] || point[1] < b[1] || point[1] > b[3]) return 'outside_imagery_footprint';
  }
  return null;
}

function checkedRegions(regions) {
  if (!Array.isArray(regions)) throw new TypeError('Regions must be an array');
  const ids = new Set();
  return regions.map((region) => {
    if (!region || typeof region.id !== 'string' || !region.id.trim() ||
        typeof region.name !== 'string' || !region.name.trim() || ids.has(region.id)) {
      throw new TypeError('Regions require unique nonempty string IDs and names');
    }
    ids.add(region.id);
    return structuredClone(region);
  });
}

function canonicalRequest(request) {
  if (typeof request.id !== 'string' || !request.id.trim() ||
      !['open', 'resolved'].includes(request.status) ||
      !Array.isArray(request.categories) || !request.categories.length ||
      request.categories.some((category) => !HOUSTON_CATEGORIES.includes(category)) ||
      typeof request.updatedAt !== 'string' || !Number.isFinite(Date.parse(request.updatedAt)) ||
      (request.regionId != null && typeof request.regionId !== 'string') ||
      typeof request.summary !== 'string' || typeof request.urgent !== 'boolean') {
    throw new TypeError('Invalid Houston request: require ID, status, categories, timestamp, summary and urgent flag');
  }
  const normalized = {
    id: request.id, regionId: request.regionId || null, cityId: request.cityId, status: request.status,
    categories: HOUSTON_CATEGORIES.filter((category) => request.categories.includes(category)),
    summary: request.summary, updatedAt: new Date(request.updatedAt).toISOString(), urgent: request.urgent,
  };
  if (['point', 'locationSource', 'imageryId', 'imageryDate', 'locationIssue'].some(key => own(request, key))) {
    normalized.point = validPoint(request.point) ? [...request.point] : null;
    normalized.locationSource = request.locationSource === 'fictional-fixture' ? request.locationSource : null;
    normalized.imageryId = validImageId(request.imageryId) ? request.imageryId : null;
    normalized.imageryDate = validDate(request.imageryDate) ? request.imageryDate : null;
    normalized.locationIssue = typeof request.locationIssue === 'string' && request.locationIssue ? request.locationIssue :
      !normalized.point ? 'invalid_fixture_point' : !normalized.locationSource ? 'invalid_location_source' :
      !normalized.imageryId || !normalized.imageryDate ? 'invalid_imagery_reference' : null;
  }
  return normalized;
}

// Equal-time conflicts resolve deterministically, with resolved preferred to open.
function versionCompare(a, b) {
  return compare(a.updatedAt, b.updatedAt) ||
    compare(a.status === 'resolved' ? 1 : 0, b.status === 'resolved' ? 1 : 0) ||
    compare(JSON.stringify(a), JSON.stringify(b));
}

export function buildHoustonSummary(regions, requests) {
  const resultRegions = checkedRegions(regions).map((region) => ({
    ...region, openCount: 0, intensity: 0,
    categories: Object.fromEntries(HOUSTON_CATEGORIES.map((category) => [category, 0])),
    priority: 'coverage_check', coverageStatus: 'unknown',
  }));
  if (!Array.isArray(requests)) throw new TypeError('Requests must be an array');
  const versions = new Map();
  for (const request of requests) {
    // Resolve valid versions across cities first, then select current Houston demand.
    // Never infer city membership from region names or proximity. Unrelated malformed
    // outside-city records are ignored, but malformed Houston data fails explicitly.
    if (!request || typeof request.cityId !== 'string' || !request.cityId.trim()) continue;
    let normalized;
    try {
      normalized = canonicalRequest(request);
    } catch (error) {
      if (request.cityId === 'houston') throw error;
      continue;
    }
    const previous = versions.get(normalized.id);
    if (!previous || versionCompare(normalized, previous) > 0) versions.set(normalized.id, normalized);
  }
  const open = [...versions.values()].filter((request) => request.cityId === 'houston' && request.status === 'open')
    .sort((a, b) => compare(a.id, b.id));
  const byId = new Map(resultRegions.map((region) => [region.id, region]));
  const explicit = open.some(request => own(request, 'point'));
  if (explicit) for (const region of resultRegions) region.requestLocations = [];
  const unlocatedRequests = [];
  const classifiedOpen = [];
  for (const request of open) {
    const region = byId.get(request.regionId);
    const issue = !region ? 'location_needs_review' : explicit ? request.locationIssue || (!insideRegion(request.point, region) ? 'outside_assigned_region' : null) : null;
    const current = explicit && issue ? { ...request, point: null, locationIssue: issue } : request;
    classifiedOpen.push(current);
    if (issue) { unlocatedRequests.push(current); continue; }
    region.openCount += 1;
    for (const category of request.categories) region.categories[category] += 1;
    if (explicit) region.requestLocations.push({ id: request.id, point: [...request.point], categories: [...request.categories], locationSource: request.locationSource, imageryId: request.imageryId, imageryDate: request.imageryDate });
  }
  const maxOpenCount = resultRegions.reduce((max, region) => Math.max(max, region.openCount), 0);
  for (const region of resultRegions) {
    region.intensity = maxOpenCount ? region.openCount / maxOpenCount : 0;
    region.priority = HOUSTON_CATEGORIES.find((category) => region.categories[category] > 0) || 'coverage_check';
    region.coverageStatus = region.openCount ? 'reported' : 'unknown';
  }
  const reported = resultRegions.filter((region) => region.openCount > 0)
    .sort((a, b) => rank(a.priority) - rank(b.priority) || b.openCount - a.openCount || compare(a.id, b.id));
  const coverage = resultRegions.filter((region) => !region.openCount).sort((a, b) => compare(a.id, b.id));
  // Reserve one slot in each batch for no-report areas; their safety is unknown.
  // Category ordering applies to demand review, not clinical triage or dispatch.
  const queue = [];
  let r = 0; let c = 0;
  const add = (region) => queue.push({
    regionId: region.id, priority: region.priority, openCount: region.openCount,
    reason: region.openCount ? 'reported_requests_review' : 'coverage_check',
  });
  while (r < reported.length || c < coverage.length) {
    for (let slot = 0; slot < 3 && r < reported.length; slot += 1) add(reported[r++]);
    if (c < coverage.length) add(coverage[c++]);
  }
  const urgentRequests = classifiedOpen.filter((request) => request.urgent);
  return {
    regions: resultRegions, queue, urgentRequests, unlocatedRequests, maxOpenCount,
    stats: { openRequests: open.length, regionsWithReports: reported.length,
      coverageChecks: coverage.length, urgentRequests: urgentRequests.length,
      unlocatedRequests: unlocatedRequests.length },
  };
}

/** Stable fixtures generated against supplied Houston geography; never persisted. */
export function createHoustonFixtures(regions, { mode = 'normal', placements, imagery } = {}) {
  const checked = checkedRegions(regions);
  if (!['normal', 'empty'].includes(mode)) throw new TypeError('Unknown Houston fixture mode');
  const clusters = fixtureClusters(placements);
  if (mode === 'empty' || !checked.length) return [];
  const requests = [];
  (placements === undefined ? checked.slice(0, 3) : FIXTURE_LAYOUT.map((role, index) => checked.find(region => region.id === clusters?.[index]?.regionId) || null)).forEach((region, index) => {
    const role = FIXTURE_LAYOUT[index];
    for (let i = 0; i < role.count; i += 1) {
      const cluster = clusters?.[index], point = cluster?.points?.[i];
      const explicitLocation = placements === undefined ? {} : { point: validPoint(point) ? [...point] : null, locationSource: 'fictional-fixture', imageryId: cluster?.imageryId ?? null, imageryDate: cluster?.imageryDate ?? null, locationIssue: placements === null ? 'placement_manifest_unavailable' : placementIssue(point, region, cluster?.imageryId, cluster?.imageryDate, imagery) };
      requests.push({ id: `houston-demo-${index}-${i}`, regionId: region?.id ?? null, cityId: 'houston',
        status: 'open', categories: [...role.categories],
        summary: `Simulated ${role.categories.join(' and ')} request ${i + 1}${region ? ` in ${region.name}` : '; fictional location needs review'}`,
        updatedAt: '2026-11-07T14:00:00.000Z', urgent: index === 2 && i === 0, ...explicitLocation });
    }
  });
  requests.push(structuredClone(requests[0]));
  const resolved = { ...structuredClone(requests[0]), id: 'houston-demo-resolved' };
  requests.push(resolved, { ...resolved, status: 'resolved', updatedAt: '2026-11-07T14:30:00.000Z' });
  requests.push({ ...structuredClone(requests[0]), id: 'houston-demo-unlocated', regionId: null,
    summary: 'Simulated request with unknown Houston location; needs human location review', ...(placements === undefined ? {} : { point: null, imageryId: null, imageryDate: null, locationIssue: 'location_needs_review' }) });
  requests.push({ ...structuredClone(requests[0]), id: 'outside-houston-demo', cityId: 'outside-houston', urgent: true });
  return requests;
}

/** Fictional planning markers, separate from real geographic context labels. */
export function createHoustonFacilities(regions, placements, { imagery } = {}) {
  fixtureClusters(placements);
  if (!placements || !Array.isArray(placements.facilities)) return [];
  const checked = checkedRegions(regions), ids = new Set();
  return placements.facilities.map(facility => {
    if (!facility || typeof facility.id !== 'string' || !facility.id.trim() || ids.has(facility.id) || !['supplies', 'shelter', 'medical'].includes(facility.type) || ['name', 'resource', 'capacity'].some(key => typeof facility[key] !== 'string' || !facility[key].trim() || facility[key].length > 240)) throw new TypeError('Invalid fictional Houston facility');
    ids.add(facility.id);
    const region = checked.find(region => region.id === facility.regionId), issue = placementIssue(facility.point, region, facility.imageryId, facility.imageryDate, imagery);
    return { id: facility.id, type: facility.type, name: facility.name, resource: facility.resource, capacity: facility.capacity, regionId: typeof facility.regionId === 'string' ? facility.regionId : null, point: issue ? null : [...facility.point], imageryId: validImageId(facility.imageryId) ? facility.imageryId : null, imageryDate: validDate(facility.imageryDate) ? facility.imageryDate : null, locationSource: 'fictional-fixture', locationIssue: issue, fictional: true, operational: false, status: 'not_operational' };
  });
}
