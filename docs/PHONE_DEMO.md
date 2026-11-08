# Text Beacon from an iPhone

Use one consenting iPhone sender, one Photon Beta shared iMessage assignment and fictional case C104. Beacon polls Photon from the local machine. The sender uses Messages on their phone and the reviewer uses Casework on the computer. The normal `npm start` launcher keeps provider access off.

## Set up the test

1. Confirm the sender shown under iPhone **Settings → Apps → Messages → Send & Receive** matches the identity assigned in Photon. The owner starts the direct conversation. The demo uses iMessage. A carrier SMS test requires separate sender provisioning. [Photon shared iMessage setup](https://photon.codes/docs/beta/get-started/imessage)
2. Confirm the assigned line and hosted NVIDIA Lightning access are covered by the account’s free allowance. The approved paid spend is **$0**. Use the hosted endpoint without launching a Brev VM or GPU. Stop if the service requires a paid resource. Request caps limit API attempts, but they cannot enforce provider pricing. [Photon plans](https://photon.codes/docs/beta/plans-and-billing) · [NVIDIA hosted Lightning](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b)
3. Copy the placeholder config to the ignored `.data/phone-demo.json`. Fill its scope, single identity mapping and reply approval locally. Bind the canonical project, human sender, receiving agent and direct space to an opted-in fictional participant on C104. Use an absolute test window of at most one hour, an exact allowlist of synthetic inbound wording and one fixed response approved by the owner. Set `approved` to true only for that scope. Keep private config and keys out of Git, screenshots and shared logs. [Config template](PHONE_DEMO_CONFIG.example.json)
4. Set `PHOTON_API_KEY` and `NVIDIA_API_KEY` privately in the local environment. Photon requires a project-scoped key with read and write permissions. Use the same local saved exercise and stop its normal server first. Run the following from the project directory.

```sh
npm run demo:phone -- --config .data/phone-demo.json
```

Open [Casework](http://127.0.0.1:4173/#casework) and expand **Phone & Nemotron**. The test server binds only to loopback port 4173. Startup validates the configuration and credentials’ presence. A **configured** label alone does not verify provider authentication or a delivered message.

## Run one exchange

1. Within the approved window, send the exact allowlisted fictional report from the assigned iMessage identity. Use **Check phone** for a single poll or **Listen** for bounded polling. Each Listen runs at most 10 polls. A scope permits at most 20 polls across restarts. Stop listening ends that loop.
2. A matching message is saved before inference. Polling can submit a newly queued report to hosted Nemotron; **Interpret with Nemotron** explicitly runs an eligible report still queued. The model receives approved synthetic text and fictional case context. The scope allows up to three model requests. Unapproved content and ambiguous identities are held privately. A failed interpretation leaves the captured original available.
3. Select the report and choose **Open report for review**. Read the original message and compare each proposed observation to its source quote. Enter a reviewer name and note, then accept selected observations or dismiss the proposal. Acceptance records what the sender **reported**. Welfare verification, assistance status and outreach remain separate decisions.
4. Review the displayed fixed reply. Click **Approve demo reply**, then **Send approved reply**. No interpretation or review action sends a reply. An accepted send still needs **Check delivery** before the app can mark it delivered. Confirm receipt on the phone. If the outcome is unknown, an explicit retry reuses the original idempotency key. A known failure is terminal. The private journal allows at most two send attempts including retries and four delivery checks.
5. An exact **STOP** revokes outreach consent, stops listening after capture, and blocks replies. **CHECKIN** goes to enrollment review. Neither command verifies welfare or starts a model job.

## Restart and audit

Stop the test server normally before returning to `npm start`. There is no public webhook, automatic startup poll or forwarding of the simulated outbox. The family exercise is saved to `.data/state.json`. The private `.data/phone-provider-ledger.json` has owner-only permissions (0600) and stores provider envelopes, identity bindings, request reservations and reply keys. The HTTP status exposes counters, local report IDs and delivery state.

An ordinary restart preserves reservations and deduplication. Listening must be started explicitly again. An interrupted send may have reached Photon even when no acknowledgment was saved. Only an explicit retry within the existing scope and budget can send it again. Do not delete the private ledger to reset a budget. If an unclean exit leaves a phone lock, verify the recorded process has exited before removing that stale lock. Keep the state and ledger files. The family Store and ledger use separate file replacements. There is no transaction across those files or power-loss durability guarantee.
