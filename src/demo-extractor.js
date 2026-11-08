// Local, scripted English fixture extraction. No model, transport, credentials,
// environment reads or startup work. Every result still requires human review.
import { ModelClientError, validateExtraction } from './nemotron-client.js';

const SOURCE = 'local_demo_rules';
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const PEOPLE_COUNT = new RegExp('\\b(\\d+|' + NUMBER_WORDS.slice(1).join('|') + ')\\s+(?:people|persons?|residents?|neighbors?|children|adults?)\\b', 'i');

function clauses(text) {
  return (text.match(/[^.!?;\n]+[.!?;]?/g) || []).flatMap(sentence => {
    // A question is not a positive asserted observation.
    if (/\?\s*$/.test(sentence)) return [sentence.trim()];
    return sentence.split(/\s+(?:and|but)\s+(?=(?:I|we|they|the\s+road|road)\b)/i)
      .map(span => span.trim().replace(/[.!?;]$/, '').trim()).filter(Boolean);
  });
}

function count(span) {
  const token = span.match(PEOPLE_COUNT)?.[1]?.toLowerCase();
  if (!token) return null;
  const value = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS.indexOf(token);
  return Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;
}

function candidate(type, sourceSpan) {
  const place = type === 'sighting' ? sourceSpan.match(/\s+(?:at|near)\s+(.+)$/i)?.[1] : null;
  return {
    type, sourceSpan,
    quantity: type === 'water_need' ? count(sourceSpan) : null,
    location: place && place.length <= 160 ? place : null,
  };
}

export function createDemoExtractor({ enabled = true } = {}) {
  if (typeof enabled !== 'boolean') throw new ModelClientError('invalid_configuration', 'Enable the local scripted extractor explicitly.');
  return Object.freeze({
    async extract(input, { signal } = {}) {
      if (!enabled) throw new ModelClientError('disabled', 'Local scripted interpretation is disabled.');
      if (input?.dataClass !== 'synthetic') throw new ModelClientError('data_scope', 'The local scripted extractor accepts fictional reports only.');
      const { text, subjectNames = [] } = input;
      if (typeof text !== 'string' || !text.trim() || text.length > 3000 || !Array.isArray(subjectNames) || subjectNames.length > 8 || subjectNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 160) || (signal !== undefined && !(signal instanceof AbortSignal))) {
        throw new ModelClientError('invalid_input', 'Use a bounded fictional report and fictional subject names.');
      }
      if (signal?.aborted) throw new ModelClientError('cancelled', 'Local scripted interpretation was cancelled.');
      if (['STOP', 'CHECKIN'].includes(text.trim().toUpperCase())) throw new ModelClientError('deterministic_command', 'Process consent and enrollment commands without an extractor.');

      const observations = [], unsupported = [];
      for (const span of clauses(text)) {
        let supported = false;
        for (const type of ['sighting', 'self_check_in', 'water_need', 'road_blockage']) {
          try {
            // The shared validator enforces full named objects, complete
            // assertions, literal source spans and global negation guards.
            const value = candidate(type, span);
            let validated;
            try { validated = validateExtraction({ observations: [value], reviewFlags: [] }, text, { subjectNames }); }
            catch (error) {
              // A stated count in an unrelated part of the clause is not a
              // grounded water count. Keep the need without inventing a count.
              if (type !== 'water_need' || value.quantity === null) throw error;
              validated = validateExtraction({ observations: [{ ...value, quantity: null }], reviewFlags: [] }, text, { subjectNames });
            }
            observations.push(...validated.observations);
            supported = true;
          } catch { /* Unsupported grammar remains raw human-review text. */ }
        }
        if (!supported) unsupported.push(span);
      }
      const reviewFlags = [];
      if (unsupported.length || !observations.length || observations.length > 12) {
        reviewFlags.push('unrecognized_text');
        // One complete literal quote keeps unsupported text visible and bounds
        // output even for a long report with many unsupported clauses.
        observations.splice(11);
        observations.push({ type: /\bcorrection\b/i.test(text) ? 'correction' : 'unknown', sourceSpan: text, quantity: null, location: null });
      }
      const validated = validateExtraction({ observations, reviewFlags }, text, { subjectNames });
      return { ...validated, processingPath: SOURCE };
    },
  });
}
