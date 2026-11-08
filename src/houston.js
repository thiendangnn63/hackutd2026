/** Fictional Houston demand review only. Never dispatches or establishes safety. */
export const HOUSTON_CATEGORIES = Object.freeze(['medical', 'evacuation', 'supplies', 'other']);
const rank = (priority) => HOUSTON_CATEGORIES.indexOf(priority);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

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
  return {
    id: request.id, regionId: request.regionId || null, cityId: request.cityId, status: request.status,
    categories: HOUSTON_CATEGORIES.filter((category) => request.categories.includes(category)),
    summary: request.summary, updatedAt: new Date(request.updatedAt).toISOString(), urgent: request.urgent,
  };
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
  const unlocatedRequests = [];
  for (const request of open) {
    const region = byId.get(request.regionId);
    if (!region) { unlocatedRequests.push(request); continue; }
    region.openCount += 1;
    for (const category of request.categories) region.categories[category] += 1;
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
  const urgentRequests = open.filter((request) => request.urgent);
  return {
    regions: resultRegions, queue, urgentRequests, unlocatedRequests, maxOpenCount,
    stats: { openRequests: open.length, regionsWithReports: reported.length,
      coverageChecks: coverage.length, urgentRequests: urgentRequests.length,
      unlocatedRequests: unlocatedRequests.length },
  };
}

/** Stable fixtures generated against supplied Houston geography; never persisted. */
export function createHoustonFixtures(regions, { mode = 'normal' } = {}) {
  const checked = checkedRegions(regions);
  if (!['normal', 'empty'].includes(mode)) throw new TypeError('Unknown Houston fixture mode');
  if (mode === 'empty' || !checked.length) return [];
  const requests = [];
  const counts = [300, 100, 2];
  const categories = [['supplies'], ['evacuation', 'supplies'], ['medical']];
  checked.slice(0, 3).forEach((region, index) => {
    for (let i = 0; i < counts[index]; i += 1) {
      requests.push({ id: `houston-demo-${index}-${i}`, regionId: region.id, cityId: 'houston',
        status: 'open', categories: [...categories[index]],
        summary: `Simulated ${categories[index].join(' and ')} request ${i + 1} in ${region.name}`,
        updatedAt: '2026-11-07T14:00:00.000Z', urgent: index === 2 && i === 0 });
    }
  });
  requests.push(structuredClone(requests[0]));
  const resolved = { ...structuredClone(requests[0]), id: 'houston-demo-resolved' };
  requests.push(resolved, { ...resolved, status: 'resolved', updatedAt: '2026-11-07T14:30:00.000Z' });
  requests.push({ ...structuredClone(requests[0]), id: 'houston-demo-unlocated', regionId: null,
    summary: 'Simulated request with unknown Houston location; needs human location review' });
  requests.push({ ...structuredClone(requests[0]), id: 'outside-houston-demo', cityId: 'outside-houston', urgent: true });
  return requests;
}
