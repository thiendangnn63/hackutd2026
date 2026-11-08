// Shared local state transport. Importing or subscribing never starts a request.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === null ? null : structuredClone(value);
const validState = value => object(value) && ['cases', 'participants', 'reports', 'assistance', 'outbox', 'audit'].every(key => Array.isArray(value[key]));
const validVersion = (sessionId, revision) => typeof sessionId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId) && Number.isSafeInteger(revision) && revision >= 0;

export class StateClientError extends Error {
  constructor(code, message, status) { super(message); this.name = 'StateClientError'; this.code = code; if (status !== undefined) this.status = status; }
}
function localPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\s\\#]/.test(path)) return false;
  try { const url = new URL(path, 'http://beacon.local'); return url.origin === 'http://beacon.local' && url.pathname.startsWith('/api/') && url.pathname === path.split('?')[0]; }
  catch { return false; }
}
function responseVersion(response) {
  const sessionId = response.headers?.get('X-Beacon-Session') ?? null;
  const rawRevision = response.headers?.get('X-Beacon-Revision') ?? null;
  if (sessionId === null && rawRevision === null) return null;
  const revision = typeof rawRevision === 'string' && /^(0|[1-9]\d*)$/.test(rawRevision) ? Number(rawRevision) : NaN;
  if (!validVersion(sessionId, revision)) throw new StateClientError('invalid_response', 'The local server returned invalid state metadata. Please refresh.');
  return { sessionId, revision };
}

export function createStateClient({ fetchImpl = globalThis.fetch, EventSourceImpl = globalThis.EventSource } = {}) {
  let state = null, sessionId = null, revision = null, sessionEpoch = 0, requestSequence = 0, fallbackSequence = 0, stream = null, verification = null;
  const retiredSessions = new Set(), listeners = new Set();
  const metadata = () => ({ sessionId, revision });
  function deliver(listener) {
    try { listener(clone(state), metadata()); }
    catch { /* One rendering subscriber must not break transport or other views. */ }
  }
  function emit() { for (const listener of [...listeners]) deliver(listener); }
  function accept(next, version, context) {
    if (!validState(next)) return false;
    if (version === null) {
      if (sessionId !== null || context.sequence < fallbackSequence) return false;
      fallbackSequence = context.sequence;
      const copy = clone(next);
      if (state !== null && JSON.stringify(state) === JSON.stringify(copy)) return true;
      state = copy; emit(); return true;
    }
    if (retiredSessions.has(version.sessionId)) return false;
    if (sessionId === version.sessionId) {
      if (version.revision <= revision) return false;
    } else {
      // A response launched before a session transition cannot resurrect another
      // process. Native SSE reconnects establish their own new open epoch.
      if (context.epoch !== sessionEpoch) return false;
      if (sessionId !== null) retiredSessions.add(sessionId);
      sessionId = version.sessionId; revision = null; sessionEpoch++;
    }
    state = clone(next); revision = version.revision; emit(); return true;
  }
  function verifyCurrent() {
    // Opaque process UUIDs cannot order previously unseen sessions. Resolve an
    // ambiguous response with one fresh local read, rather than guessing which
    // process is newer. Failure must not discard a successful action's metadata.
    if (!verification) {
      const pending = request('/api/state', undefined, true).catch(() => null);
      verification = pending;
      void pending.finally(() => { if (verification === pending) verification = null; });
    }
    return verification;
  }
  async function request(path, payload, confirming = false) {
    if (!localPath(path) || typeof fetchImpl !== 'function') throw new StateClientError('invalid_request', 'Use the local Beacon API.');
    const context = { epoch: sessionEpoch, sequence: ++requestSequence };
    let response;
    try {
      response = await fetchImpl(path, payload === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store' });
    } catch { throw new StateClientError('connection_failed', 'The local server could not be reached. Please try again.'); }
    if (!response?.ok) {
      let message = `The local request failed (${Number.isInteger(response?.status) ? response.status : 'unknown'}). Please check the form and try again.`;
      if (response?.status >= 400 && response.status < 500) {
        try {
          const body = await response.json(), reason = body?.error;
          if (typeof reason === 'string' && reason.trim() && reason.trim().length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) message = reason.trim();
        } catch { /* Keep unreadable or unbounded diagnostics generic. */ }
      }
      throw new StateClientError('http_error', message, response?.status);
    }
    let body;
    try { body = await response.json(); }
    catch { throw new StateClientError('invalid_response', 'The local server returned an unreadable response. Please try again.'); }
    const next = object(body) && object(body.state) ? body.state : body;
    if (!validState(next)) throw new StateClientError('invalid_response', 'The local server returned incomplete incident data. Please refresh.');
    const version = responseVersion(response);
    const ambiguous = version !== null && sessionId !== null && version.sessionId !== sessionId && !retiredSessions.has(version.sessionId) && context.epoch !== sessionEpoch;
    accept(next, version, context);
    if (ambiguous && !confirming) await verifyCurrent();
    // Mutation metadata is useful even when a newer stream snapshot already won.
    return body;
  }
  function disconnect() {
    if (!stream) return;
    const previous = stream; stream = null;
    previous.source.onopen = previous.source.onmessage = previous.source.onerror = null;
    try { previous.source.close(); } catch { /* State remains usable offline. */ }
  }
  function connect() {
    if (stream && stream.source.readyState !== 2) return false;
    disconnect();
    if (typeof EventSourceImpl !== 'function') throw new StateClientError('stream_unavailable', 'Live local updates are unavailable. Refresh to read the latest state.');
    let source;
    try { source = new EventSourceImpl('/api/events'); }
    catch { throw new StateClientError('stream_unavailable', 'Live local updates are unavailable. Refresh to read the latest state.'); }
    const current = { source, epoch: sessionEpoch, openGeneration: 0, boundSession: null, checkedSessions: new Map() };
    stream = current;
    source.onopen = () => { if (stream === current) { current.epoch = sessionEpoch; current.openGeneration++; current.boundSession = null; current.checkedSessions.clear(); } };
    source.onmessage = event => {
      if (stream !== current || source.readyState === 2) return;
      let envelope;
      try { envelope = JSON.parse(event.data); } catch { return; }
      if (!object(envelope) || !validVersion(envelope.sessionId, envelope.revision) || !validState(envelope.state)) return;
      if (event.lastEventId && event.lastEventId !== `${envelope.sessionId}:${envelope.revision}`) return;
      // One HTTP stream carries one process session. A changed session is valid
      // only after native EventSource emits a new open on reconnect.
      if (current.boundSession !== null && current.boundSession !== envelope.sessionId) return;
      const version = { sessionId: envelope.sessionId, revision: envelope.revision };
      if (retiredSessions.has(version.sessionId)) return;
      if (sessionId !== version.sessionId && current.epoch !== sessionEpoch) {
        if (current.checkedSessions.get(version.sessionId) !== version.revision) {
          current.checkedSessions.set(version.sessionId, version.revision);
          const openGeneration = current.openGeneration;
          void verifyCurrent().then(() => {
            // A newer event may arrive during the confirmation read. Once its
            // session is confirmed, retain that event's higher revision too.
            if (stream === current && current.openGeneration === openGeneration && sessionId === version.sessionId) {
              current.boundSession = version.sessionId;
              accept(envelope.state, version, { epoch: current.epoch });
            }
          });
        }
        return;
      }
      current.boundSession = envelope.sessionId;
      accept(envelope.state, version, { epoch: current.epoch });
    };
    source.onerror = () => {
      if (stream !== current) return;
      // CONNECTING errors use the native retry. CLOSED sources need an explicit
      // connect() call; both preserve the last good snapshot.
      if (source.readyState === 2) disconnect();
    };
    return true;
  }
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new StateClientError('invalid_subscriber', 'Use a state listener function.');
      listeners.add(listener); if (state !== null) deliver(listener);
      return () => listeners.delete(listener);
    },
    getState: () => clone(state),
    request,
    async refresh() { await request('/api/state'); return clone(state); },
    connect,
    disconnect,
  };
}

export const stateClient = createStateClient();
