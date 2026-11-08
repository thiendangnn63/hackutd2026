// Photon 2 / Beta only. This module has no startup effects and never reads env.
// Calling code must explicitly enable it and supply project-scoped credentials.
export const PHOTON_API_ORIGIN = 'https://api.photon.codes';
const PREFIX = '/v1';
const ID_BODY = '[0-7][0-9a-hjkmnp-tv-z]{25}';
const ids = Object.fromEntries(['prj', 'msg', 'usr', 'spc'].map(kind => [kind, new RegExp(`^pho_${kind}_${ID_BODY}$`)]));
const platforms = new Set(['sms', 'email', 'whatsapp', 'whatsapp_business', 'imessage', 'telegram']);
const statuses = new Set(['received', 'dispatched', 'accepted', 'delivered', 'failed']);
const messages = {
  disabled: 'Photon is disabled.',
  invalid_configuration: 'Photon client configuration is invalid.',
  invalid_request: 'Photon request parameters are invalid.',
  http_error: 'Photon returned an unsuccessful response.',
  rate_limited: 'Photon temporarily rate limited the request.',
  timeout: 'Photon request timed out.',
  aborted: 'Photon request was cancelled.',
  response_too_large: 'Photon response exceeded the configured limit.',
  invalid_response: 'Photon returned an invalid response.',
  network_error: 'Photon request could not be completed.',
  pagination_limit: 'Photon pagination exceeded the configured limit.',
  pagination_loop: 'Photon returned a repeated pagination token.',
};

export class PhotonProtocolError extends Error {
  constructor(code, {status, retryAfterMs} = {}) {
    super(messages[code] || messages.network_error);
    this.name = 'PhotonProtocolError';
    this.code = Object.hasOwn(messages, code) ? code : 'network_error';
    if (Number.isInteger(status)) this.status = status;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}
const fail = (code, metadata) => { throw new PhotonProtocolError(code, metadata); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
// Keep whole-value matching explicit for identifiers and header values.
const fullMatch = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const canonical = (kind, value) => fullMatch(ids[kind], value);

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHour, offsetMinute] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59
    && (zone === 'Z' || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
    && Number.isFinite(Date.parse(value));
}

function retryDelay(header) {
  if (typeof header !== 'string' || header.length > 100) return undefined;
  let delay;
  if (/^\d+(?:\.\d+)?$/.test(header.trim())) delay = Number(header) * 1000;
  else { const date = Date.parse(header); if (Number.isFinite(date)) delay = Math.max(0, date - Date.now()); }
  // Informational only. The client never sleeps or retries a request itself.
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 86_400_000) : undefined;
}

function validateMessage(message, projectId, {messageId, received = false, platform} = {}) {
  if (!object(message) || !canonical('msg', message.id) || message.projectId !== projectId
      || !platforms.has(message.platform) || !statuses.has(message.status)
      || !object(message.content) || (messageId !== undefined && message.id !== messageId)
      || (received && message.status !== 'received') || (platform && message.platform !== platform)) fail('invalid_response');
  // Content and additional fields are preserved verbatim. Unsupported content
  // is for the caller to review, not a reason to invent text, identity or case.
  return message;
}

export function createPhotonClient({
  enabled = false,
  projectId,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  maxResponseBytes = 262_144,
  maxPages = 10,
} = {}) {
  function ready() {
    if (enabled !== true) fail('disabled');
    // This validates credential shape, not account access; only Photon can
    // authenticate the key. Account-wide and Stable credentials are rejected.
    if (!canonical('prj', projectId) || typeof apiKey !== 'string'
        || !fullMatch(/^pho_sk_[A-Za-z0-9._~+\/-]+=*$/, apiKey) || apiKey.length > 4096
        || typeof fetchImpl !== 'function' || !integer(timeoutMs, 1, 60_000)
        || !integer(maxResponseBytes, 1, 4_194_304) || !integer(maxPages, 1, 50)) fail('invalid_configuration');
  }

  async function request(path, {method = 'GET', body, idempotencyKey, signal} = {}) {
    ready();
    if (signal !== undefined && (!(signal instanceof AbortSignal))) fail('invalid_request');
    if (signal?.aborted) fail('aborted');
    const controller = new AbortController();
    let timedOut = false, reader;
    const cancel = () => controller.abort();
    const externalAbort = () => cancel();
    signal?.addEventListener('abort', externalAbort, {once: true});
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    const abortPromise = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
      reject(new PhotonProtocolError(timedOut ? 'timeout' : 'aborted'));
    }, {once: true}));
    try {
      const headers = new Headers({Accept: 'application/json', Authorization: `Bearer ${apiKey}`});
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
      const response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(PHOTON_API_ORIGIN + PREFIX + path, {
          method, headers, ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
          signal: controller.signal, redirect: 'error', cache: 'no-store',
        })), abortPromise,
      ]);
      const expected = method === 'POST' ? 202 : 200;
      if (!response || !Number.isInteger(response.status) || !response.headers?.get) fail('invalid_response');
      if (response.status !== expected) {
        // Never parse or expose an error body: it may echo request secrets or PII.
        Promise.resolve(response.body?.cancel?.()).catch(() => {});
        fail(response.status === 429 ? 'rate_limited' : 'http_error', {
          status: response.status, retryAfterMs: retryDelay(response.headers.get('Retry-After')),
        });
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && /^\d+$/.test(length) && Number(length) > maxResponseBytes) {
        Promise.resolve(response.body?.cancel?.()).catch(() => {}); fail('response_too_large');
      }
      if (!response.body?.getReader) fail('invalid_response');
      reader = response.body.getReader();
      const bytes = new Uint8Array(maxResponseBytes); let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), abortPromise]);
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) fail('invalid_response');
        if (size + part.value.byteLength > maxResponseBytes) fail('response_too_large');
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size))); }
      catch { fail('invalid_response'); }
    } catch (error) {
      if (error instanceof PhotonProtocolError) throw error;
      if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'aborted');
      // No native error/cause, URL, provider body, credentials or message text
      // escapes through the public exception surface.
      fail('network_error');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', externalAbort);
      if (reader) Promise.resolve(reader.cancel()).catch(() => {});
    }
  }

  async function listReceived({
    createdSince, createdBefore, updatedSince, updatedBefore,
    platform = 'imessage', pageSize = 100, maxPages: pageLimit = maxPages, signal,
  } = {}) {
    ready();
    if (!platforms.has(platform) || !integer(pageSize, 1, 200) || !integer(pageLimit, 1, maxPages)) fail('invalid_request');
    const created = createdSince !== undefined || createdBefore !== undefined;
    const updated = updatedSince !== undefined || updatedBefore !== undefined;
    if (created && updated) fail('invalid_request');
    for (const value of [createdSince, createdBefore, updatedSince, updatedBefore]) if (value !== undefined && !validTimestamp(value)) fail('invalid_request');
    if ((createdSince && createdBefore && Date.parse(createdSince) > Date.parse(createdBefore))
      || (updatedSince && updatedBefore && Date.parse(updatedSince) > Date.parse(updatedBefore))) fail('invalid_request');
    const query = new URLSearchParams({platform, direction: 'received', order: 'asc', orderBy: updated ? 'updated_at' : 'created_at', pageSize: String(pageSize)});
    for (const [name, value] of Object.entries({createdSince, createdBefore, updatedSince, updatedBefore})) if (value !== undefined) query.set(name, value);
    const items = new Map(), tokens = new Set(); let pageToken;
    for (let page = 1; page <= pageLimit; page++) {
      if (pageToken !== undefined) query.set('pageToken', pageToken);
      const result = await request(`/projects/${projectId}/messages?${query}`, {signal});
      if (!object(result) || !Array.isArray(result.items) || result.items.length > pageSize) fail('invalid_response');
      for (const value of result.items) {
        const message = validateMessage(value, projectId, {received: true, platform});
        if (!items.has(message.id)) items.set(message.id, message);
      }
      if (result.nextPageToken === undefined) return {platform, items: [...items.values()], pages: page};
      const token = result.nextPageToken;
      if (typeof token !== 'string' || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) fail('invalid_response');
      if (tokens.has(token)) fail('pagination_loop');
      tokens.add(token);
      if (page === pageLimit) fail('pagination_limit');
      pageToken = token;
    }
    fail('pagination_limit');
  }

  async function getDelivery(messageId, {signal} = {}) {
    ready(); if (!canonical('msg', messageId)) fail('invalid_request');
    const message = validateMessage(await request(`/projects/${projectId}/messages/${messageId}`, {signal}), projectId, {messageId});
    return {id: message.id, platform: message.platform, status: message.status, delivered: message.status === 'delivered', message};
  }

  async function reply({spaceId, senderId, parentMessageId, text, idempotencyKey, signal} = {}) {
    ready();
    if (!canonical('spc', spaceId) || !canonical('usr', senderId) || !canonical('msg', parentMessageId)
      || typeof text !== 'string' || text.length < 1 || new TextEncoder().encode(text).byteLength > 16_384
      || !fullMatch(/^[\x21-\x7e]{1,255}$/, idempotencyKey)) fail('invalid_request');
    const body = {spaceId, senderId, parentMessageId, content: {type: 'text', format: 'plain', text}};
    const message = validateMessage(await request(`/projects/${projectId}/messages`, {method: 'POST', body, idempotencyKey, signal}), projectId);
    if (message.status === 'received') fail('invalid_response');
    // The POST acknowledgment is not our confirmation read. Check getDelivery
    // to establish the provider's current authoritative delivery outcome.
    return {id: message.id, platform: message.platform, status: message.status, delivered: false, message};
  }

  return Object.freeze({enabled: enabled === true, listReceived, getDelivery, reply});
}
