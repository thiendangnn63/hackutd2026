// No environment reads, startup work or simulated outbox forwarding. Only an
// explicitly approved reply to one privately bound inbound report can be sent.
import { createHash, randomUUID } from 'node:crypto';
import { fixtureCaseFingerprint, photonScopeFingerprint } from './photon-inbox.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inFlight = new WeakMap();
const canonical = (kind, value) => typeof value === 'string' &&
  new RegExp('^pho_' + kind + '_[0-7][0-9a-hjkmnp-tv-z]{25}$').exec(value)?.[0] === value;
const bounded = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.exec(value)?.[0] === value;

export class PhotonReplyError extends Error {
  constructor(code) {
    super('The Photon reply operation could not be completed (' + code + ').');
    this.name = 'PhotonReplyError';
    this.code = code;
  }
}
function requireValue(ok, code) { if (!ok) throw new PhotonReplyError(code); }

// Do not return provider envelopes, recipient identities, raw content,
// idempotency keys or native provider/filesystem diagnostics to a caller.
function view(job) {
  return { reportId: job.reportId, status: job.status, attempts: job.attempts,
    deliveryChecks: job.deliveryChecks, delivered: job.status === 'delivered' };
}
function safely(action) {
  try { return action(); }
  catch (error) {
    if (error instanceof PhotonReplyError) throw error;
    throw new PhotonReplyError('private_state_unavailable');
  }
}

// Abort both the real protocol client and a test/injected transport that does
// not honor abort. Do not replace a late completion with a second dispatch.
async function boundedRequest(invoke, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new PhotonReplyError('timeout')); }, timeoutMs);
  });
  try { return await Promise.race([invoke(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}

export function createPhotonReplies({
  enabled = false, store, ledger, client, scope, approval, timeoutMs = 10000, now = Date.now,
} = {}) {
  // Copy the private scope and exact wording at installation. Changing either
  // requires installing a new scope; it cannot modify an existing approval.
  const window = safely(() => structuredClone(scope));
  const permit = safely(() => structuredClone(approval));

  function ready() {
    requireValue(enabled === true, 'disabled');
    requireValue(typeof store?.read === 'function' && typeof ledger?.act === 'function' &&
      typeof ledger?.read === 'function' && typeof client?.reply === 'function' &&
      typeof client?.getDelivery === 'function' && typeof now === 'function' &&
      bounded(timeoutMs, 30000), 'configuration');
    requireValue(window?.dataClass === 'synthetic' && window.platform === 'imessage' &&
      canonical('prj', window.projectId) && canonical('usr', window.agentUsrId) &&
      canonical('usr', permit?.personUsrId) && window.agentUsrId !== permit.personUsrId &&
      canonical('spc', permit.spaceId) && typeof permit.fixtureAlias === 'string' &&
      typeof permit.caseId === 'string' && permit.caseId.length > 0 &&
      typeof permit.text === 'string' && permit.text.trim() && permit.text.length <= 1000 &&
      bounded(permit.maxSendRequests, 2) && bounded(permit.maxDeliveryChecks, 4), 'configuration');
    const instant = now();
    requireValue(Number.isFinite(instant) && Date.parse(window.from) <= instant &&
      instant <= Date.parse(window.to), 'outside_window');
  }
  function transaction(action) {
    // The private ledger deliberately normalizes all action errors. Remember
    // only our own safe policy code while keeping rollback semantics.
    let reason;
    try {
      return ledger.act(state => {
        try { return action(state); }
        catch (error) { if (error instanceof PhotonReplyError) reason = error; throw error; }
      });
    } catch (error) { throw reason ?? error; }
  }
  function budget(state, field, cap) {
    let used = 0;
    for (const job of Object.values(state.replyJobs)) {
      requireValue(Number.isSafeInteger(job[field]) && job[field] >= 0, 'private_state_invalid');
      used += job[field];
    }
    requireValue(used < cap, 'budget');
  }
  function resolve(state, reportId) {
    ready();
    const matches = Object.values(state.receipts).filter(r => r.reportId === reportId && r.status === 'captured');
    requireValue(matches.length === 1, 'no_captured_report');
    const receipt = matches[0], route = receipt.binding, msg = receipt.envelope;
    const identities = state.identities.filter(item => item.projectId === window.projectId &&
      item.platform === window.platform && item.personUsrId === permit.personUsrId &&
      item.spaceId === permit.spaceId && item.agentUsrId === window.agentUsrId);
    const identity = identities.length === 1 ? identities[0] : null;
    requireValue(identity && route && identity.id === route.identityId && route.mappingFingerprint === hash(identity) &&
      route.projectId === window.projectId && route.platform === window.platform && msg && receipt.scopeId === photonScopeFingerprint(window) &&
      receipt.projectId === window.projectId && receipt.platform === 'imessage' &&
      receipt.messageId === msg.id && canonical('msg', msg.id) &&
      receipt.key === hash([receipt.projectId, receipt.platform, receipt.messageId]) &&
      state.receipts[receipt.key]?.id === receipt.id && receipt.envelopeHash === hash(msg) &&
      Array.isArray(receipt.conflicts) && receipt.conflicts.length === 0, 'route_changed');
    requireValue(msg.projectId === window.projectId && msg.status === 'received' && msg.platform === 'imessage' &&
      msg.sentBy?.platform === 'imessage' && msg.receivedBy?.platform === 'imessage' &&
      msg.sentBy.projectId === window.projectId && msg.receivedBy.projectId === window.projectId &&
      msg.space?.platform === 'imessage' && msg.space.kind === 'direct' && msg.space.projectId === window.projectId &&
      Array.isArray(msg.space.participantIds) && msg.space.participantIds.length === 2 &&
      msg.space.participantIds.includes(permit.personUsrId) && msg.space.participantIds.includes(window.agentUsrId) &&
      msg.sentBy.kind === 'human' && msg.receivedBy.kind === 'agent' &&
      msg.sentBy.id === permit.personUsrId && msg.receivedBy.id === window.agentUsrId &&
      msg.space.id === permit.spaceId && Date.parse(window.from) <= Date.parse(msg.timestamps?.receivedAt) &&
      Date.parse(msg.timestamps.receivedAt) <= Date.parse(window.to) && Date.parse(window.from) <= Date.parse(msg.createdAt) &&
      Date.parse(msg.createdAt) <= Date.parse(window.to), 'route_changed');
    for (const [field, value] of Object.entries({ personUsrId: permit.personUsrId, spaceId: permit.spaceId,
      agentUsrId: window.agentUsrId, fixtureAlias: permit.fixtureAlias, caseId: permit.caseId })) {
      requireValue(route[field] === value && identity[field] === value, 'route_changed');
    }
    requireValue(identity.projectId === window.projectId && identity.platform === window.platform, 'route_changed');
    // STOP may already be journaled while raw capture has not yet changed the
    // public alias. The dispatch gate must also inspect this durable evidence.
    const stopped = Object.values(state.receipts).some(({envelope}) => envelope?.projectId === window.projectId &&
      envelope.platform === window.platform && envelope.status === 'received' &&
      envelope.sentBy?.id === permit.personUsrId && envelope.receivedBy?.id === window.agentUsrId &&
      envelope.content?.type === 'text' && typeof envelope.content.text === 'string' && envelope.content.text.trim().toUpperCase() === 'STOP');
    requireValue(!stopped, 'consent');
    const snapshot = store.read(), report = snapshot.reports.find(r => r.id === reportId);
    const participant = snapshot.participants.find(p => p.id === permit.fixtureAlias && p.source === 'fixture');
    requireValue(snapshot.mode === 'simulation' && participant?.optedIn === true, 'consent');
    requireValue(receipt.captureIntent?.caseFingerprint === route.caseFingerprint &&
      receipt.captureIntent.providerEventId === report?.providerEventId && report?.senderId === permit.fixtureAlias && report.caseId === permit.caseId &&
      report.providerEventId === 'inbox:' + hash(['photon', window.projectId, msg.id]) &&
      report.providerIdentity?.provider === 'photon' && report.providerIdentity.projectId === window.projectId &&
      report.providerIdentity.messageId === msg.id && report.modelReview?.source && validDigest(report.modelReview.sourceHash), 'source_changed');
    const source = report.modelReview.source, item = snapshot.cases.find(c => c.id === permit.caseId);
    requireValue(item && route.caseFingerprint === identity.caseFingerprint &&
      route.caseFingerprint === fixtureCaseFingerprint(snapshot, item.id) &&
      hash(source) === report.modelReview.sourceHash &&
      source.senderId === report.senderId && source.caseId === report.caseId &&
      source.text === report.text && msg.content?.type === 'text' && msg.content.format === 'plain' &&
      msg.content.text === report.text && source.observedAt === report.observedAt &&
      hash(source.providerIdentity) === hash(report.providerIdentity) &&
      hash(source.subjectNames) === hash(Array.isArray(item.subjectNames) ? item.subjectNames : [item.subjectNames]) &&
      report.text.trim().toUpperCase() !== 'STOP', 'source_changed');
    return { receipt, stamp: hash([receipt.id, receipt.key, receipt.envelopeHash, route.mappingFingerprint,
      reportId, report.modelReview.sourceHash, report.providerEventId, receipt.scopeId, permit.text,
      permit.maxSendRequests, permit.maxDeliveryChecks]) };
  }
  function checkedJob(state, reportId) {
    const {receipt, stamp} = resolve(state, reportId);
    const job = state.replyJobs[receipt.key];
    requireValue(job && job.reportId === reportId && job.stamp === stamp && job.text === permit.text, 'approval_changed');
    return {job, receipt};
  }
  function prepare({ reportId, text } = {}) {
    return safely(() => {
      ready();
      requireValue(text === permit.text, 'wording');
      return transaction(state => {
        const {receipt, stamp} = resolve(state, reportId);
        if (state.replyJobs[receipt.key]) return view(checkedJob(state, reportId).job);
        budget(state, 'attempts', permit.maxSendRequests);
        const job = {reportId, stamp, text, idempotencyKey: 'beacon-reply-' + randomUUID(),
          attempts: 0, deliveryChecks: 0, status: 'prepared', providerMessageId: null, token: null};
        state.replyJobs[receipt.key] = job;
        return view(job);
      });
    });
  }

  async function transmit(reportId, operation, manualRetry) {
    ready();
    if (!inFlight.has(ledger)) inFlight.set(ledger, new Set());
    const busy = inFlight.get(ledger);
    requireValue(!busy.has(reportId), 'busy');
    busy.add(reportId);
    try {
      const reservation = safely(() => transaction(state => {
        const {job, receipt} = checkedJob(state, reportId);
        if (operation === 'send') {
          if (job.providerMessageId) return {finished: view(job)};
          if (job.status !== 'prepared') {
            requireValue(['sending','unknown'].includes(job.status) && manualRetry === true, 'manual_retry_required');
          }
          budget(state, 'attempts', permit.maxSendRequests);
          job.attempts++;
          job.status = 'sending';
        } else {
          if (['delivered','failed'].includes(job.status)) return {finished: view(job)};
          requireValue(canonical('msg', job.providerMessageId), 'no_accepted_message');
          budget(state, 'deliveryChecks', permit.maxDeliveryChecks);
          job.deliveryChecks++;
        }
        job.token = randomUUID();
        return {key: receipt.key, token: job.token};
      }));
      if (reservation.finished) return reservation.finished;

      const result = await boundedRequest(signal => {
        // No Store/ledger transaction or await between this final check and
        // transport invocation. Never send a key that was not first persisted.
        const {job, receipt} = safely(() => checkedJob(ledger.read(), reportId));
        requireValue(job.token === reservation.token, 'stale_attempt');
        return operation === 'send' ? client.reply({
          spaceId: receipt.binding.spaceId, senderId: receipt.binding.agentUsrId,
          parentMessageId: receipt.messageId, text: job.text, idempotencyKey: job.idempotencyKey, signal,
        }) : client.getDelivery(job.providerMessageId, {signal});
      }, timeoutMs).catch(() => null);
      return safely(() => transaction(state => {
        let status;
        const job = state.replyJobs[reservation.key];
        requireValue(job && job.token === reservation.token, 'stale_attempt');
        const message = result?.message;
        const valid = canonical('msg', result?.id) && result.platform === window.platform &&
          message?.projectId === window.projectId && message.id === result.id &&
          message.platform === window.platform && message.status === result.status &&
          (!message.space || message.space.id === permit.spaceId) &&
          (!message.sentBy || message.sentBy.id === window.agentUsrId) &&
          (!message.parentMessageId || message.parentMessageId === state.receipts[reservation.key]?.messageId);
        if (operation === 'send') {
          const expected = ['accepted', 'dispatched', 'delivered', 'failed'].includes(result?.status);
          if (valid && expected && result.id !== state.receipts[reservation.key]?.messageId) {
            job.providerMessageId = result.id;
            status = result.status === 'failed' ? 'failed' : 'accepted';
          } else status = 'unknown';
        } else if (!valid || result.id !== job.providerMessageId) status = 'delivery_unknown';
        else if (result.status === 'delivered' && result.delivered === true) status = 'delivered';
        else if (result.status === 'failed') status = 'failed';
        else if (['accepted', 'dispatched'].includes(result.status)) status = 'accepted';
        else status = 'delivery_unknown';
        job.status = status;
        job.token = null;
        return view(job);
      }));
    } finally { busy.delete(reportId); }
  }
  function status({reportId} = {}) {
    return safely(() => {
      ready();
      return view(checkedJob(ledger.read(), reportId).job);
    });
  }
  return Object.freeze({
    prepare, status,
    send: ({reportId, manualRetry = false} = {}) => transmit(reportId, 'send', manualRetry),
    checkDelivery: ({reportId} = {}) => transmit(reportId, 'delivery', false),
  });
}
