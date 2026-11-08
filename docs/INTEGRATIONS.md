# Integration boundary and next gates

## Safe default

This milestone intentionally has **no network client, Photon SDK, provider webhook endpoint, remote model client, or public deployment**. The only HTTP listener is loopback. The environment template is ready, but secret values are not consumed. Optional satellite inference runs locally on CPU. This keeps environment setup and rehearsals free of API spend.

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
