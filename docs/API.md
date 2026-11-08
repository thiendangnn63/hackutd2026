# Demo API contract

All family reports and Houston requests are fictional; the geographic context and optional historical satellite model are real and separately attributed. The HTTP server binds only to 127.0.0.1. JSON errors use `{error: message}`. All successful family mutations return the full state plus action metadata (`caseId`, `duplicate`). Browser UI shares one versioned family-state client across Casework, People and Messages. It reads GET /api/state, accepts committed mutation responses, and subscribes to local GET /api/events updates.

State:
- `mode: 'simulation'`, `scenarioTime` ISO timestamp, `incident: {id,name,active,tiles:['A1','A2','B1','B2'],policy:{maxTiles:2,locationMaxAgeMinutes:120,maxRecipients:20}}`
- `participants: [{id,name,phone,currentTile,locationReportedAt,optedIn,source:'fixture'}]` (555 fictional numbers only)
- `cases: [{id,subjectNames,description,reporterId,lastKnownTile,lastContactAt,searchTiles,consentToOutreach,reviewState:'open'|'awaiting_review'|'follow_up_requested'|'resolved',locationState:'unknown'|'unverified_sighting'|'verified_location',welfareState:'unknown'|'confirmed_safe'|'assistance_needed',outreachState:'needs_review'|'ready'|'queued'|'stopped',createdAt,reportIds,verification:null|{officerName,note,evidenceIds,verifiedAt},policyReasons:[]}]`
- `reports: [{id,providerEventId,senderId,caseId,text,observedAt,receivedAt,processingState:'processed'|'needs_review',processingPath:'deterministic'|'simulated_extraction'|'failed'|'raw_inbox',observations:[{id,type:'sighting'|'self_check_in'|'water_need'|'road_blockage'|'correction'|'unknown',summary,sourceSpan,quantity:null|number,location:null|string,verification:'reported'}],reviewFlags:[]}]`
- `assistance: [{id,caseId,reportId,type,summary,status:'unassigned'|'completed'}]`
- `outbox: [{id,caseId,recipientId,kind:'inquiry'|'acknowledgment'|'family_update',text,status:'simulated',createdAt}]`
- `audit: [{id,at,action,detail}]`; `integrations:{photon:'not_connected',nemotron:'simulated',broadcast:'simulated'}`

Endpoints:
- POST /api/cases `{subjectNames,description,reporterId:'mom',lastKnownTile:'A1',lastContactAt:'2026-11-07T12:00:00Z',searchTiles:['A1'],consentToOutreach:true}`. Opens case; ready vs needs_review by policy. No automatic real messaging.
- POST /api/cases/:id/outreach `{}`. Selects fresh opted-in participants in search tiles, excluding reporter. Queues one simulated inquiry per case/recipient. Repeated calls do not duplicate. Needs review is blocked.
- POST /api/reports `{providerEventId, senderId:'neighbor-1',caseId,text,observedAt:'2026-11-07T14:20:00Z',simulateFailure:false}`. Preserves event, deduplicates IDs, deterministic STOP/CHECKIN or simulated extraction. Sighting never verifies safety. Family receives clearly unverified update. Need remains a separate task.
- POST /api/cases/:id/verify `{officerName:'Officer Rivera (demo)',evidenceIds:['R...'],note:'Direct fictional responder check-in completed.',welfare:'confirmed_safe'|'assistance_needed',resolve:true}`. Requires selected report evidence plus meaningful basis note. Demo officer role only. Stops inquiry outreach, keeps assistance open. Family update records outcome.
- POST /api/participants/:id/consent `{optedIn:false}`. Stops future inquiries.
- POST /api/reset `{}`. Resets fictional state, no external effects.

Seed: Mom (`mom`); eligible contributors `neighbor-1` in A1 and `neighbor-2` in A2. Other fixtures illustrate stale, opted-out, outside-area exclusions. Case `C104` (unanswered Elena Brooks case) remains open; grandparents flow creates C105. Subject demo names: Rosa and Miguel Santos. Example report: `I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.` Include observed timestamp separately. Corrections/negations enter review without asserting positive facts. The extractor is explicitly simulated, not a Nemotron call. Zero API calls or cost.

## Optional satellite model integration

This is a separate historical imagery panel. It never mutates family case state.

- GET /api/satellite: availability, model provenance, held-out metrics, attribution, demo tile pairs and building predictions. Building estimates use only model damage_class/probabilities; reference_label is intentionally stripped. Before import: available=false, no fabricated tiles/predictions.
- GET /api/satellite/images/:filename: PNG from the imported tile-pair allowlist only. No arbitrary file paths.
- POST /api/satellite/infer `{tileId,buildingId}`: real local CPU inference for one existing bundled crop. Requires successful checkpoint validation, same-origin request, unchanged model checksum, and at most one in-flight request. No shell command interpolation. Returns prediction with source=local_model_inference, estimated state, uncalibrated probabilities, duration and model hash. Cached outputs are source=cached_model_output.

## Houston mayor dashboard

Read-only and independent of persisted family state. Requests are generated fictional fixtures, not live SMS or model output.

- GET /api/houston?city=houston&scenario=normal: city boundary and bbox, attributed geography, local historical aerial basemap metadata, 89 region geometries, open counts, category counts, normalized intensities, review queue, individual urgent requests, unlocated requests, and stats. `scenario=empty` provides no-report coverage checks for every region. Other cities, scenarios, or query keys return 400.
- GET /data/houston-imagery.jpg: fixed local historical aerial asset. There is no arbitrary file or URL access.
- Missing or invalid geographic assets return `available:false` with a reason. Missing imagery keeps valid boundaries and requests available, while `basemap.available:false` and the UI make the absence explicit.

Region result: `{id,name,labelPoint,geometry,openCount,intensity,categories:{medical,evacuation,supplies,other},priority,coverageStatus,requestLocations}`. Each placed location has `{id,point:[longitude,latitude],categories,locationSource:'fictional-fixture',imageryId,imageryDate}`. `intensity=openCount/maxOpenCount`, or zero when no open requests exist. `coverageStatus` is `reported` or `unknown`, never safe. Category counts may overlap; request total counts each current open ID once. Latest valid version wins across city/status changes; resolved wins equal-time ties. Outside-Houston current records are excluded. Unknown region IDs remain visible in `unlocatedRequests` and total open requests, but not map counts.

Review queue orders reported demand medical → evacuation → supplies → other and reserves a coverage-check slot after each group of three reported areas. The interface gives no-report areas their own persistent coverage lane. This is a human-review demo preference, not medical triage, allocation, or dispatch. No HTTP mutation endpoints exist for these fixtures.

## Map workspace presentation

The map and imagery views consume GET /api/houston, GET /api/state and GET /api/satellite. The bounded messaging and model actions belong to Casework.

The backend exposes explicit, canonical fictional request coordinates and categories in each region’s `requestLocations`. The browser conserves those same request IDs/counts/categories when partitioning to 2×2 or 4×4 cells and clips visual cells to the official polygons including holes. Facilities use explicit region IDs and coordinates from the covered-location manifest. Hospitality scores, utility inputs, capacities, and POIs remain fictional planning fixtures, independent of satellite predictions and family welfare. They must be replaced with verified source data before any operational use.

Messages and People derive their indexes only from existing case/participant/report/outbox state. Conversation order uses receipt time for incoming reports and queue time for simulated outgoing messages, while still displaying observation times separately. Source text is inserted as text, never HTML. Committed local state arrives over a same-origin SSE stream as well as mutation responses, so these views update without a page reload or duplicate persistence.

The presentation index preserves messages whose case reference is null or no longer exists in an explicit unassigned review thread. Participant records show their own authored reports and addressed messages; a linked family's welfare verification is not applied to the participant. Explicit conversation links carry case context into the message lab.

Hospitality parent scores now aggregate the fixed finest-level fixtures using clipped land area. Known capacity sums across children; unknown inputs stay unknown, mixed utility states expose percentages, and partial coverage is labeled. These remain fictional planning values.

Client state refreshes use a process-session UUID and monotonically increasing Store revision so stale GETs, mutation responses and stream frames cannot supersede newer state. Native stream reconnects handle local server restarts; ambiguous session changes require one shared local confirmation read, without an automatic retry loop. Successful client actions emit family-action-complete after state rendering; Casework uses that explicit action outcome for navigation, without changing HTTP payloads or domain states. Participant outgoing-history selection uses recipient IDs directly, including unresolved case references.


## Geographic detail and historical raster reads

GET `/api/houston` now includes a validated `imageryPyramid`; GET `/api/houston/imagery` retrieves only that manifest for a bounded preparation refresh. `complete` requires every planned tile to exist with valid metadata; `downloading` is false in the completed bundled release. GET `/data/imagery/<manifest-listed .webp>` exposes only the registered local image. Invalid IDs, traversal, missing files and unlisted names return 404.

GET `/api/houston/history` returns separate `water`, `flood` and `radar` product metadata. Water scenes retain the actual acquisition date, 20 m analysis, paired same-date `waterUrl`/`rgbUrl`, quantitative `indexUrl`, validity fraction, source band calibration and masks. Availability is per file/mode; a missing RGB product cannot become a ready true-color image. Flood images retain NOAA flight dates and partial coverage; radar is NASA’s separate 30 m probable-inundation proxy. GET `/data/water/<registered product>` and `/data/flood-imagery/<registered product>` read only files registered by the validated fixed manifests. No arbitrary file, URL proxy, provider credential or remote request is accepted.

The three static geographic-reference JSONs expose named City streets, landmarks and their provenance. These and every historical read are independent of case persistence and do not update welfare, assistance, review or request assignment. Physical hazard imagery can extend beyond city limits; the current request aggregation contract remains Houston-only.


GET `/data/houston-observation-coverage.json` is a fixed local static read for optical observation availability. Schema1 uses EPSG:4326, `encoding:"observed-pixel-counts"`, `blockSize:16`, and dated scenes with bounds, analysis-grid dimensions, row-major block counts, total observed pixels and source-index hashes. The frontend compiles validated counts once and queries the visible extent with uncertainty bounds for partly intersected blocks. `/map-coverage.js` and `/observation-view.js` are exact static module routes. Suggestions use only available post-event dates and require an explicit click; they do not pan, classify water/flooding, or mutate case state.


## Local committed-state stream

GET `/api/events` sends native Server-Sent Events with `{sessionId,revision,state}` and event IDs `${sessionId}:${revision}`. A connection receives the current snapshot, then committed Store updates. The existing loopback Host/Origin guards apply before subscribing. Heartbeats keep idle connections alive; blocked connections retain only their newest pending state and eventually disconnect. Closing a connection removes its Store observer. Read/subscription/reconnect never rewrites the saved exercise.

GET `/api/state` and successful family mutation responses include `X-Beacon-Session` and `X-Beacon-Revision` headers. HTTP and stream snapshots share a public projection that removes provider identity and private extraction-job material. Raw reports expose only the review fields needed by the UI. Provider envelopes and credentials stay private. Proposal decisions and redacted phone actions are documented below.

## Phone controls and proposal review

The normal server exposes an offline status and returns 409 for phone actions. `npm run demo` injects the isolated rehearsal runtime. The optional `demo:phone` launcher injects the explicitly configured provider runtime. All mutations below require a same-origin POST with a JSON object. Successful actions return the projected exercise state and revision headers. Phone actions also return `phone` status and a redacted `phoneAction` result. [Operator guide](PHONE_DEMO.md)

| Route | Request and effect |
| --- | --- |
| GET `/api/phone/status` | Returns `mode` (offline, rehearsal, fixture or live-test), configuration flags, listening and sending eligibility, window end, model usage and limit, exact approved reply text, eligible local report IDs and redacted reply states. Runtime counters include captured, quarantined, queued, proposed and failed reports and poll usage. Configuration does not establish delivery. |
| POST `/api/phone/simulate` | Rehearsal only. Send `text` and an optional `scenario` (`message`, `correction`, `stop` or `duplicate`). Duplicate reuses the prior input and message ID. STOP requires the command text. A new eligible message is captured before local interpretation. |
| POST `/api/phone/listen` | `{}` starts bounded polling within the approved time window. Up to 10 polls per Listen and up to 20 per scope. |
| POST `/api/phone/stop` | `{}` stops the listener. The sender’s STOP command separately revokes outreach consent. |
| POST `/api/phone/poll` | `{}` checks inbound messages once. New eligible queued reports can consume a hosted model request after capture. |
| POST `/api/reports/:reportId/interpret` | `{}` requests interpretation for an eligible queued report, within the three-request model cap. |
| POST `/api/reports/:reportId/review` | Send `action` (`accept` or `dismiss`), `reviewerName`, `note` and `expectedProposalToken`. For acceptance, `observationIndices` selects a subset. Omitting it accepts all supported observations. The current source and token must match. An identical repeated decision is idempotent. |
| POST `/api/reports/:reportId/assistance` | Send `observationId`, `reviewerName` and `note`. The selected canonical, accepted, reported water need on a linked case creates one unassigned task. Returns `taskId`, `status`, `caseId`, `reportId`, `observationId` and `duplicate`. Repeating the action returns the existing task, including a matching legacy task. |
| POST `/api/reports/:reportId/reply/prepare` | `{}` approves the configured fixed wording against the captured parent. The server persists a reply key before any dispatch. |
| POST `/api/reports/:reportId/reply/send` | `{}` sends an approved reply. After an ambiguous attempt, `{"manualRetry":true}` explicitly retries the same key within the two-attempt cap. An accepted send has `delivered:false`. A known failure is terminal. |
| POST `/api/reports/:reportId/reply/delivery` | `{}` checks a previously accepted message with its recorded provider ID and channel. The journal permits up to four delivery checks. |

The rehearsal uses `extractorSource: "local_demo_rules"` and a simulated phone. It does not make provider requests. Its listen/poll controls cannot read a real inbox. Prepare, send and delivery report simulated outcomes. POST `/api/reset` with `{}` resets both the isolated rehearsal exercise and its transport journal. The normal saved exercise and live provider ledger are separate. The three-request hosted cap applies to the live phone launcher. Rehearsal has a separate local interpretation counter.

Incoming reports keep raw source text and may have no observation time. `modelReview` exposes status, validated proposal, token and decision as applicable. `observations` remains empty until the reviewer accepts selected facts as reported evidence. Dismissal retains the original. Commands bypass model inference. Exact STOP revokes consent and CHECKIN goes to enrollment review. Neither review nor provider delivery changes welfare, assistance or outreach.

Casework preserves in-progress intake/message/verification fields, selected evidence, text caret, proposal disclosure and reading position during background updates. Verification drafts are case-scoped. People and Messages retain their selected record and source-message focus.


## Covered-location map exercise

`public/data/houston-demo-placements.json` fixes the 300 supplies requests in Eldridge / West Oaks (SN17), 100 evacuation/supplies requests in Kingwood Area (SN43), and 2 medical requests in Addicks Park Ten (SN09). These invented locations and six nonoperational facilities fall within the official city/assigned region and bundled August 30–31 NOAA image footprints. The separate unknown-location request remains unplaced: 403 open total, 402 placed, 1 unknown. Category totals remain 401 supplies including the unknown request, 100 evacuation and 2 medical; categories overlap.

GET `/api/houston` includes top-level `facilities` and `fixturePlacement` metadata. Invalid explicit points remain unplaced instead of being clamped, rerandomized or replaced by region centroids. Missing/invalid preparation produces explicit location-review feedback while retaining real geometry and raw demand totals. Source imagery availability is checked independently from geographic context. The offline generator additionally validates every prepared point against actual opaque source pixels; see [covered planning locations](MAP_DEMO_PLACEMENTS.md).

Area/facility details offer **View flood imagery** only when the exact associated NOAA asset/date is available. Clicking selects that capture, makes imagery visible and frames the fictional locations; background loading never moves the camera. Historical imagery establishes context, rather than real reports, shelter suitability or current operational status.


## Per-case page drafts and responsive fixture focus

Casework’s page-only draft store keys verification and message values by case ID. It prunes obsolete verification drafts after a recorded verification/removal and clears on this tab’s acknowledged Reset. Message drafts reserve unused demo provider IDs across unsent cases, while an existing draft/retry retains its exact ID. Native selector changes use the form’s outgoing case context to save the previous message before loading the requested case. Ordinary case review never changes that message context. No new evidence or durable case state is created by draft memory.

Background rebuilds restore stable action/case-card focus and same-case field selection. A removed verification action falls back to its case heading. The shared state client still owns transport ordering; a successfully rendered SSE snapshot suppresses a later initial-GET error panel, and stream-constructor failure does not abort HTTP/control initialization. There is no new polling loop.

Explicit fixture fitting considers actual detail-card geometry rather than treating every compact layout as a bottom sheet. Resizing reapplies that explicit fit until manual navigation cancels it; arbitrary free-pan views retain their center. The fit helper and short-portrait CSS change no source coordinates, request counts, imagery dates or backend contracts.


## Historical water-signal change overlay

GET `/data/houston-water-change.json` returns a fixed EPSG:4326 comparison grid and provenance. Each 64 × 64 display-pixel cell summarizes only jointly observed pixels on the registered input grids. Comparisons use August 15, 2017 as the baseline and August 30 or September 1 as the after date. Cell score is 100 times the sum of positive MNDWI changes divided by all paired pixels, including the zero contribution from non-increases. The amber display caps at 100+. Partial coverage remains explicit; cells without paired samples are unknown. The geographic grid and source hashes are independent of the red assistance counts and local xBD classifier. There is no write endpoint for the overlay.
