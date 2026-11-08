# Beacon project structure and agent handoff

This guide explains how to work on Beacon without mixing its independent exercises, data sources or integration permissions. The source inventory was checked against commit `d42d438`. Read [AGENTS.md](../AGENTS.md) and [README.md](../README.md) before changing behavior; [API.md](API.md) is the detailed frontend/backend contract.

**Current integration status:** the optional phone and hosted-model integration is implemented and covered by local fixture tests. Account-specific hosted NVIDIA inference and real-message delivery remain unverified. The owner stopped provider setup before a live end-to-end exchange. A configured runtime, passing mock test, accepted provider request and confirmed delivery are different results; do not label this app connected on that basis. See [VERIFICATION.md](VERIFICATION.md) and [PHONE_DEMO.md](PHONE_DEMO.md) for recorded evidence and the approved operating procedure.

## 1. What runs here

Beacon is a dependency-free Node.js 22+ local demonstration with browser-native ES modules. There is no frontend build, JavaScript framework, database server or package installation required for the ordinary rehearsal. Optional local building-image inference uses a separately prepared Python environment and model bundle.

Three launchers use the same HTTP application and browser shell:

| Command | Entrypoint | Saved state | Phone / interpretation behavior |
| --- | --- | --- | --- |
| `npm run demo` | `src/rehearsal-server.js` | Its own `.data/rehearsal/` exercise and simulated transport journal | Fictional inbound composer, local rules interpreter, simulated reply and delivery. No provider credentials, requests or GPU. |
| `npm start` | `src/server.js` | `.data/state.json` | Original family exercise. Message lab extraction and outgoing messages are simulated. Phone controller is offline. |
| `npm run demo:phone -- --config .data/phone-demo.json` | `src/phone-server.js` | The same `.data/state.json` plus a separate private provider ledger | Explicitly approved Photon Beta iMessage polling and hosted NVIDIA interpretation, with separate reply approval/send/delivery actions. |

`npm run dev` watches the original server; it uses the same saved exercise as `npm start`. It is not the rehearsal launcher. `npm run demo -- --port 4178` can run an isolated rehearsal beside the original exercise. The approved phone launcher requires port 4173 and the normal server must be stopped first. Do not run concurrent writers against the same saved exercise.

Every launcher binds to `127.0.0.1`. The default presentation URL is `http://127.0.0.1:4173/#mayor`. UI role labels are demonstration controls, not authentication. Do not publish this server or add a public tunnel as a shortcut to receiving messages.

## 2. Read the repository by responsibility

The tree below groups the important files by execution role. Directory names are literal; comments identify what an agent should change there.

```text
.
├── AGENTS.md                         Owner rules and completion checks
├── README.md                         Setup, feature boundaries, model import
├── package.json                      Launch and validation commands; ES modules
├── .env.example                      Credential names only; no working keys
│
├── src/
│   ├── server.js                     HTTP application, static allowlist, SSE, routes
│   ├── store.js                      Atomic exercise persistence and revision events
│   ├── public-state.js               Public projection of stored family state
│   ├── domain.js                     Original fictional family exercise and policies
│   ├── report-inbox.js               Raw capture, extraction jobs, human review,
│   │                                 separate accepted-need assistance action
│   ├── rehearsal-server.js           Zero-credential presenter launcher
│   ├── rehearsal.js                  Isolated simulated transport and replay/reset
│   ├── demo-extractor.js             Honest local stand-in for text interpretation
│   ├── phone-server.js               Explicit approved live-test bootstrap
│   ├── phone-runtime.js              Bounded operator phone controller
│   ├── photon-client.js              Photon Beta HTTP protocol; inert by default
│   ├── photon-inbox.js               Private identity/scope checks and durable capture
│   ├── provider-ledger.js            Private receipt, budget and reply journal
│   ├── nemotron-client.js            Hosted text protocol and grounded validation
│   ├── nemotron-jobs.js              Durable request reservations and authorization
│   ├── photon-replies.js             Fixed-reply approval, send and delivery checks
│   ├── houston.js                    Independent fictional request aggregation
│   ├── houston-service.js            Validated Houston files, placements, raster registry
│   ├── historical-imagery.js         Dated product validation and local asset registry
│   └── satellite.js                  Imported xBD bundle and optional local CPU inference
│
├── public/
│   ├── index.html                    Shared page shell, controls and accessible labels
│   ├── styles.css                    Base styles for original app / casework content
│   ├── workspace.css                 Map workspace, navigation and visual presentation
│   ├── app.js                        Casework forms/actions, phone panel, model panel
│   ├── workspace.js                  Hash routing, Messages, People, archive workspace
│   ├── state-client.js               Shared ordered HTTP/SSE family-state cache
│   ├── records.js                    Pure record indexes, search and message matching
│   ├── record-focus.js               Stable record/action focus restoration
│   ├── form-drafts.js                Page-only drafts and case-scoped field restoration
│   ├── proposal-view.js              Raw-source / proposal / human decision presentation
│   ├── phone-view.js                 Rehearsal or approved phone operator controls
│   ├── archive-view.js               Known historical pair comparison and image recovery
│   ├── ui.js                         Small DOM, SVG, icon and formatting primitives
│   ├── houston.js                    Geographic map controller and user interaction
│   ├── map-model.js                  Pure geometry, camera, partitioning and planning data
│   ├── imagery-model.js              Pure visible reference-tile / tier selection
│   ├── imagery-layer.js              Bounded progressive local raster loading
│   ├── historical-layer.js           Dated optical / NOAA / radar imagery lifecycle
│   ├── labels-model.js               Pure street/landmark clipping, labels and search
│   ├── reference-layer.js            Local geographic reference loading/rendering
│   ├── map-coverage.js               Pure observed-pixel coverage queries and date suggestions
│   ├── observation-view.js           Optical coverage caption and explicit recovery action
│   ├── impact-model.js               Pure paired water-index change grid and coverage
│   ├── impact-layer.js               Batched amber SVG layer and metadata lifecycle
│   ├── beacon-logo.svg / favicon.svg Authored vector branding
│   └── data/                         Reviewed public geography, imagery and provenance
│
├── scripts/                          Offline asset preparation, import and checks
├── training/                         Reproducible xBD training / local inference code
├── test/                             Node regression tests and Python asset/import checks
└── docs/                             Contracts, provenance, operation and verification
```

There is deliberately no catch-all static directory route. New browser modules or data paths need an exact entry in `src/server.js`, or a bounded manifest-backed reader. Adding a file under `public/` alone does not necessarily make it available over HTTP.

## 3. Shared state, private state and page memory

### Exercise Store

`src/store.js` owns the exercise JSON. `Store.act(action, ...args)` delegates to `domain.applyAction`, which applies the action to a clone. A thrown action cannot partly mutate the committed state. `save()` writes a temporary JSON file and renames it before replacing the in-memory value and notifying observers. Exercise files are written with owner-only file permissions. A corrupt existing file is reported rather than silently overwritten with fixtures.

The main collections are `participants`, `cases`, `reports`, `assistance`, `outbox` and `audit`. Separate case fields represent location, welfare, review and outreach. They are not aliases for one overall status.

Each Store process has a fresh session UUID and increasing in-memory revision starting at zero. They are transport ordering metadata, not a disk schema migration. `version`, `readVersioned()` and `onChange()` support the HTTP/SSE integration. Subscribing and reading do not rewrite the exercise. Observer errors cannot fail a successfully committed action.

### Public state boundary

`src/public-state.js` projects all state JSON returned by family mutation endpoints and `/api/state`, and all SSE snapshots. It removes private provider identity and extraction claim/source material. The public `modelReview` envelope includes the permitted status, validated proposal, extractor source, proposal token and human decision fields; it does not expose the private claim token, source hash or source snapshot.

Raw report text and exact source quotations are intentionally retained for human review. The projection is not a general personal-data anonymizer. The approved phone bridge must map a consented test identity to fictional fixture records before capture. Do not put a real contact, provider handle, credential or private mapping into ordinary case fields and assume the projection will recognize it.

### Private provider journal

`src/provider-ledger.js` persists provider identity mappings, raw receipts, polling progress, request budgets, model reservations and reply jobs separately from the family Store. The live journal is ignored by Git and uses owner-only file permissions. It is never returned by public state or SSE.

Rehearsal uses its own journal under `.data/rehearsal/` and rejects an accidentally injected ledger containing live mappings or jobs. Rehearsal reset clears only that isolated exercise and simulated transport state. A live ledger is not a disposable cache: deleting it can discard duplicate protection and budget/send history.

Store and ledger replacements are separate operations, not a distributed transaction or a power-loss durability guarantee. Receipt states and recovery checks exist to handle interrupted work; preserve both files for audit and restart.

### Browser-only memory

`form-drafts.js`, `record-focus.js`, `proposal-view.js` and `workspace.js` preserve the current page's drafts, disclosure state, selections, caret/focus and reading position across background rebuilds. That memory creates no new evidence or durable case state. Reset clears the relevant page drafts. Do not use it as a second persistence layer.

## 4. Family reports: capture, interpretation, review and action

There are two intentional incoming-report paths. Avoid replacing one with the other without reviewing their different effects.

### Original message lab

`POST /api/reports` calls `domain.receiveReport()`. This is the older, explicitly simulated exercise parser. It recognizes scripted observations, can update the exercise's unverified location state, queue simulated family messages and create the original simulated water task. Its outputs are not claims that Nemotron ran. `domain.extractSimulated()` is not a provider adapter.

### Raw inbox used by rehearsal and the phone bridge

```text
simulated composer OR scoped Photon inbound poll
    → durable original receipt / raw report
    → queued extraction job, observations still []
    → claim bound to current source + case subjects
    → local_demo_rules OR nvidia_nemotron
    → source-grounded validated proposal, observations still []
    → human accepts selected observations OR dismisses
    → accepted observations are reported evidence only
    → separate human actions: track accepted water need / verify welfare / approve reply
```

`src/report-inbox.js` contains the shared core:

- `captureRawReport()` preserves the original text, canonical provider event identity and receipt/observation timing. Duplicate events do not create repeated effects. An unknown observation time stays unknown.
- Exact `STOP` revokes the known fixture alias's consent deterministically. `CHECKIN` goes to enrollment review. Neither starts inference or verifies welfare.
- `claimReportJob()`, `completeReportJob()`, `failReportJob()` and `runReportJob()` manage bounded external work without awaiting inside a Store mutation. Jobs bind to the source snapshot and linked case subjects; changed sources cannot publish a stale result. Failure retains the raw report.
- `validateExtraction()` in `nemotron-client.js` validates supported observation types, exact source spans, quantities, locations and subject grounding. Model-supplied instructions, IDs, verification claims or unsupported positive assertions do not become domain facts. The supported English fixture grammar is conservative; passing these checks is not a general language-quality benchmark.
- `acceptReportProposal()` / `dismissReportProposal()` require reviewer name, note and the displayed `expectedProposalToken`. Acceptance rechecks the current source and proposal and allocates server observation IDs. A selected nonempty subset may be accepted. It links the report to the case once, with every observation marked `verification:'reported'`. Dismissal retains the original and decision. Exact decision replays are idempotent; conflicting/stale decisions reject without hidden domain effects.
- `trackReportedAssistance()` is a different explicit human action. It requires a canonical accepted `water_need` on the current linked case plus a reviewer note, and creates or reuses one unassigned task. It does not mark that task delivered/completed or change welfare.
- `domain.verifyCase()` remains the separate demo-officer decision with selected sighting evidence and a meaningful direct-confirmation note. It records location/welfare verification and stops the exercise search. An open assistance task can remain after a case is resolved for welfare.

The proposal token is a public read-only fingerprint of the displayed source-bound proposal, not a private job credential. Never substitute a claim token for it. A provider acceptance/delivery receipt is not evidence that a person is safe or assistance arrived.

## 5. Rehearsal and live-test integration boundaries

### Local presenter rehearsal

`rehearsal-server.js` constructs the Store, isolated journal and `createRehearsalRuntime()`, then injects the runtime into `createApp()`. It does not load credentials or instantiate provider clients. A lock protects the rehearsal files from a second rehearsal process.

`rehearsal.js` supports `message`, `duplicate`, `correction` and `stop` scenarios. Duplicate reuses the saved prior envelope/message ID rather than inventing another event. Its default fictional subject is the C104 exercise. The editable composer calls only `/api/phone/simulate`; it does not access an external inbox. The local counter permits up to 100 interpretations per rehearsal, with no remote quota or one-hour live window. STOP blocks further interpretations/replies until an explicit exercise reset.

`demo-extractor.js` implements the local rules stand-in. Runtime/report metadata says `extractorSource:'local_demo_rules'`. UI copy must continue to distinguish it from `nvidia_nemotron`. Simulated reply records use `kind:'rehearsal_reply'` and `status:'simulated'`, allowing Messages to display the rehearsal conversation honestly.

### Explicit provider launcher

`phone-server.js` validates the approved private config before inspecting the credential values. It constructs the live clients and injects `createPhoneRuntime()` only through the explicit phone launcher. Merely setting keys cannot activate providers in `npm start` or `npm run demo`. Importing the client/launcher modules does not poll, send or call a model.

The configuration template is [PHONE_DEMO_CONFIG.example.json](PHONE_DEMO_CONFIG.example.json); the operating procedure is [PHONE_DEMO.md](PHONE_DEMO.md). Keep working configuration in ignored local storage, not in this guide. Credential names are `PHOTON_API_KEY` and `NVIDIA_API_KEY`. Do not copy values, real recipients or provider IDs into repository documentation, fixture data, browser screenshots or logs.

Current live-test contract:

| Boundary | Enforced scope |
| --- | --- |
| Transport | Photon **Beta** API on its fixed official HTTPS origin; the app's approved launcher selects iMessage, not carrier SMS. Do not merge legacy Spectrum/Stable contracts into this client. |
| Identity | One explicit project/channel/human/receiving-agent/direct-space mapping to a consented fictional fixture and case. Exact approved synthetic wording and case fingerprint are checked. Unmatched/conflicting messages are quarantined privately. |
| Time | Explicit absolute approved window, at most one hour. Startup does not automatically poll. |
| Polls | Operator Check phone or Listen; at most 10 polls per Listen and 20 per scope across restarts. |
| Text model | Fixed hosted `nvidia/nemotron-3.5-lightning-30b-a3b`; durable cap at most 3 requests per approved scope, including interrupted attempts. No automatic model retry. |
| Reply | Fixed approved wording tied to the captured inbound parent. Prepare, Send and Check delivery are different operator actions. At most 2 send attempts including explicit retry, and 4 delivery checks. |
| Money / compute | Approved paid spend is $0 using confirmed free allowances. No Brev VM/GPU provisioning is part of these launchers. Caps bound attempts, not a provider's pricing; do not expand scope because a key is present. |

`photon-client.js` handles bounded HTTP responses, timeout/abort, canonical IDs, pagination and idempotency keys. `photon-inbox.js` verifies scope, direct-message shape and identity, journals before capture, and deduplicates receipts. `nemotron-jobs.js` reserves the durable request budget before inference and rechecks source, consent, identity and journaled STOP immediately before invocation. Reservations survive restart; a failed reservation produces no model call.

`photon-replies.js` is a separate pipeline from extraction and human proposal acceptance. It persists a stable reply key before dispatch, rechecks the approved route/source/consent/window/budget, and preserves ambiguous outcomes. A send acceptance is not delivery. Unknown sends may be explicitly retried with the same idempotency key within the cap; a known failure is terminal. The simulated domain outbox has no general dispatch loop.

`phone-runtime.js` exposes redacted status and bounded operator methods. `phone-view.js` renders it without provider keys or private identities. Live reset does not clear the provider ledger to replenish budgets. No public webhook, background auto-forwarder or automatic startup listener exists.

**Budget namespace matters.** Poll and model reservations are keyed by a fingerprint of the approved scope. Changing its ID, project, receiving agent, platform, time window or limits creates a different namespace; this is not an owner-wide lifetime spending cap. Reply send/delivery caps aggregate reply jobs in the same ledger. Never delete the ledger or roll the scope to replenish the owner's overall budget. Any already used preflight/provider attempts must be counted when setting the remaining authorized runtime allowance. Keep working counters private; this document states code limits, not a live account balance.

### Stop, switch launchers and recover

Use `Ctrl+C` in the launcher terminal. Phone and rehearsal launchers handle SIGINT/SIGTERM by stopping new work, aborting/draining runtime operations, closing HTTP/SSE connections and releasing their own lock. Closing the browser tab alone does not stop a listener. A restart does not automatically resume listening or reset the live request journal.

Stop the existing process before switching between `npm start` and the phone launcher. Use another port only for the isolated rehearsal. After an unclean exit, confirm the original process has actually stopped before removing a stale lock; do not delete saved state or a private ledger to bypass a lock, ambiguous reply or exhausted scope. Reset exercise is an explicit UI operation with mode-specific behavior, not a substitute for shutting down a process.

## 6. HTTP and browser state flow

`createApp(store, satellite, houston, {phone})` in `src/server.js` is the shared testable HTTP factory. Tests inject in-memory Stores and fake runtimes/services. The server enforces loopback Host and same-origin rules, JSON-object mutations, bounded bodies and a restrictive same-origin content security policy. See [API.md](API.md) for exact payloads and status codes.

Important route groups:

| Route group | Owner / purpose |
| --- | --- |
| `/api/state`, `/api/events` | Public projected family state, revision headers and committed-state SSE |
| `/api/cases`, case outreach/verify, participant consent, `/api/reset` | Original family domain actions / active runtime reset contract |
| `/api/reports`, report review and assistance | Simulated message-lab intake or explicit human proposal/need decisions |
| `/api/phone/status`, simulate/listen/stop/poll, report interpret/reply actions | Injected phone runtime; ordinary app is offline |
| `/api/houston`, `/api/houston/imagery`, `/api/houston/history` | Independent map fixtures and local historical metadata |
| `/api/satellite`, registered image reads, `/api/satellite/infer` | Imported historical model evidence and optional local inference |
| Exact static and manifest-listed asset reads | Local browser modules, reviewed map data and imagery; no arbitrary file/URL proxy |

SSE is a native `message` stream with `{sessionId, revision, state}` and event ID `sessionId:revision`. A new subscriber receives the current snapshot and subsequent committed changes from the same Store. Heartbeats and bounded backpressure handle slow/closed readers. State HTTP responses retain their ordinary JSON bodies and add `X-Beacon-Session` / `X-Beacon-Revision`.

`public/state-client.js` is the single shared family-state transport/cache. It orders mutation responses, GETs and SSE by process session/revision, ignores stale frames and confirms ambiguous session changes with a bounded fresh read. Do not add an independent polling loop or cache in each view. `app.js` renders Casework and emits page action notifications; `workspace.js` subscribes to the same ordered cache for People and Messages.

Hash routes are `#mayor`, `#messages`, `#people`, `#casework` and `#imagery`; historical aliases select Casework subsections or the trained model area. `records.js` derives conversation and people indexes from existing records. It preserves unassigned/orphan reports as reviewable messages, displays receipt versus observation times separately, and does not infer sightings from corrections, commands or an unaccepted proposal. Related-case welfare is not applied to the reporting participant.

## 7. Geographic map: independent datasets and render layers

The Houston map does not consume family messages as operational request locations. `src/houston.js` and `HoustonService` build a read-only fictional dataset over official geography. A future intake/geocoding/dispatch bridge would require its own reviewed contract; do not create one by joining names or approximate coordinates.

### Geometry, demand and planning fixtures

- `houston-city.json` is the official full-purpose city GeoJSON Feature in EPSG:4326. Preserve holes, islands and disconnected city areas.
- `houston-neighborhoods.json` has 88 clipped official Super Neighborhoods plus `houston-coverage-remainder` (89 regions). The remainder is a derived coverage area, not an official neighborhood. Zero-report land stays visible as unknown.
- `houston-demo-placements.json` contains explicit invented request/facility coordinates, stable region IDs and exact historical image/date references. The offline generator checks city/region/actual opaque NOAA pixels. Runtime invalid or unavailable positions stay unplaced; they are not randomized, clamped or replaced by centroids.
- Normal totals are 403 open requests: 300 supplies in Eldridge / West Oaks (SN17), 100 evacuation/supplies in Kingwood Area (SN43), 2 medical in Addicks Park Ten (SN09), and 1 unknown-location supplies request. There are 402 placed requests and 86 zero-report areas. Categories overlap: 401 supplies, 100 evacuation, 2 medical. Do not sum categories as unique requests.
- Six map facilities are explicit fictional, nonoperational planning points. They are not verified shelters or actual distribution/medical capacity.
- `map-model.js` conserves canonical request IDs and overlapping category counts when partitioning into 2×2 and 4×4 cells. Missing explicit points do not get browser-generated positions. Hospitality uses independent finest-level fixtures aggregated by clipped land area; known capacity, score coverage and mixed/unknown utilities retain their meaning at every zoom.

Red assistance uses a fixed 0–300 request legend across zoom and filters. Blue hospitality is a separate fictional planning mode, not a model inference or approved shelter assessment. Empty/unknown coverage is not safety. Area selection, camera gestures, keyboard shortcuts, generic fitting and fixture-specific unobscured fitting live in `public/houston.js` / `map-model.js`.

### Geographic imagery and references

| Bundled product | Metadata / data | Runtime code and limits |
| --- | --- | --- |
| Wide context and historical aerial | `houston-geography-meta.json`, local context images | NASA 2004 context and USGS/USDA historical reference imagery. Dates vary; not Harvey observations. |
| Progressive aerial pyramid | `houston-imagery-pyramid.json`, `houston-imagery-source.json`, `imagery/` | `imagery-model.js` chooses visible tiers; `imagery-layer.js` bounds local loading. 206 registered WebPs, about 22/11/5.6/2.8 m output sampling. Missing detail keeps coarser context. |
| Named streets and landmarks | `houston-streets.json`, `houston-landmarks.json`, `houston-labels-meta.json` | `labels-model.js` / `reference-layer.js`; real geographic references, no access or operating-status claim. |
| Sentinel-2 optical water signal / same-date true color | `houston-water-imagery.json`, `water/` | `historical-imagery.js` validates files; `historical-layer.js` keeps mode/date/load state. Aug15/Aug30/Sep1, 2017; 20 m analysis. |
| NOAA flood-date RGB | `houston-flood-imagery.json`, `flood-imagery/` | Five flight dates plus bounded details, including genuine ~0.5 m crops. Sparse no-data remains transparent; bbox alone is not coverage. |
| Sentinel-1 radar proxy | `houston-radar-imagery.json` and registered asset | NASA/JPL ARIA Aug29 probable-inundation proxy, 30 m. Unmarked pixels do not establish dry land. |
| Optical observation availability | `houston-observation-coverage.json` | `map-coverage.js` / `observation-view.js`; 16×16 pixel count blocks, view-local estimates with rigorous uncertainty bounds. |
| Amber before/after change | `houston-water-change.json` | `impact-model.js` / `impact-layer.js`; positive spectral difference over jointly observed pixels, not building damage. |

`historical-imagery.js` registers only validated local URLs with finite extents and existing files. Mode/date availability is per asset, including separate RGB and water products. Historical selection and source status must agree; an unavailable scene must clear old observations rather than leave an old image under a new date label. Context reference imagery can remain underneath without becoming evidence for the selected capture.

Image opacity, red/blue tile opacity and amber opacity are separate. Explicit fixture **View flood imagery** checks the exact associated NOAA asset and date, makes imagery visible and frames those fictional locations. Background readiness, source refresh or a coverage suggestion must not automatically change dates or pan the map. Manual navigation cancels explicit fixture fit intent. **Fit Houston** and **Most requests** are operator actions.

### Numeric water products and amber semantics

The Sentinel-2 analysis uses MNDWI `(B03 − B11) / (B03 + B11)` with source calibration and validity masks. The common EPSG:4326 display grid is 4600×3660 over `[-95.94,29.48,-94.99,30.14]`; native analysis is 20 m. A quantitative PNG sample of zero means no observation; otherwise index value is `(sample − 10001) / 10000`. Zero or negative **index values** are valid measurements. Do not analyze rendered WebP colors as numeric index data.

`houston-observation-coverage.json` summarizes the quantitative validity masks. The browser includes missing and outside-capture area in coverage feedback, rather than dividing only by observed cells. Available response-date alternatives require an explicit click and preserve the camera; the app never silently recommends a before-Harvey date as a response capture.

`houston-water-change.json` compares Aug15 with Aug30 or Sep1 on that registered grid. Sparse 64×64 pixel cells contain paired sample counts and integer delta sums. Missing cells mean no joint observation. The primary score is:

```text
raw mean positive change = sum(max(afterIndex − beforeIndex, 0)) / pairedPixels
display index change = 100 × raw mean positive change
```

The JSON stores delta units at 1e-4 index precision; divide `sumPositiveDeltaUnits` by `pairedPixels × 10000` before multiplying by 100 for display. Non-increasing observed pixels contribute zero; they remain in the denominator. Raw display scores can exceed 100; only the fixed amber color scale caps at **100+**. Use JavaScript Number/Float64 for global sums; legitimate totals exceed signed 32-bit range.

Joint valid coverage is about 12.13% of the bounded grid for Aug30 and 23.30% for Sep1, not the entire city or current viewport. Partial cells fade; sparse diagonal hatching means comparison unavailable. **View change example** ranks actual sufficiently observed cells by positive mean × coverage (minimum 50%), uses deterministic ties and changes the camera only. Its examples can be elsewhere in the genuine analysis extent; they do not relocate reports or change the selected comparison/basemap date.

Amber is labeled **water-signal increase**, never damage severity, an operational flood boundary, road passability or assistance need. The optional thresholded water-like counters in the source product do not determine the primary amber color. Red demand remains a separate layer above amber.

See [HOUSTON_DATA.md](HOUSTON_DATA.md) and [MAP_DEMO_PLACEMENTS.md](MAP_DEMO_PLACEMENTS.md) before regenerating data or changing source claims. Those documents and the JSON manifests retain source IDs, dates, calibration, hashes, attribution and limitations.

## 8. Trained building-image model: separate import and inference

The Kaggle model is distinct from hosted Nemotron. It is a from-scratch six-channel EfficientNet-B0 classifier of known building crops from aligned pre/post RGB imagery. It estimates visible building damage on historical xBD examples. It does not identify people, infer welfare, ingest resident ground photographs or locate assistance requests.

`training/` contains:

- `xbd_pipeline.py`: dataset pairing, building crops, split/augmentation/model helpers and evaluation contracts.
- `train_xbd.py`: standalone training entrypoint.
- `utd_xbd_from_scratch.ipynb`, `preflight_cell.py`, `training_cell.py`: reproducible private Kaggle workflow and checks.
- `infer_xbd.py`: repository-owned CPU inference implementation.
- `requirements-local.txt` and `tests/test_pipeline.py`: pinned local runtime dependencies and regression tests.

Model artifacts are **not part of a fresh Git checkout**. The optional release ZIP is linked from [README.md](../README.md). Import through `scripts/import_model.py`; do not extract arbitrary model code into the application or activate a checkpoint by filename alone.

```sh
uv venv --python python3.12 .venv
uv pip install --python .venv/bin/python --index-url https://pypi.org/simple -r training/requirements-local.txt
npm run test:training
npm run test:model-import
npm run import:model -- MODEL_ZIP --sha256 VERIFIED_BUNDLE_SHA256
```

Replace `MODEL_ZIP` with the locally downloaded trusted release archive and independently verify the published hash. The importer validates archive safety, required artifacts, internal checksums, class/model contract, cached test-only predictions and crop dimensions/probabilities. It copies reviewed weights/JSON/images into ignored `.data/models/<model-hash>/`, creates an application index and local verification record, then activates `.data/model-active.json`. It never executes Python from the archive. Reference answer labels are stripped from the public evidence contract. `--skip-inference` keeps live inference disabled even if cached estimates import successfully.

The reviewed release identifiers are:

| Artifact | SHA-256 |
| --- | --- |
| Release ZIP | `93a62ca7e895e29d51733a57bbe777837bfa27dfbea50d6b0e1b7248228dc1e4` |
| Model checkpoint | `78414e4f5076e02afcd65018ede5b78575b785df9398fce41301faac5c3fa329` |
| Bundle manifest | `b394563b13c794fd28ff08ec5faf72d2fda52f393f67b51ea8867bdf110b829d` |

`src/satellite.js` serves availability, provenance, metrics, known tile pairs and cached model estimates independently from family state. Missing/incomplete bundles return unavailable. Real `POST /api/satellite/infer` accepts only an existing `{tileId, buildingId}`, rechecks the verified checkpoint hash and invokes repository `training/infer_xbd.py` using `.venv/bin/python` with argument arrays, not a shell. It permits one in-flight job, two CPU threads, a 90-second timeout and bounded output. The API distinguishes cached estimates from `local_model_inference`.

The bundled xBD pairs provide pixel-space building boxes, **not a verified geographic placement contract**. Never plot those predictions on the Houston map by matching a study-area label or guessing coordinates. The archive slider and known-crop model panel are the honest presentation. Held-out macro-F1 is about 0.5154 with weak minor/destroyed classes and uncalibrated probabilities; see [MODEL_CARD.md](MODEL_CARD.md) for exact scores, attribution and dataset terms. The test split is tile-disjoint within one historical event, not a guarantee on unseen disasters or geographic regions.

## 9. Offline preparation and source maintenance

Normal browser/runtime operation reads bundled files and does not fetch external map providers. Preparation scripts may make public read-only source requests when deliberately run; do not run a generator merely to inspect current data. Preserve reviewed caches outside the repository/vault, source hashes and exact returned extents. Do not commit raw caches or model/dataset downloads.

| Preparation task | Scripts |
| --- | --- |
| Official city/region clipping | `prepare_houston_geography.py` |
| Wide historical context | `prepare_context_imagery.py` |
| Reference raster pyramid | `prepare_cached_imagery_pyramid.py`; earlier export path `prepare_imagery_pyramid.py` |
| Streets / landmarks | `prepare_houston_labels.py`, `check_houston_labels.py` |
| NOAA dated imagery / fine crops | `prepare_houston_flood_imagery.py` |
| Sentinel-2 calibrated water products | `prepare_harvey_water.py`, `check_harvey_water_sources.py` |
| Published radar product | `prepare_harvey_radar.py` |
| View-local observation counts | `prepare_observation_coverage.py` |
| Registered before/after change cells | `prepare_harvey_water_change.py` |
| Explicit fictional covered placements | `prepare_houston_demo_placements.py` |
| Trusted model import | `import_model.py` |

Preparation dependencies differ from the optional model runtime: geography uses Shapely; imagery/count checks use Pillow/NumPy; original optical reprojection also uses Rasterio and recorded source caches. Consult [HOUSTON_DATA.md](HOUSTON_DATA.md) for the exact existing source-check environment and flags. Do not add these Python requirements to the JavaScript runtime or imply that a normal demo startup needs them.

## 10. Validation and where to make a change

Required completion checks from the repository root:

```sh
npm run check
npm test
```

`check` syntax-checks JavaScript in `src`, `public`, `scripts` and `test`, and parses package metadata. `npm test` runs `node --test test/*.test.js`; provider tests use mocks/injected clients, not working credentials or paid services. Passing a mock transport test does not establish real provider authentication, inference quality or phone delivery.

Useful targeted suites:

| Change | Tests / verification |
| --- | --- |
| Family policies and task separation | `domain.test.js`, `reported-assistance.test.js`, `http.test.js` |
| Capture, jobs and human decisions | `report-inbox.test.js`, `report-review.test.js`, `report-review-http.test.js`, `nemotron-jobs.test.js` |
| Store/public state/SSE ordering | `store-events.test.js`, `public-state.test.js`, `state-stream.test.js`, `state-client.test.js` |
| Phone protocol/runtime/replies | `photon-client.test.js`, `photon-inbox.test.js`, `provider-ledger.test.js`, `nemotron-client.test.js`, `photon-replies.test.js`, `phone-runtime.test.js`, `phone-http.test.js`, `launcher-signals.test.js` |
| Local rehearsal | `demo-extractor.test.js`, `rehearsal.test.js`, `rehearsal-http.test.js` |
| People/Messages/drafts/focus | `records.test.js`, `record-focus.test.js`, `form-drafts.test.js`, `archive-view.test.js` plus real-browser keyboard/reading checks |
| Demand, fixtures, cameras and map interaction | `houston.test.js`, `houston-service.test.js`, `map-model.test.js`, `houston-camera.test.js`, `houston-interactions.test.js` |
| Raster lifecycle, labels and coverage | `imagery-model.test.js`, `historical-imagery.test.js`, `historical-layer.test.js`, `labels-model.test.js`, `map-coverage.test.js`, `impact-model.test.js`, `impact-layer.test.js` |
| Imported model / satellite service | `satellite.test.js`, `npm run test:training`, `npm run test:model-import`; actual checksum-verified CPU inference when that runtime is available |

For a focused Node run use `node --test test/NAME.test.js`. Node tests do not run Python suites. With the appropriate existing Python environment, use `npm run test:geography`, the model commands above, and documented offline asset checks. `test/test_imagery_pyramid.py` and `test/test_harvey_water_change.py` verify delivered raster/grid artifacts; source-reconstruction checks may require the preserved external cache. An unavailable source cache is not a reason to invent a passing provenance claim.

Editing guide:

- **Case/domain policy:** change `src/domain.js` or `src/report-inbox.js` at the correct boundary, add focused behavior tests, then update `docs/API.md` if the contract changes. Do not implement business effects in rendering code.
- **Provider behavior:** change protocol clients, journal/inbox/jobs/replies and `phone-runtime.js` as appropriate. Keep disabled defaults, explicit scope and durable caps. A new endpoint/model/channel/recipient/spend scope requires authorization, not just a code flag.
- **Phone/review UI:** use `phone-view.js`, `proposal-view.js` and `app.js`; preserve honest extractor labels and separate approve/send/delivery controls. Check focus and drafts during SSE, not just static screenshots.
- **Messages/People:** use pure `records.js` for indexing/search semantics and `workspace.js` for views. Preserve raw/unassigned reports, exact source links, time distinctions and reading continuity.
- **Map interactions:** use `public/houston.js` with pure helpers/tests in `map-model.js`. Preserve fixed legend scale, explicit coordinates, clipping, keyboard modifier behavior, free-pan intent and actual viewport fitting.
- **Map imagery/change:** use the corresponding model/layer pair plus validated server registry and manifest. Preserve per-file availability, exact acquisition dates, unknown masks and independent opacity/date controls. Do not derive evidence from reference mosaics.
- **Visual styling:** shared shell is `index.html` / `workspace.css`; original casework also uses `styles.css`. New modules need exact static routes. Prefer small DOM helpers in `ui.js`, not a new framework/build step.
- **Training/import:** update repository-owned `training/` or importer code and their Python tests. Do not patch a private installed checkpoint or hand-edit generated model verification to activate inference.

For a fresh-machine handoff, first run the zero-credential rehearsal and required Node checks. If optional image inference is part of the demonstration, import the trusted release and verify one actual CPU result separately. If live phone operation is in scope, use the approved private setup and record exactly which account-specific steps succeeded; do not reuse fixture or rehearsal results as live proof.

## 11. Non-negotiable boundaries for the next agent

1. Work only in this project's bubble and its own permitted documentation. Keep `.env`, ignored exercise/provider/model state, real contacts and external raw caches out of Git and shared notes.
2. Preserve simulated, reported, proposed, human-accepted and officer-verified states as distinct. Interpretation and delivery never establish welfare.
3. Human proposal acceptance does not send messages, create assistance automatically or resolve a case. Assistance tracking, welfare verification and provider replies are separate explicit actions.
4. The ordinary simulated outbox is not a live sending queue. Do not add an auto-dispatch loop or public webhook to make a demo appear connected.
5. Restart, duplicate, stale-source and ambiguous-send handling are part of the contract. Do not erase a ledger, regenerate event IDs or issue automatic retries to work around them.
6. Houston request/facility fixtures, hospitality scores, physical imagery and xBD predictions retain independent provenance. No-data is unknown; zero requests is not safety; a spectral increase is not building damage or a dispatch decision.
7. Paid provider calls, GPU/VM provisioning, new recipients or broader data collection need explicit approved scope. Existing keys/configuration are not open-ended permission.
8. Run the required checks, verify the affected user flow, update the owning docs with concrete evidence, and checkpoint only reviewed public source/assets. Follow the owner's final push/halt instruction rather than starting another improvement loop.

