# Demo API contract

All family reports and Houston requests are fictional; the geographic context and optional historical satellite model are real and separately attributed. The HTTP server binds only to 127.0.0.1. JSON errors use `{error: message}`. All successful family mutations return the full state plus action metadata (`caseId`, `duplicate`). Browser UI fetches GET /api/state initially then uses state in mutation responses.

State:
- `mode: 'simulation'`, `scenarioTime` ISO timestamp, `incident: {id,name,active,tiles:['A1','A2','B1','B2'],policy:{maxTiles:2,locationMaxAgeMinutes:120,maxRecipients:20}}`
- `participants: [{id,name,phone,currentTile,locationReportedAt,optedIn,source:'fixture'}]` (555 fictional numbers only)
- `cases: [{id,subjectNames,description,reporterId,lastKnownTile,lastContactAt,searchTiles,consentToOutreach,reviewState:'open'|'awaiting_review'|'follow_up_requested'|'resolved',locationState:'unknown'|'unverified_sighting'|'verified_location',welfareState:'unknown'|'confirmed_safe'|'assistance_needed',outreachState:'needs_review'|'ready'|'queued'|'stopped',createdAt,reportIds,verification:null|{officerName,note,evidenceIds,verifiedAt},policyReasons:[]}]`
- `reports: [{id,providerEventId,senderId,caseId,text,observedAt,receivedAt,processingState:'processed'|'needs_review',processingPath:'deterministic'|'simulated_extraction'|'failed',observations:[{id,type:'sighting'|'self_check_in'|'water_need'|'road_blockage'|'correction'|'unknown',summary,sourceSpan,quantity:null|number,location:null|string,verification:'reported'}],reviewFlags:[]}]`
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

Region result: `{id,name,labelPoint,geometry,openCount,intensity,categories:{medical,evacuation,supplies,other},priority,coverageStatus}`. `intensity=openCount/maxOpenCount`, or zero when no open requests exist. `coverageStatus` is `reported` or `unknown`, never safe. Category counts may overlap; request total counts each current open ID once. Latest valid version wins across city/status changes; resolved wins equal-time ties. Outside-Houston current records are excluded. Unknown region IDs remain visible in `unlocatedRequests` and total open requests, but not map counts.

Review queue orders reported demand medical → evacuation → supplies → other and reserves a coverage-check slot after each group of three reported areas. The interface gives no-report areas their own persistent coverage lane. This is a human-review demo preference, not medical triage, allocation, or dispatch. No HTTP mutation endpoints exist for these fixtures.

## Map workspace presentation

The redesigned browser consumes the existing GET /api/houston, GET /api/state and GET /api/satellite endpoints. No external map provider, new write API, messaging connection, or authentication claim is introduced.

The browser constructs deterministic fictional request coordinates within each region, conserves its request/category totals when partitioning to 2×2 or 4×4 cells, and clips visual cells to the official polygons including holes. Hospitality scores, utility inputs, capacities, and POIs are explicitly fictional client-side planning fixtures, independent of satellite predictions and family welfare. They must be replaced with verified source data before any operational use.

Messages and People derive their indexes only from existing case/participant/report/outbox state. Conversation order uses receipt time for incoming reports and queue time for simulated outgoing messages, while still displaying observation times separately. Source text is inserted as text, never HTML. Local mutation responses trigger a browser state-change event so these views update without persisting duplicate data.

The presentation index preserves messages whose case reference is null or no longer exists in an explicit unassigned review thread. Participant records show their own authored reports and addressed messages; a linked family's welfare verification is not applied to the participant. Explicit conversation links carry case context into the message lab.

Hospitality parent scores now aggregate the fixed finest-level fixtures using clipped land area. Known capacity sums across children; unknown inputs stay unknown, mixed utility states expose percentages, and partial coverage is labeled. These remain fictional planning values.

Client state refreshes are guarded by a local revision counter so an older GET cannot supersede a newer mutation response. Successful client actions emit family-action-complete after state rendering; Casework uses that explicit action outcome for navigation, without changing HTTP payloads or domain states. Participant outgoing-history selection uses recipient IDs directly, including unresolved case references.


## Geographic detail and historical raster reads

GET `/api/houston` now includes a validated `imageryPyramid`; GET `/api/houston/imagery` retrieves only that manifest for a bounded preparation refresh. `complete` requires every planned tile to exist with valid metadata; `downloading` is false in the completed bundled release. GET `/data/imagery/<manifest-listed .webp>` exposes only the registered local image. Invalid IDs, traversal, missing files and unlisted names return 404.

GET `/api/houston/history` returns separate `water`, `flood` and `radar` product metadata. Water scenes retain the actual acquisition date, 20 m analysis, paired same-date `waterUrl`/`rgbUrl`, quantitative `indexUrl`, validity fraction, source band calibration and masks. Availability is per file/mode; a missing RGB product cannot become a ready true-color image. Flood images retain NOAA flight dates and partial coverage; radar is NASA’s separate 30 m probable-inundation proxy. GET `/data/water/<registered product>` and `/data/flood-imagery/<registered product>` read only files registered by the validated fixed manifests. No arbitrary file, URL proxy, provider credential or remote request is accepted.

The three static geographic-reference JSONs expose named City streets, landmarks and their provenance. These and every historical read are independent of case persistence and do not update welfare, assistance, review or request assignment. Physical hazard imagery can extend beyond city limits; the current request aggregation contract remains Houston-only.
