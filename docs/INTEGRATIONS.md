# Integration boundary and next gates

## Safe default

The app remains an offline fictional exercise. Photon 2 and Nemotron protocol clients are present in `src/`, but the server does not instantiate or import them. They make no startup request, read no environment variables, and are disabled by default. No provider webhook, polling worker, remote extraction job or public deployment is enabled. The only HTTP listener is loopback; existing environment placeholders are not consumed. The trained satellite classifier continues to run locally on CPU.

The next milestone can implement providers behind small adapters without changing domain semantics:

```js
// Provider inbound event, after authenticity verification:
{ providerEventId, senderId, caseId, text, observedAt }

// Extractor result, validated before use:
{ observations: [{ type, summary, sourceSpan, quantity, location, verification: 'reported' }], reviewFlags: [] }
```

Keep observed time, provider receipt time, and app processing time distinct. A provider's sent/delivered status must never verify location or welfare. Map external phone identifiers into consented participants on the server only. Unknown or ambiguous case links need clarification instead of guessing.

## Photon

1. Verify current Photon SMS product/API, SDK or HTTP contract, webhook authentication, message IDs, opt-out requirements, sender availability, delivery event shape, and account quotas from official documentation/account setup.
2. Confirm a consenting sender/recipient pair, exact data/message purpose, and total spend cap. Do not assume $100 of credits authorizes any particular send or overage.
3. Only then have the user privately enter the required credentials into `.env`. Never log or return them; never expose them via `/api/state` or browser bundles.
4. Add a live adapter behind an explicit off-by-default gate, outbound allowlist, per-run send cap, idempotent outbox status, and replay-safe webhook authentication. Test with fixture payloads first.
5. Complete one real SMS → stored raw event → validated extraction → officer queue → SMS reply. Preserve provider IDs and measured latency without leaking contacts.

## Nemotron

The planning page recommends `nvidia/nemotron-3.5-lightning-30b-a3b` for text and `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` for images, with `nvidia/nemotron-3.5-super-vl-120b-a12b` as an optional harder-case fallback. Model availability and free quotas must be rechecked before use. None are called here.

Use synthetic/deidentified text and damage-only images. Person photos must stay out of free-trial inference. Validate output against allowed observation types and source spans. Cap output/retries, retain failures, and never let model output perform database writes, close cases, dispatch help, or declare an area safe.

## Custom satellite model handoff

Training is an independent workstream. Integrate only an evaluated artifact with provenance: exact architecture/config, input channel order and normalization, class mapping, held-out split, metrics, limitations, model hash/version, and inference example. Expected output should remain an **estimated visible damage** observation with timestamp, input imagery reference, and an uncertainty/not-assessable option. Do not derive safety, occupancy, casualty counts, or person status from satellite damage. UI and evidence store can add damage estimates without altering the family case state machine.

The local implementation uses a random-initialized six-channel EfficientNet-B0 on aligned pre/post RGB crops and known building boxes. Import is checksum-verified, never executes code from the bundle, and verifies a real CPU prediction against the cached held-out output before enabling the browser's local inference action. The browser accepts only bundled tile/building IDs, never paths or shell commands. Historical Harvey imagery and estimated damage remain visibly separate from the fictional family exercise; reference labels are not presented as model output.


## Inactive provider clients · November 8 preparation

The owner requested Photon and NVIDIA Brev connection for a real feature test. Authentication and test-scope approval are separate from the following fixture-tested preparation. These modules do not enable live integration by being present, and setting existing environment placeholders does not activate them. The app still reports Photon not connected, simulated text extraction and live sending disabled.

### Photon 2 / Beta

`src/photon-client.js` uses native Node fetch and the fixed `https://api.photon.codes/v1` origin. It requires explicit boolean enablement, a canonical Beta project ID and project-scoped key. It supports bounded received-message pagination, replies with a caller-supplied stable idempotency key, and explicit delivery reads. `202` reply acceptance remains `delivered:false`; delivery can be reported only after the status read. Limits cover timeouts, aborted or stalled bodies, response bytes and pagination. Errors discard provider bodies and native diagnostics. There are no automatic retries, generated replacement keys or background loops.

`listReceived()` defaults to the prepared iMessage path, but an explicit `platform:'sms'` stays SMS. Returned envelopes expose the actual platform. This does not fulfill the original real-SMS acceptance criterion: ordinary US SMS requires the provider's approved 10DLC setup. An owner-initiated shared iMessage test is a separate possible test path. Account/project/channel capability must be verified after authentication. Stable Spectrum credentials and APIs are a different product contract.

A future bridge must provide the approved time window, overlap eventually consistent polls, retain canonical inbound IDs and outgoing idempotency keys durably, map only explicitly permitted identities, enforce consent/STOP before any send, and preserve unknown content for review. The protocol client deliberately supplies none of these application policies and must not be run as an autonomous agent. Local REST polling can avoid exposing the loopback app through a public webhook. See [official Beta quickstart](https://photon.codes/docs/beta/get-started/imessage), [OpenAPI](https://api.photon.codes/openapi.json), [retry contract](https://photon.codes/docs/beta/api-client/retries-and-timeouts) and [SMS requirements](https://photon.codes/docs/beta/messaging/sms).

### Nemotron text proposals

`src/nemotron-client.js` prepares a bounded request for Lightning and validates proposal JSON. The default endpoint is NVIDIA's hosted `/v1`; an explicitly allowed loopback forward supports a Brev-hosted NIM and its served-model alias. No arbitrary remote endpoint, redirect, environment discovery or automatic retry is accepted. Synthetic-input declaration, input/output limits, timeout/cancellation, and generic errors are enforced. Consent commands avoid model calls. JSON content must be complete; reasoning-only, tool-call, malformed or truncated output is rejected.

Accepted proposals use exact source spans, canonical summaries, reported verification and mandatory human review. Conservative English fixture checks bind named sightings to current-case subjects and reject possessions/media/questions and mismatched categories. Counts and locations must belong to the actual asserted clause. Negation/correction cannot become a positive proposal. Unsupported phrasing fails to raw human review; this is not a claim of general semantic validation or measured Nemotron extraction quality.

The caller must persist raw input first and enforce case references, consent, duplicates, observation time and approved spend before inference. An inactive raw inbox module now persists synthetic source reports before separately claimed asynchronous proposal work. No configured runner or provider transport is started by the server. No proposal is applied to cases, assistance, welfare or an outbox by this module. Live response-format compatibility and a synthetic quality suite must be proven after authentication. [Lightning build contract](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build), [NIM Lightning mode](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html).

Brev is GPU infrastructure, not the same credential as NVIDIA's hosted model API. A NIM deployment needs the selected supported GPU/profile, VM setup, NGC pull credentials and a private local forward. No instance has been provisioned for this preparation. [Brev NIM guide](https://docs.nvidia.com/brev/guides/inference-deployment/deploying-nims).

### Validation and remaining acceptance

Both protocol suites use injected mock transports only. They prove parsing, bounds, failure handling, literal-span/category checks and inactive defaults; they do not prove account access, model quality, message receipt/delivery, quotas or provider latency. The existing family workflow and saved exercise remain unchanged. A real run still needs the intended account/project, consenting test identity, exact purpose/content and spending limit required above.


## Raw inbox and local UI preparation · November 8

`src/report-inbox.js` captures synthetic raw reports and coordinates an injected extractor outside Store transactions. Durable leases, opaque claim tokens and source/case-subject hashes reject expired or changed-source completions. Canonical Nemotron output is revalidated before it becomes an unaccepted proposal. Failures retain the original report. There is no default client, provider intake route, startup worker, acceptance action, automatic retry, outgoing reply or paid call. The caller still owns recipient/data/consent and budget checks.

The browser can display queued, running, failed and proposed report states through the local committed-state stream. These states were exercised with an injected fictional extractor only. Live Nemotron compatibility, extraction quality and the human acceptance workflow remain open. The message lab continues to use its clearly labeled scripted extractor.
