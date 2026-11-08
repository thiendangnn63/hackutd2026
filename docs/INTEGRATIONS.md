# Beacon integrations

## Ordinary app and optional phone test

`npm start` serves a local fictional exercise. The message lab uses its scripted parser and simulated outbox. The optional trained satellite classifier runs on local CPU. The separate `demo:phone` launcher can enable one scoped Photon iMessage exchange and hosted Nemotron text interpretation. It requires an approved private configuration and both credentials. Both launchers serve only loopback. [Phone demo setup and limits](PHONE_DEMO.md) · [API contract](API.md)

## Local presenter rehearsal

`npm run demo` serves the full phone-to-officer workflow using a fictional sender, simulated delivery and the local `local_demo_rules` interpreter. Captures, proposal validation and human decisions follow the same report pipeline as the optional phone integration. Rehearsal data lives under `.data/rehearsal/`. **Reset exercise** restores its fictional state and clears its transport journal. No keys, external model or GPU are needed. [Presenter walkthrough](DEMO.md)

Human acceptance publishes reported facts. The separate **Track water assistance** action requires an accepted water observation from the current case and a reviewer note. It reuses the existing task on retry. Welfare verification and assistance completion have independent status.

## Photon Beta iMessage

The owner initiates a direct conversation from the iPhone identity assigned to the shared line. The local bridge polls a bounded time window on the fixed Photon Beta origin. It verifies project, channel, human sender, receiving agent and direct space against the private mapping. One fictional participant on case C104 receives the mapped report. The registry checks the case fingerprint and exact approved synthetic wording. Unmatched and conflicting messages are quarantined privately. Provider timestamps establish receipt history; observation time may remain unknown. [Photon Beta quickstart](https://photon.codes/docs/beta/get-started/imessage) · [Provider API](https://api.photon.codes/openapi.json)

The bridge journals the envelope before capture and deduplicates by project, channel and message ID. Exact STOP revokes consent. CHECKIN requests enrollment review. Replies need a separate, explicit approval for fixed wording and a separate send action. The backend rechecks the route, source, consent, window and budget at send time. The parent is the captured incoming message and the reply sender is its receiving agent. Photon acceptance remains pending delivery until an explicit status read confirms it. The simulated outbox has no dispatch path. The demo does not establish carrier SMS capability; ordinary US SMS requires approved 10DLC provisioning. [Photon retry semantics](https://photon.codes/docs/beta/api-client/retries-and-timeouts) · [SMS requirements](https://photon.codes/docs/beta/messaging/sms)

## Nemotron text proposals

The phone launcher configures hosted `nvidia/nemotron-3.5-lightning-30b-a3b` at NVIDIA’s inference endpoint. The inbox saves the source before invoking the model. A claim binds work to the current source, including the linked case subjects. The job reserves its request within the approved cap. Validation requires a complete response, exact source spans, supported observation types and consistency with the asserted person, quantity and location. Incomplete, stale or unsupported output leaves the raw report available for review. The evidence checks cover supported synthetic phrasing; fixture success does not measure live model quality. [Hosted model](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b)

A human review decision binds selected observations to the displayed proposal token and current source. Acceptance records reported evidence. Dismissal retains the original message and decision. Neither action verifies welfare, creates assistance tasks or sends messages. The phone test runs without GPU provisioning, paid inference or a public webhook. Its monetary scope is $0 paid spend and it requires a free hosted allowance.

## Historical water-signal comparison

The amber map layer compares georeferenced Sentinel-2 MNDWI products. A fixed 0–100+ legend shows the mean positive change across jointly observed pixels. The baseline is August 15, 2017; observed coverage differs between the August 30 and September 1 comparisons. Gaps remain unknown. Red still shows fictional assistance demand, and blue/cyan flood imagery has its own dated sources. The separately trained building-damage classifier operates on known crops. [Presenter guide](DEMO.md#reading-the-impact-layers)

## Local satellite classifier

The independently trained six-channel EfficientNet-B0 classifies aligned before/after RGB crops of known buildings. Checkpoint import verifies its checksum and a local CPU prediction before enabling browser inference. The family exercise, Houston historical map imagery and xBD building crops retain separate provenance. The classifier estimates visible building damage; occupancy, welfare and flood extent are outside its output contract. [Model card](MODEL_CARD.md)
