// Public family-state projection. Raw message text is preserved; private
// identity mappings and extraction job credentials must never reach the UI.
const internal = new Set(['providerIdentity', 'claimToken', 'sourceHash', 'sourceSnapshot']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const extractorSources = new Set(['nvidia_nemotron', 'local_demo_rules']);
const observationFields = ['type', 'summary', 'sourceSpan', 'quantity', 'location', 'verification'];

function proposalView(value, extractorSource) {
  const path = extractorSource === 'local_demo_rules' ? 'local_demo_rules' : 'nemotron';
  if ((extractorSource !== undefined && !extractorSources.has(extractorSource)) || !object(value) || value.requiresReview !== true || value.processingPath !== path
    || !Array.isArray(value.observations) || !Array.isArray(value.reviewFlags)) return null;
  // The inbox validates grounding before persistence. This projection preserves
  // its canonical review envelope, never arbitrary provider-supplied fields.
  return {
    observations: value.observations.map(item => {
      if (!object(item)) return null;
      return Object.fromEntries(observationFields.filter(key => Object.hasOwn(item, key)).map(key => [key, project(item[key])]));
    }).filter(Boolean),
    reviewFlags: value.reviewFlags.filter(flag => typeof flag === 'string'),
    processingPath: path, requiresReview: true,
  };
}

function project(value) {
  if (Array.isArray(value)) return value.map(project);
  if (!object(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (internal.has(key)) continue;
    if (key === 'modelReview') {
      if (object(item)) {
        const review = { status: typeof item.status === 'string' ? item.status : 'unknown', proposal: proposalView(item.proposal, item.extractorSource) };
        if (extractorSources.has(item.extractorSource)) review.extractorSource = item.extractorSource;
        if (typeof item.proposalToken === 'string' && /^[a-f0-9]{64}$/.test(item.proposalToken)) review.proposalToken = item.proposalToken;
        const decision = item.reviewDecision;
        if (object(decision) && ['accepted', 'dismissed'].includes(decision.action) && typeof decision.reviewerName === 'string' && typeof decision.note === 'string' && Array.isArray(decision.observationIndices)) {
          review.reviewDecision = { action: decision.action, reviewerName: decision.reviewerName, note: decision.note, observationIndices: decision.observationIndices.filter(Number.isInteger), reviewedAt: decision.reviewedAt };
        }
        result.modelReview = review;
      }
      continue;
    }
    Object.defineProperty(result, key, { value: project(item), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function publicState(state) { return project(state); }
