import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createPhotonClient, PhotonProtocolError } from '../src/photon-client.js';

// Fictional canonical identifiers and an intentionally unusable test credential.
const canonical = (kind, suffix = '0') => `pho_${kind}_${String(suffix).padStart(26, '0')}`;
const PROJECT = canonical('prj');
const MESSAGE = canonical('msg');
const MESSAGE_2 = canonical('msg', '1');
const USER = canonical('usr');
const SPACE = canonical('spc');
const KEY = 'pho_sk_mock_only_not_a_real_credential';
const TOKEN_A = 'opaque.page-one';
const TOKEN_B = 'opaque.page-two';
const ORIGIN = 'https://api.photon.codes';
const ROOT = `/v1/projects/${PROJECT}/messages`;
const BASE = { enabled: true, projectId: PROJECT, apiKey: KEY };
const REPLY = {
  spaceId: SPACE, senderId: USER, parentMessageId: MESSAGE,
  text: 'Fictional local integration test reply.', idempotencyKey: 'caller-owned-reply-001',
};
const received = (id = MESSAGE, extra = {}) => ({
  id, projectId: PROJECT, status: 'received', platform: 'imessage',
  spaceId: SPACE, senderId: USER, content: { type: 'text', format: 'plain', text: 'Fictional observation.' },
  ...extra,
});
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
function mockFetch(sequence) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url: new URL(url), init, headers: new Headers(init.headers) });
    const item = sequence[calls.length - 1];
    assert.notEqual(item, undefined, 'Unexpected extra provider call; all HTTP calls must be explicit');
    if (typeof item === 'function') return item(input, init);
    if (item instanceof Error) throw item;
    return item;
  };
  return { calls, fetchImpl, client: options => createPhotonClient({ ...BASE, fetchImpl, ...options }) };
}
const protocolError = (code, status) => error => {
  assert.ok(error instanceof PhotonProtocolError, `Expected PhotonProtocolError, received ${error?.constructor?.name}`);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};
function assertRequest(call, method, path = ROOT) {
  assert.equal(call.url.origin, ORIGIN);
  assert.equal(call.url.pathname, path);
  assert.equal((call.init.method || 'GET').toUpperCase(), method);
  assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`);
  assert.ok(call.init.signal instanceof AbortSignal);
}
function assertRedacted(error, forbidden) {
  const rendered = `${String(error)}\n${JSON.stringify(error)}\n${inspect(error, { depth: 4 })}`;
  for (const value of forbidden) assert.equal(rendered.includes(value), false, `Error exposed sensitive fixture: ${value}`);
}

// Every request below terminates at a local mock. No network or credential discovery occurs.
test('constructor is inert and disabled methods never invoke fetch', async () => {
  const fake = mockFetch([]);
  const client = createPhotonClient({ fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls.length, 0);
  for (const action of [() => client.listReceived(), () => client.getDelivery(MESSAGE), () => client.reply(REPLY)]) {
    await assert.rejects(action, protocolError('disabled'));
  }
  assert.equal(fake.calls.length, 0);
  fake.client();
  assert.equal(fake.calls.length, 0, 'Constructing an enabled client must not connect or send');
});

test('missing credentials and malformed canonical project IDs fail before any HTTP call', async t => {
  const invalid = [
    { projectId: undefined }, { apiKey: undefined }, { apiKey: '' }, { apiKey: 'not-a-photon-key' },
    { apiKey: 'pho_sk_has whitespace' }, { apiKey: 'pho_sk_line\nbreak' }, { apiKey: 'pho_sk_trailing\n' }, { apiKey: 'pho_sk_trailing\r' },
    { projectId: `pho_prj_8${'0'.repeat(25)}` },
    { projectId: `pho_prj_0${'i'.repeat(25)}` },
    { projectId: 'pho_prj_000' }, { projectId: MESSAGE }, { projectId: PROJECT + '\n' }, { projectId: PROJECT + '\r' },
  ];
  for (const [index, change] of invalid.entries()) await t.test(`invalid configuration ${index + 1}`, async () => {
    const fake = mockFetch([]);
    await assert.rejects(async () => fake.client(change).listReceived(), protocolError('invalid_configuration'));
    assert.equal(fake.calls.length, 0);
  });
});

test('listReceived follows an empty page token and preserves the exact fixed-origin authenticated query', async () => {
  const fake = mockFetch([
    response({ items: [], nextPageToken: TOKEN_A }),
    response({ items: [received()] }),
  ]);
  const since = '2026-11-08T00:00:00Z';
  const result = await fake.client().listReceived({ createdSince: since });
  assert.equal(result.pages, 2);
  assert.equal(result.platform, 'imessage', 'The default mode stays explicit in the result');
  assert.deepEqual(result.items, [received()]);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assertRequest(call, 'GET');
    assert.equal(call.url.searchParams.get('createdSince'), since);
    assert.equal(call.url.searchParams.get('direction'), 'received');
    assert.equal(call.url.searchParams.get('platform'), 'imessage');
    assert.equal(call.url.searchParams.get('pageSize'), '100');
    assert.equal(call.url.searchParams.has('apiKey'), false);
  }
  assert.equal(fake.calls[0].url.searchParams.has('pageToken'), false);
  assert.equal(fake.calls[1].url.searchParams.get('pageToken'), TOKEN_A);
});

test('pagination keeps the first representation of each canonical ID and retains unknown content', async () => {
  const unknown = received(MESSAGE, { content: { type: 'future.observation', payload: { source: 'fictional', water: false } }, futureExtension: { opaque: true } });
  const later = received(MESSAGE, { content: { type: 'text', text: 'Later duplicate must not replace first representation.' } });
  const second = received(MESSAGE_2);
  const fake = mockFetch([response({ items: [unknown], nextPageToken: TOKEN_A }), response({ items: [later, second] })]);
  const result = await fake.client().listReceived();
  assert.deepEqual(result.items, [unknown, second]);
  assert.equal(result.items[0].caseId, undefined, 'Unknown message content must not become an invented local case association');
  assert.equal(result.pages, 2);
});

test('partial pagination failure rejects the entire listing rather than returning a successful partial result', async () => {
  const fake = mockFetch([response({ items: [received()], nextPageToken: TOKEN_A }), response({ error: 'private provider response' }, 503)]);
  await assert.rejects(() => fake.client().listReceived(), protocolError('http_error', 503));
  assert.equal(fake.calls.length, 2);
});

test('bounded pagination and repeated cursors fail explicitly without an extra request', async t => {
  await t.test('configured page limit', async () => {
    const fake = mockFetch([response({ items: [received()], nextPageToken: TOKEN_A }), response({ items: [], nextPageToken: TOKEN_B })]);
    await assert.rejects(() => fake.client({ maxPages: 2 }).listReceived(), protocolError('pagination_limit'));
    assert.equal(fake.calls.length, 2);
  });
  await t.test('caller may lower the page limit', async () => {
    const fake = mockFetch([response({ items: [], nextPageToken: TOKEN_A })]);
    await assert.rejects(() => fake.client({ maxPages: 3 }).listReceived({ maxPages: 1 }), protocolError('pagination_limit'));
    assert.equal(fake.calls.length, 1);
  });
  await t.test('caller cannot raise the configured cap', async () => {
    const fake = mockFetch([]);
    await assert.rejects(() => fake.client({ maxPages: 2 }).listReceived({ maxPages: 3 }), protocolError('invalid_request'));
    assert.equal(fake.calls.length, 0);
  });
  await t.test('same opaque cursor twice', async () => {
    const fake = mockFetch([response({ items: [], nextPageToken: TOKEN_A }), response({ items: [], nextPageToken: TOKEN_A })]);
    await assert.rejects(() => fake.client().listReceived(), protocolError('pagination_loop'));
    assert.equal(fake.calls.length, 2);
  });
});

test('HTTP 429 is rate_limited and no HTTP status is automatically retried', async () => {
  const fake = mockFetch([response({ message: 'private account quota details' }, 429, { 'retry-after': '30' })]);
  await assert.rejects(() => fake.client().listReceived(), protocolError('rate_limited', 429));
  assert.equal(fake.calls.length, 1);
});

test('already-aborted requests do not fetch', async () => {
  const fake = mockFetch([]), controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fake.client().listReceived({ signal: controller.signal }), protocolError('aborted'));
  await assert.rejects(() => fake.client().getDelivery(MESSAGE, { signal: controller.signal }), protocolError('aborted'));
  await assert.rejects(() => fake.client().reply({ ...REPLY, signal: controller.signal }), protocolError('aborted'));
  assert.equal(fake.calls.length, 0);
});

test('a caller abort terminates even a mock fetch that ignores its signal', async () => {
  const controller = new AbortController();
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const fake = mockFetch([() => { started(); return new Promise(() => {}); }]);
  const pending = fake.client({ timeoutMs: 1000 }).listReceived({ signal: controller.signal });
  await began;
  controller.abort();
  await assert.rejects(() => pending, protocolError('aborted'));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].init.signal.aborted, true);
});

test('timeout remains bounded when the HTTP implementation never settles', async () => {
  const fake = mockFetch([() => new Promise(() => {})]);
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(() => fake.client({ timeoutMs: 15 }).listReceived(), protocolError('timeout'));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.signal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('timeout covers a stalled response body and cancels the reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const fake = mockFetch([new Response(body, { headers: { 'content-type': 'application/json' } })]);
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(() => fake.client({ timeoutMs: 15 }).listReceived(), protocolError('timeout'));
    assert.equal(cancelled, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.signal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('response size limits stop and cancel a streaming response before consuming it all', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode('x'.repeat(128)));
      if (pulls === 32) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const fake = mockFetch([new Response(body, { headers: { 'content-type': 'application/json' } })]);
  await assert.rejects(() => fake.client({ maxResponseBytes: 512 }).listReceived(), protocolError('response_too_large'));
  assert.ok(pulls < 32, 'A byte cap must not read the entire large response first');
  assert.equal(cancelled, true);
});

test('an oversized content-length is rejected without trusting or parsing the body', async () => {
  const fake = mockFetch([response({ items: [] }, 200, { 'content-length': '99999' })]);
  await assert.rejects(() => fake.client({ maxResponseBytes: 512 }).listReceived(), protocolError('response_too_large'));
  assert.equal(fake.calls.length, 1);
});

test('malformed JSON and malformed message/page identity return sanitized protocol errors', async t => {
  const cases = [
    new Response('<html>not JSON</html>', { headers: { 'content-type': 'application/json' } }),
    response({ items: {} }),
    response({ items: [{ id: MESSAGE, projectId: PROJECT, status: 'received', platform: 'imessage' }] }),
    response({ items: [received('not-canonical')] }),
    response({ items: [received(MESSAGE + '\n')] }),
    response({ items: [received(MESSAGE + '\r')] }),
    response({ items: [received(MESSAGE, { projectId: canonical('prj', '1') })] }),
    response({ items: [received(MESSAGE, { status: 'delivered' })] }),
    response({ items: [received(MESSAGE, { platform: 'made-up-platform' })] }),
    response({ items: [], nextPageToken: { opaque: 'not a token string' } }),
    response({ items: [], nextPageToken: 'unsafe\ncontrol' }),
    response({ items: [], nextPageToken: 'x'.repeat(4097) }),
  ];
  for (const [index, body] of cases.entries()) await t.test(`invalid response ${index + 1}`, async () => {
    const fake = mockFetch([body]);
    await assert.rejects(() => fake.client().listReceived(), protocolError('invalid_response'));
    assert.equal(fake.calls.length, 1);
  });
});

test('invalid timestamps and conflicting time filters fail locally; RFC3339 offsets remain literal', async t => {
  for (const [index, bounds] of [
    { createdSince: 'not-a-date' }, { createdSince: '2026-11-08T01:00:00' },
    { createdSince: '2026-02-30T00:00:00Z' },
    { createdSince: '2026-11-08T00:00:00Z\n' }, { updatedSince: '2026-11-08T00:00:00Z\r' }, { updatedSince: '2026-13-01T00:00:00Z' },
    { updatedBefore: '2026-11-08T25:00:00Z' },
    { createdSince: '2026-11-08T00:00:00Z', updatedSince: '2026-11-08T00:00:00Z' },
  ].entries()) await t.test(`invalid time filter ${index + 1}`, async () => {
    const fake = mockFetch([]);
    await assert.rejects(() => fake.client().listReceived(bounds), protocolError('invalid_request'));
    assert.equal(fake.calls.length, 0);
  });
  const fake = mockFetch([response({ items: [] })]);
  const offset = '2026-11-08T01:00:00-06:00';
  await fake.client().listReceived({ updatedSince: offset });
  assert.equal(fake.calls[0].url.searchParams.get('updatedSince'), offset);
  assert.equal(fake.calls[0].url.searchParams.has('createdSince'), false);
});

test('reply acceptance uses the exact text envelope and never treats HTTP 202 as delivery', async () => {
  const accepted = { ...received(), status: 'accepted' };
  const fake = mockFetch([response(accepted, 202)]);
  const result = await fake.client().reply(REPLY);
  assertRequest(fake.calls[0], 'POST');
  assert.equal(fake.calls[0].headers.get('idempotency-key'), REPLY.idempotencyKey);
  assert.equal(fake.calls[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(fake.calls[0].init.body), {
    spaceId: SPACE, senderId: USER, parentMessageId: MESSAGE,
    content: { type: 'text', format: 'plain', text: REPLY.text },
  });
  assert.equal(result.id, MESSAGE);
  assert.equal(result.status, 'accepted');
  assert.equal(result.delivered, false);
  assert.deepEqual(result.message, accepted);
  assert.equal(fake.calls.length, 1);
});

test('reply does not infer delivery from a contradictory 202 response or retry automatically', async () => {
  const fake = mockFetch([response({ ...received(), status: 'delivered' }, 202)]);
  const result = await fake.client().reply(REPLY);
  assert.equal(result.delivered, false);
  assert.equal(fake.calls.length, 1);
});

test('caller retries preserve the same idempotency key and exact payload without automatic POST retries', async () => {
  const fake = mockFetch([response({ error: 'temporary provider failure' }, 500), response({ ...received(), status: 'accepted' }, 202)]);
  const client = fake.client();
  await assert.rejects(() => client.reply(REPLY), protocolError('http_error', 500));
  assert.equal(fake.calls.length, 1);
  const result = await client.reply(REPLY);
  assert.equal(result.delivered, false);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assertRequest(call, 'POST');
    assert.equal(call.headers.get('idempotency-key'), REPLY.idempotencyKey);
  }
  assert.equal(fake.calls[0].init.body, fake.calls[1].init.body);
});

test('delivery status requires an explicit authenticated GET for the exact same message', async () => {
  const delivered = { ...received(), status: 'delivered', providerDetail: { opaque: true } };
  const fake = mockFetch([response(delivered), response({ ...delivered, status: 'dispatched' })]);
  const client = fake.client();
  const confirmed = await client.getDelivery(MESSAGE);
  assertRequest(fake.calls[0], 'GET', `${ROOT}/${MESSAGE}`);
  assert.equal(confirmed.id, MESSAGE);assert.equal(confirmed.status, 'delivered');assert.equal(confirmed.delivered, true);
  assert.deepEqual(confirmed.message, delivered);
  assert.equal((await client.getDelivery(MESSAGE)).delivered, false);
  assert.equal(fake.calls.length, 2);
});

test('status reads reject a mismatched message or project instead of confirming another delivery', async () => {
  for (const body of [received(MESSAGE_2, { status: 'delivered' }), received(MESSAGE, { projectId: canonical('prj', '1'), status: 'delivered' })]) {
    const fake = mockFetch([response(body)]);
    await assert.rejects(() => fake.client().getDelivery(MESSAGE), protocolError('invalid_response'));
  }
});

test('invalid target IDs and absent/unsafe caller keys cannot issue writes or status reads', async t => {
  const badReplies = [
    { spaceId: USER }, { senderId: SPACE }, { parentMessageId: PROJECT },
    { spaceId: SPACE + '\n' }, { senderId: USER + '\n' }, { parentMessageId: MESSAGE + '\n' },
    { spaceId: SPACE + '\r' }, { senderId: USER + '\r' }, { parentMessageId: MESSAGE + '\r' },
    { text: '' }, { idempotencyKey: undefined }, { idempotencyKey: '' }, { idempotencyKey: 'unsafe\nheader' }, { idempotencyKey: 'unsafe-trailing\n' }, { idempotencyKey: 'unsafe-trailing\r' },
  ];
  for (const [index, change] of badReplies.entries()) await t.test(`invalid reply ${index + 1}`, async () => {
    const fake = mockFetch([]);
    await assert.rejects(() => fake.client().reply({ ...REPLY, ...change }), protocolError('invalid_request'));
    assert.equal(fake.calls.length, 0);
  });
  const fake = mockFetch([]);
  await assert.rejects(() => fake.client().getDelivery(SPACE), protocolError('invalid_request'));
  await assert.rejects(() => fake.client().getDelivery(MESSAGE + '\n'), protocolError('invalid_request'));
  await assert.rejects(() => fake.client().getDelivery(MESSAGE + '\r'), protocolError('invalid_request'));
  assert.equal(fake.calls.length, 0);
});

test('provider errors, malformed bodies and network causes cannot expose credentials or message text', async () => {
  const privateText = 'PRIVATE-FICTIONAL-MESSAGE-CONTENT-DO-NOT-EXPOSE';
  for (const [responseOrError, expected, status] of [
    [response({ message: `${KEY}: ${privateText}` }, 400), 'http_error', 400],
    [response({ message: `${KEY}: ${privateText}` }, 429), 'rate_limited', 429],
    [new Response(`not-json:${KEY}:${privateText}`, { headers: { 'content-type': 'application/json' } }), 'invalid_response', undefined],
    [new Error(`network failure Authorization: Bearer ${KEY}; body=${privateText}`), 'network_error', undefined],
  ]) {
    const fake = mockFetch([responseOrError]);
    await assert.rejects(() => fake.client().listReceived(), error => {
      protocolError(expected, status)(error);
      assertRedacted(error, [KEY, privateText]);
      return true;
    });
    assert.equal(fake.calls.length, 1);
  }
});


test('explicit SMS listing keeps the SMS mode and preserves unknown SMS content without substitution', async () => {
  const sms = received(MESSAGE, {
    platform: 'sms',
    content: { type: 'future.sms-observation', payload: { text: 'Fictional SMS fixture', opaque: true } },
    providerExtension: { protocol: 'sms', verified: false },
  });
  const fake = mockFetch([response({ items: [sms] })]);
  const result = await fake.client().listReceived({ platform: 'sms' });
  assert.equal(result.platform, 'sms');
  assert.deepEqual(result.items, [sms]);
  assert.equal(result.items[0].platform, 'sms');
  assert.equal(result.items[0].caseId, undefined);
  assert.equal(fake.calls.length, 1);
  assertRequest(fake.calls[0], 'GET');
  assert.equal(fake.calls[0].url.searchParams.get('platform'), 'sms');
});

test('SMS reply acceptance and explicit delivery reads report the actual SMS response platform', async () => {
  const accepted = received(MESSAGE, { platform: 'sms', status: 'accepted' });
  const delivered = { ...accepted, status: 'delivered' };
  const fake = mockFetch([response(accepted, 202), response(delivered)]);
  const client = fake.client();
  const queued = await client.reply(REPLY);
  assert.equal(queued.platform, 'sms');
  assert.equal(queued.message.platform, 'sms');
  assert.equal(queued.delivered, false);
  const confirmed = await client.getDelivery(queued.id);
  assert.equal(confirmed.platform, 'sms');
  assert.equal(confirmed.message.platform, 'sms');
  assert.equal(confirmed.delivered, true);
  assert.equal(fake.calls.length, 2);
  assertRequest(fake.calls[0], 'POST');
  assertRequest(fake.calls[1], 'GET', `${ROOT}/${MESSAGE}`);
});

test('unsupported or guessed platform modes fail locally instead of falling back to iMessage', async () => {
  for (const platform of ['SMS', 'mms', 'sms-or-imessage', 'auto']) {
    const fake = mockFetch([]);
    await assert.rejects(() => fake.client().listReceived({ platform }), protocolError('invalid_request'));
    assert.equal(fake.calls.length, 0);
  }
});

test('an explicit SMS listing rejects an iMessage response and never silently retries another mode', async () => {
  const fake = mockFetch([response({ items: [received(MESSAGE, { platform: 'imessage' })] })]);
  await assert.rejects(() => fake.client().listReceived({ platform: 'sms' }), protocolError('invalid_response'));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url.searchParams.get('platform'), 'sms');
});
